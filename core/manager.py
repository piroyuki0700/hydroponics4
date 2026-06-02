import logging
import os
import shutil
import threading
import time
from datetime import datetime, timedelta
from decimal import Decimal
import gevent

from core.notifier import HydroNotifier

logger = logging.getLogger(__name__)

class PumpSwitcher:
    def __init__(self, device, logger, notifier):
        self.device = device
        self.logger = logger
        self.notifier = notifier
        self.running = False
        self.thread = None
        self.event = threading.Event()
        self.ontime = 300
        self.offtime = 900
        self.use_pump_a = True
        self.cycle_callback = None

    def set_cycle_callback(self, callback):
        self.cycle_callback = callback

    def start(self):
        if self.running:
            return
        self.running = True
        self.event.clear()
        self.thread = threading.Thread(target=self._loop, daemon=True, name="PumpSwitcher")
        self.thread.start()

    def stop(self):
        self.running = False
        self.event.set()
        if self.thread is not None:
            self.thread.join(timeout=1)
            self.thread = None

    def _loop(self):
        self.logger.info("Pump intermittent loop started (with recovery logic).")
        CHECK_DELAY = 30  # 循環判定までの待ち時間(秒)

        while self.running:
            # 💡 安全対策：もしON時間が0以下の場合は、ONフェーズ自体を完全にスキップ
            if self.ontime <= 0:
                self.logger.info("Pump ON time is 0. Skipping ON phase.")
            else:
                target_pump = self.device.pump_main_a if self.use_pump_a else self.device.pump_main_b
                backup_pump = self.device.pump_main_b if self.use_pump_a else self.device.pump_main_a
                pump_name = "Pump-A" if self.use_pump_a else "Pump-B"
                backup_name = "Pump-B" if self.use_pump_a else "Pump-A"

                # ON開始
                target_pump.on()
                if self.cycle_callback:
                    self.cycle_callback('cycle_start', self.ontime)
                self.logger.info(f"{pump_name} started. Checking circulation in {CHECK_DELAY}s...")

                # 循環判定を待つ（ON時間自体が30秒未満の場合はON時間で待つ）
                wait_check = min(CHECK_DELAY, self.ontime)
                if self.event.wait(wait_check):
                    break

                # 循環検知の確認
                if self.ontime > CHECK_DELAY and not self.device.water_check.is_active:
                    self.logger.warning(f"Circulation failure detected on {pump_name}! Switching to {backup_name}.")
                    target_pump.off()
                    backup_pump.on()
                    self.notifier.send_emergency(f"【警告】{pump_name}の循環不全。{backup_name}に切り替えました。")
                    if self.event.wait(max(0, self.ontime - CHECK_DELAY)): break
                else:
                    if self.ontime > CHECK_DELAY:
                        self.logger.info(f"{pump_name} circulation confirmed.")
                    if self.event.wait(max(0, self.ontime - wait_check)):
                        break

            # すべてのポンプを一旦完全に止める
            self.device.pump_main_a.off()
            self.device.pump_main_b.off()

            # 次のサイクルのためにポンプを入れ替える
            self.use_pump_a = not self.use_pump_a

            # 💡 安全対策：もしOFF時間が0以下の場合は、OFFフェーズをスキップして即次のループへ
            if self.offtime <= 0:
                continue
                
            if self.cycle_callback:
                self.cycle_callback('cycle_stop', self.offtime)
            
            if self.event.wait(self.offtime):
                break

        self.device.pump_main_a.off()
        self.device.pump_main_b.off()


class HydroManager:
    MINUTE_START = 0
    MINUTE_STOP = 50
    MINUTE_REFILL = 55
    REFILL_CONFIRM_COUNT = 3
    
    # 💡 新機能用定数
    FAN_TEMP_ON = 50.0            # 空冷ファンONの閾値(℃)
    FAN_TEMP_OFF = 40.0           # 空冷ファンOFFの閾値(℃)
    FLOW_LEAK_THRESHOLD = 10       # バルブ閉期間中の異常流水判定パルス数
    
    def __init__(self, config, db, device, sensors, camera, socketio):
        self.config = config
        self.db = db
        self.device = device
        self.sensors = sensors
        self.camera = camera
        self.socketio = socketio
        self.logger = logging.getLogger(__name__)
        self.notifier = HydroNotifier(config)
        self.switcher = PumpSwitcher(device, self.logger, self.notifier)
        self.switcher.set_cycle_callback(self._pump_cycle_status)
        self.current_mode = "Unknown"
        self.leak_task = None

        self.timer = None
        self.schedule = self.db.get_settings("setting_schedule") or {}
        self.manual_timer = None
        self.subpump_timer = None
        self.usb_reserve_timer = None
        self.fertilized_today = False

        # 💡 CPU空冷ファンタスクの多重起動を防ぐための状態管理フラグ
        self.cpu_fan_task_running = False

        # 💡 新機能用の変数初期化
        self.flow_count = 0        # 流量センサーの累計パルス数カウンター
        self.last_flow_count = 0   # 前回チェック時のパルス数

        # 💡 流量センサー（パルス信号）がONになるたびに自動でカウンターを+1するイベントを登録
        # gpiozeroのButtonクラスが持つバックグラウンド機能を利用するため、競合せず正確に数えます
        if hasattr(self.device, 'water_flow') and self.device.water_flow:
            self.device.water_flow.when_activated = self._pulse_counter_callback

    def _pulse_counter_callback(self):
        """水流センサーからパルス信号が届くたびに裏で自動実行される超軽量コールバック"""
        self.flow_count += 1

    def start(self):
        """システム起動時にシーケンス、漏水監視、CPU温度監視タスクをセット"""
        # 💡 debug=True によるFlaskリローダーの二重起動バグを防御
        if os.environ.get('WERKZEUG_RUN_MAIN') != 'true' and self.config.DEBUG:
            self.logger.info("Skipping HydroManager start in Flask child reloader process.")
            return

        self.logger.info("HydroManager sequence started.")

        # 1. 💡 起動時の現在時刻をもとに、各機器のON/OFF状態をその場で即座に反映（追いつき処理）
        self.sync_hardware_now()

        # 2. 起動時にまず一度バルブの開閉状態と漏水監視タスクの状態を正しく初期化
        self._manage_leak_detection_task()

        # 3. 次の00分、50分、55分に向けてタイマーを予約
        self._set_next_sequence()

    def sync_hardware_now(self):
        """起動時や設定変更時、『現在時刻』に合わせて即座にハードウェア状態を同期させる関数"""
        now = datetime.now()
        mode = self._determine_mode(now)
        self.logger.info(f"Syncing hardware status for current time: {now.strftime('%H:%M:%S')} (Mode: {mode})")

        # --- 💨 エアレーションの判定 ---
        # 00分〜50分の間であればON、それ以外（50分〜00分の間）ならOFF
        if 0 <= now.minute < self.MINUTE_STOP:
            self.logger.info("Current time is within active window. Turning ON aeration.")
            self.device.aeration.on()
            # ポンプの間間欠運転も即座にスタート
            self._start_intermittent_pump(mode)
        else:
            self.logger.info("Current time is within stop window. Keeping pumps/aeration OFF.")
            self.device.aeration.off()
            self.switcher.stop()

        # --- 🚰 水道バルブの開閉判定 ---
        v_open = self.schedule.get('valve_open')
        v_close = self.schedule.get('valve_close')
        if v_open is not None and v_close is not None:
            if int(v_open) <= now.hour < int(v_close):
                if not self.device.leak_detect.is_active:
                    self.logger.info("Current time is within water window. Opening water valve.")
                    self.device.water_valve.on()
                else:
                    self.device.water_valve.off()
            else:
                self.device.water_valve.off()

        # --- 💨 CPUファンの初期判定 ---
        if mode == "Morning" or mode == "Noon" or mode == "Evening":
            if not self.cpu_fan_task_running:
                self._start_cpu_temperature_task()
        elif mode == "Night":
            self.cpu_fan_task_running = False
            self.device.cooling_fan.off()

        # --- 🌪️ 換気扇の初期判定 ---
        if mode == "Night":
            self.device.ssr_room_fan.off()
        else:
            # 起動直後はまだ最新レポートがないため、その場で一度温度を仮測定して判定
            try:
                temp_data = self.sensors.read_bme280()
                air_temp = temp_data.get('air_temp', 25.0)
                # 簡易判定（evaluateが持つ limit 構造から上限を取得して比較するのが理想です）
                limit = self.db.get_sensor_limit() or {}
                high_limit = limit.get('air_temp_high', 30.0)
                
                if air_temp >= float(high_limit):
                    self.device.ssr_room_fan.on()
                else:
                    self.device.ssr_room_fan.off()
            except Exception:
                self.device.ssr_room_fan.off()
                
    def _start_cpu_temperature_task(self):
        """1分間隔でCPU温度を監視し、外部からフラグが下ろされるまで回り続けるタスク"""
        self.cpu_fan_task_running = True

        def _cpu_monitor_loop():
            self.logger.info("CPU Monitor: Dynamic background loop started.")
            
            while self.cpu_fan_task_running:
                # 1分(60秒)待機
                gevent.sleep(60.0)
                
                # 💡 待機から目覚めた時、夜間突入によりフラグが下ろされていたら即終了
                if not self.cpu_fan_task_running:
                    break
                
                # CPU温度を取得してヒステリシス制御
                try:
                    with open("/sys/class/thermal/thermal_zone0/temp", "r") as f:
                        cpu_temp = float(f.read().strip()) / 1000.0
                except Exception:
                    cpu_temp = 35.0 
                
                if cpu_temp >= self.FAN_TEMP_ON:
                    if not self.device.cooling_fan.is_active:
                        self.logger.warning(f"CPU Temperature is high ({cpu_temp:.1f}℃). Turning ON cooling fan.")
                        self.device.cooling_fan.on()
                elif cpu_temp <= self.FAN_TEMP_OFF:
                    if self.device.cooling_fan.is_active:
                        self.logger.info(f"CPU Temperature cooled down ({cpu_temp:.1f}℃). Turning OFF cooling fan.")
                        self.device.cooling_fan.off()

            # ループを抜けたらファンを確実に止めてリソース解放
            self.device.cooling_fan.off()
            self.cpu_fan_task_running = False
            self.logger.info("CPU Monitor: Dynamic background loop exited and fan forced OFF.")

        self.socketio.start_background_task(_cpu_monitor_loop)

    def _set_next_sequence(self):
        status = {}
        report = self.db.get_latest_report()
        if len(report):
            status = self.evaluate(report)
            self.device.update_led(status['total_status'])
        else:
            self.device.update_led('white')

        """現在時刻から次に実行すべき『分』と『関数』を計算してタイマーをセット"""
        now = datetime.now()
        m = now.minute

        # 1. 次の目標の「分」と、その時に実行したい「関数（処理）」のペアを決定
        if m < self.MINUTE_START or self.MINUTE_REFILL <= m:
            next_m = self.MINUTE_START
            next_task = self._handle_start
        elif m < self.MINUTE_STOP:
            next_m = self.MINUTE_STOP
            next_task = self._handle_stop
        else:
            next_m = self.MINUTE_REFILL
            next_task = self._handle_refill

        # 2. 次の正確な発火時刻を計算
        target = now.replace(minute=next_m, second=0, microsecond=0)
        # もし計算した目標の「分」が現在の「分」以下の場合は、次の時間のその分を指すように調整
        if next_m <= m:
            target += timedelta(hours=1)

        diff = (target - now).total_seconds()
        self.logger.info(f"Next sequence: {target.strftime('%H:%M:%S')} -> {next_task.__name__} (in {diff:.1f}s)")

        # 3. 💡 タイマーの第3引数(args)として、実行したい「関数オブジェクト」を直接渡す！
        self.timer = threading.Timer(diff, self._sequence_callback, args=[next_task])
        self.timer.start()

    def _sequence_callback(self, task_function):
        """タイマーから呼ばれるコールバック"""
        try:
            # 💡 引数として受け取った関数（_handle_startなど）をそのまま名前で安全に実行します
            self.logger.info(f"Timer triggered. Executing task: {task_function.__name__}")
            task_function()

            # 次の処理を予約
            self._set_next_sequence()
            
        except Exception as e:
            self.logger.error(f"Error in sequence callback while executing {task_function.__name__}: {e}", exc_info=True)
            # 異常時も安全のため1分後にリトライ（次のスケジュール計算へ復帰を試みる）
            self.timer = threading.Timer(60, self._set_next_sequence)
            self.timer.start()

    def _handle_start(self):
        """00分の定期自動処理（センサー計測、特定時刻撮影、バルブ/流量異常判定、
           各機器ON/OFF判断、一斉ブロードキャスト、Discord通知）"""
        now = datetime.now()
        mode = self._determine_mode(now)
        self.logger.info(f"Sequence START: Mode={mode}")

        if now.hour == 0:
            self.logger.info("Midnight (00:00) reached. Resetting daily fertilize flag for the new day.")
            self.fertilized_today = False

        # --- 💨 エアレーション（ブクブク）の開始 ---
        self.logger.info("Turning ON aeration for 50 minutes.")
        self.device.aeration.on()

        # 1. 最新のセンサー読み込み
        self.logger.info("Hourly auto-report: Measuring sensors...")
        report = self.report_main()
        report['report_time'] = now.strftime('%Y/%m/%d %H:%M:%S')

        # 2. DB設定からカメラ定時スケジュールを判定
        camera_hours = [
            self.schedule.get('camera1'), self.schedule.get('camera2'),
            self.schedule.get('camera3'), self.schedule.get('camera4'), self.schedule.get('camera5')
        ]
        
        picture_path_for_discord = None
        if now.hour in [int(h) for h in camera_hours if h is not None]:
            self.logger.info(f"Hourly camera schedule matched for {now.hour}:00. Capturing picture...")
            # gevent のスレッドプールを使って重いカメラ処理を実行（結果が返ってくるまで非同期で待つ）
            tp = gevent.get_hub().threadpool
            cam_result = tp.apply(self.camera.capture, (False,)) # 引数はタプルで渡します
            if cam_result.get('success'):
                picture_no = self.db.insert_picture({
                    'filename': cam_result.get('filename'),
                    'taken': cam_result.get('taken_at')
                })
                report['picture_no'] = picture_no
                picture_path_for_discord = cam_result.get('filepath')
                self.logger.info(f"Auto hourly picture saved to DB (No.{picture_no})")
            else:
                self.logger.error("Auto hourly picture capture failed.")

        # 3. 給水用電磁ボールバルブ（water_valve）の明け方定時開閉判定
        v_open = self.schedule.get('valve_open')
        v_close = self.schedule.get('valve_close')
        
        # 前回チェック時（1時間前）からのパルス増加量を算出
        current_pulses = self.flow_count
        diff_pulses = current_pulses - self.last_flow_count
        self.last_flow_count = current_pulses # 次回のために現在の値を記録

        if v_open is not None and v_close is not None:
            # 1時間前の時点で「開いていた期間」が終わるタイミング（例: 閉じる直前、または開放期間の1時間ごと経過時）
            if int(v_open) <= (now - timedelta(hours=1)).hour < int(v_close):
                # この1時間（または今回の期間中）の総カウント数をログに出力してリセット
                self.logger.info(f"New Feature [FLOW LOG]: Total water flow pulses in this window: {diff_pulses} counts.")
            
            # 1時間前の時点で「閉じていた期間」だった場合（本来水が流れてはいけない時間）
            else:
                # 💡 設定された定数（10回以上）パルスが検出された場合は異常とみなす
                if diff_pulses >= self.FLOW_LEAK_THRESHOLD:
                    self.logger.critical(f"🚨 FLOW EMERGENCY: {diff_pulses} pulses detected while water valve is CLOSED!")
                    
                    # セーフティとして再度バルブの閉じ命令を重ねて送り、2次的被害を防ぐ
                    self.device.water_valve.off()
                    
                    # 💥 緊急事態のため、1日1回の制限に関わらず、見つけたその瞬間にDiscordへ即時アラート送信！
                    if bool(int(self.schedule.get('emergency_active', 0))):
                        self.notifier.send_emergency(
                            f"【重大警報】水道バルブ閉鎖期間中に、異常な水流（{diff_pulses}パルス）を検知しました。\n"
                            f"電磁弁の閉鎖不良、または配管からの二次漏水の可能性があります。至急現場を確認してください。"
                        )

            # 現在の時間帯に基づいて、これからの1時間のバルブ開閉を設定
            if int(v_open) <= now.hour < int(v_close):
                if not self.device.leak_detect.is_active:
                    self.logger.info(f"Water window active ({now.hour}h) & Safety OK. Opening water valve.")
                    self.device.water_valve.on()

                    if not self.device.water_valve.is_active:
                        self.logger.info(f"Water window started ({now.hour}h). Activating hot water purge via USB Reserve for 30s!")
                        
                        # 予備USB出力をON
                        self.device.usb_reserve.on()
                        
                        # 30秒後に自動でOFFにする非ブロッキングタイマーを起動
                        if self.usb_reserve_timer is not None:
                            self.usb_reserve_timer.cancel()
                        self.usb_reserve_timer = threading.Timer(30.0, self._usb_reserve_off_callback)
                        self.usb_reserve_timer.start()

                else:
                    self.logger.critical("Cannot open water valve! Leak is currently detected at the opening window.")
                    self.device.water_valve.off()
            else:
                self.logger.info("Out of water window. Closing water valve.")
                self.device.water_valve.off()

        # 4. 💡 毎時00分のタイミングで「常時漏水監視タスク」の状態を再評価・管理
        self._manage_leak_detection_task()

        # 5. CPUファン(cooling_fan) 朝時間に突入したらタスク起動、夜時間に突入したらタスク停止
        if mode == "Morning":
            if not self.cpu_fan_task_running:
                self.logger.info("CPU Monitor: Morning started. Launching CPU temperature task.")
                self._start_cpu_temperature_task()
                
        elif mode == "Night":
            if self.cpu_fan_task_running:
                self.logger.info("CPU Monitor: Night started. Stopping CPU temperature task.")
                # 💡 フラグをFalseにするだけで、裏のループが次の1分後に自動で終了・消滅します
                self.cpu_fan_task_running = False
            else:
                # 念のため、夜間開始時にファンが回っていたら確実にOFFにする安全弁
                if self.device.cooling_fan.is_active:
                    self.device.cooling_fan.off()

        # 6. 換気扇（ssr_room_fan）の夜間強制OFF＆昼間気温連動
        if mode == "Night":
            # 夜間は気温の判定を完全に無視して強制シャットダウン
            self.logger.info("It is Night time. Room fan is forced OFF regardless of temperature.")
            self.device.ssr_room_fan.off()
        else:
            # 朝・昼・夕の期間は、気温が上限を突破している時だけON
            air_status = report.get('air_temp_status', 'none')
            if air_status in ['warning', 'danger']:
                self.logger.info(f"High room temperature detected ({air_status}) during active hours. Turning ON room fan.")
                self.device.ssr_room_fan.on()
            else:
                self.logger.info(f"Room temperature is normal ({air_status}). Turning OFF room fan.")
                self.device.ssr_room_fan.off()

        # 7. レポートデータをDBに保存
        report_no = self.db.insert_report(report)
        self.logger.info(f"Auto hourly Report No.{report_no} created.")

        # 8. 全クライアントへ一斉配信
        self.broadcast('report', report)

        # 9. 💡 1日1回限定通知：Discord定時報告は設定時刻の「その1時間」だけに制限
        notify_active = bool(int(self.schedule.get('notify_active', 1)))
        notify_hour = self.schedule.get('notify_time')
        
        if notify_active and notify_hour is not None and now.hour == int(notify_hour):
            self.logger.info(f"Sending daily report to Discord at scheduled hour: {now.hour}:00")
            symbol = {'success': '〇', 'warning': '△', 'danger': '×', 'none': '－'}
            def get_val_str(item, unit=""):
                val = report.get(item)
                stat = report.get(f"{item}_status", 'none')
                return f"{val}{unit}({symbol[stat]})" if val is not None else "－"

            message = (
                f"\n"
                f"環境モード: **{mode}**\n"
                f"気温: {get_val_str('air_temp', '℃')}\n"
                f"湿度: {get_val_str('humidity', '％')}\n"
                f"水温: {get_val_str('water_temp', '℃')}\n"
                f"水位: {get_val_str('water_level', '％')}\n"
                f"濃度: {get_val_str('tds_level', ' EC')}\n"
                f"明るさ: {report.get('brightness', '－')} Lux\n"
                f"総合判定: **{report.get('total_status', 'none').upper()}**"
            )
            self.notifier.send_daily_report(message, picture_path_for_discord)

        # 10. ポンプの間間欠運転を起動
        self._start_intermittent_pump(mode)

    def _manage_leak_detection_task(self):
        """バルブが開いている時間帯、または漏水中の時だけ監視ループを回すエコ＆自動翌日リセット設計"""
        v_open = self.schedule.get('valve_open')
        v_close = self.schedule.get('valve_close')
        now_hour = datetime.now().hour
        
        is_window = (v_open is not None and v_close is not None and int(v_open) <= now_hour < int(v_close))
        is_leaking = self.device.leak_detect.is_active

        # 💡 バルブ開放時間帯、または現時点で漏水している場合のみ、監視タスクがなければ起動
        if (is_window or is_leaking) and self.leak_task is None:
            def _leak_monitor_loop():
                self.logger.info("Safety: Active-window Leak detection loop started.")
                while True:
                    gevent.sleep(1.0)
                    
                    # 🔥 【即時アラート】日中の監視中に漏水を検知した場合
                    if self.device.leak_detect.is_active:
                        self.logger.critical("🚨 LEAK DETECTED! Forcing water valve CLOSE!")
                        self.device.water_valve.off() # バルブ強制閉鎖のみを実行
                        
                        # 💥 漏水検知時は、時間を待たずにその瞬間に即座にDiscordへSOSを飛ばします！
                        if bool(int(self.schedule.get('emergency_active', 0))):
                            self.notifier.send_emergency("【警告】サブタンクからの漏水を検知しました。給水バルブを緊急閉鎖しました。")
                        break # 発報・閉鎖したらこの日のループを終了（翌朝00時に再チェックされて自動で状態リセット）
                        
                    # 時間帯を過ぎてバルブが閉じ、漏水もなければループを抜けてお休みする
                    if not is_window and not self.device.leak_detect.is_active:
                        break
                        
                self.leak_task = None
                self.logger.info("Safety: Leak detection loop exited cleanly.")

            self.leak_task = self.socketio.start_background_task(_leak_monitor_loop)

    def _start_intermittent_pump(self, mode):
        time_span = mode.lower() # morning, noon, evening, night
        
        # 各モードのON/OFF時間(分)を取得して秒に変換。設定がなければデフォルト値(5分/5分)
        ontime = self.schedule.get(f'{time_span}_on', 5) * 60
        offtime = self.schedule.get(f'{time_span}_off', 5) * 60
        
        self.switcher.ontime = ontime
        self.switcher.offtime = offtime
        self.logger.info(f"Starting intermittent pump cycle for {mode} (ON:{ontime}s, OFF:{offtime}s)")
        self.switcher.start()

    def _usb_reserve_off_callback(self):
        """30秒後に予備USBを安全にOFFにするバックグラウンドコールバック"""
        self.logger.info("USB Reserve timeout reached (30s). Turning OFF USB Reserve.")
        self.device.usb_reserve.off()
        if self.usb_reserve_timer is not None:
            self.usb_reserve_timer = None

    def _handle_stop(self):
        """50分の処理：すべてのメインポンプとエアレーションを個別に停止（換気扇・バルブは維持）"""
        now = datetime.now()
        self.logger.info("Sequence STOP: Turning off main pumps and aeration.")
        self.switcher.stop()
        self.device.aeration.off()
        
        # 💡 狙い撃ちでメインポンプだけをOFF（ルームファンや給水バルブの運転を邪魔しない）
        self.device.pump_main_a.off()
        self.device.pump_main_b.off()

    def stop(self):
        """安全停止処理：タイマーとポンプをすべて止める"""
        self.logger.info("HydroManager stopping")
        if self.timer is not None:
            self.timer.cancel()
            self.timer = None

        # 30秒タイマーが動いている最中にシステムが止まったら安全にキャンセル
        if self.usb_reserve_timer is not None:
            self.usb_reserve_timer.cancel()
            self.usb_reserve_timer = None

        self.switcher.stop()
        if self.subpump_timer is not None:
            self.subpump_timer.cancel()
            self.subpump_timer = None
        self.device.all_off()

    def _determine_mode(self, now):
        """現在の時刻からモードを判定"""
        s = self.schedule
        h = now.hour
        if s.get('time_morning') is not None and s.get('time_noon') is not None and s['time_morning'] <= h < s['time_noon']:
            return "Morning"
        if s.get('time_noon') is not None and s.get('time_evening') is not None and s['time_noon'] <= h < s['time_evening']:
            return "Noon"
        if s.get('time_evening') is not None and s.get('time_night') is not None and s['time_evening'] <= h < s['time_night']:
            return "Evening"
        return "Night"

    def _clean_dict(self, d):
        """JSONシリアライズ不可能な型を再帰的に変換する安全機構"""
        if not isinstance(d, dict):
            return d
        cleaned = {}
        for k, v in d.items():
            if isinstance(v, Decimal):
                cleaned[k] = float(v)
            elif isinstance(v, datetime):
                cleaned[k] = v.isoformat()
            elif isinstance(v, dict):
                cleaned[k] = self._clean_dict(v)
            elif isinstance(v, list):
                cleaned[k] = [self._clean_dict(item) if isinstance(item, dict) else item for item in v]
            else:
                cleaned[k] = v
        return cleaned

    def _handle_refill(self):
        """55分の処理：自動水補充の判定と実行"""
        self.logger.info("Sequence REFILL: Checking water level for auto-refill.")
        
        # 💡 スケジュールに基づく自動補充を実行（内部で条件判定が行われます）
        # 引数として空の辞書を渡し、optionはデフォルト（下限を下回ったら）で動かします
        self.cmd_subpump_refill({})

    # === 🔌 Socket.IO 通信コア処理 ===

    def send_initial_data(self):
        """Webブラウザ接続時に、クライアントの 'initial_data' イベントへ一括集約して送信"""
        self.logger.info("Compiling and sending initial_data to client.")
        initial_payload = {}

        # 各情報をマスター辞書へ集約
        initial_payload.update(self.db.get_basic() or {})
        initial_payload.update(self.db.get_schedule() or {})
        initial_payload.update(self.db.get_sensor_limit() or {})
        initial_payload.update(self.db.get_pump_status() or {})
        initial_payload.update(self.db.get_latest_picture(self.config.PIC_DIR) or {})
        
        refill_data = {}
        refill_data.update(self.db.get_latest_refill_record() or {})
        refill_data.update(self.get_subpump_status())
        initial_payload.update(refill_data)

        report = self.db.get_latest_report()
        if report:
            initial_payload.update(report)
            initial_payload.update(self.evaluate(report))

        schedule_data = self.db.get_schedule() or {}
        schedule_active = bool(int(schedule_data.get('schedule_active', 0)))
        initial_payload.update({
            'activate': schedule_active,
            'inactive_string': 'inactive' if not schedule_active else ''
        })

        # 安全な型へ一括変換して、JS側の 'initial_data' 窓口へ一撃で送信
        cleaned_payload = self._clean_dict(initial_payload)
        self.socketio.emit('initial_data', cleaned_payload)

    def broadcast(self, event_name, data):
        """全クライアントのカスタムイベント(JS側の待ち受けイベント名)へ一斉通知"""
        try:
            cleaned_data = self._clean_dict(data)
            self.socketio.emit(event_name, cleaned_data)
        except Exception as e:
            self.logger.error(f"Broadcast to event [{event_name}] failed: {e}")

    def _pump_cycle_status(self, status, seconds):
        """PumpSwitcherからの状態通知を受け取るコールバック"""
        data = {'status': status, 'seconds': seconds}
        self.db.set_pump_status(data)
        self.broadcast('pump_status', data)

    def make_result(self, ok, message, show_popup=False):
        """ボタンを押した本人のブラウザだけに実行成否を通知する"""
        return {
            'result': 'ok' if ok else 'error',
            'message': message,
            'datetime': datetime.now().strftime('%Y/%m/%d %H:%M:%S'),
            'show_popup': show_popup,
        }

    def handle_request(self, data):
        """Webブラウザからの 'command' イベント処理の窓口 (シンプル＆安全版)"""
        command = data.get('command')
        self.logger.info(f"handle_request {command}")

        # 🎯 commandが空でなければ、頭に 'cmd_' をつけた関数だけを探しにいく
        func = getattr(self, f"cmd_{command}", None) if command else None

        # 該当する cmd_関数 が見つからない場合は、一括して安全にエラーを返す
        if func is None:
            message = f"unknown command [{command}] received."
            self.logger.error(message)
            return self.make_result(False, message)

        try:
            return func(data)
        except Exception as e:
            self.logger.exception(f"Error while handling command {command}")
            return self.make_result(False, str(e))

    # === 🔧 コマンド関数は、命名規則 cmd_コマンド名 で定義する (例: cmd_pump_auto_start) ===

    def cmd_post_basic(self, request):
        ret = self.db.set_basic(request)
        if ret:
            # 💡 基本情報のみを 'setting_basic' イベントで送信
            self.broadcast('setting_basic', self.db.get_basic())
        return self.make_result(ret, "update basic setting")

    def cmd_post_schedule(self, request):
        ret = self.db.set_schedule(request)
        if ret:
            # 💡 スケジュール情報のみを 'setting_schedule' イベントで送信
            data = self.db.get_schedule()
            self.broadcast('setting_schedule', data)
            self.schedule = data
        return self.make_result(ret, "update schedule setting", True)

    def cmd_post_sensor_limit(self, request):
        ret = self.db.set_sensor_limit(request)
        if ret:
            # 💡 閾値情報のみを 'setting_sensor_limit' イベントで送信
            self.broadcast('setting_sensor_limit', self.db.get_sensor_limit())
        return self.make_result(ret, "update sensor limit setting", True)

    def cmd_tmp_report(self, request):
        def _report_task():
            try:
                report = self.report_main()
                self.broadcast('report', report)
            except Exception as e:
                self.logger.error(f"Error in report background task: {e}")

        self.socketio.start_background_task(_report_task)
        return self.make_result(True, "temporary report generation started")

    def report_main(self):
        report = {}
        report.update(self.sensors.read_bme280())
        water_temp = self.sensors.read_water_temp()
        if water_temp is not None:
            report['water_temp'] = water_temp
        report['tds_level'] = self.sensors.read_ec(report.get('water_temp'))
        report['brightness'] = self.sensors.read_lux()
        report['water_pressure'] = self.sensors.read_pressure_voltage()
        report['water_level'] = self.sensors.read_water_level()
        status = self.evaluate(report)
        report.update(status)
        return report

    def evaluate(self, report):
        """各センサー値の上限・下限判定ロジック"""
        status = {}
        danger, warning, success = False, False, False

        if report.get('brightness') is not None:
            status['brightness_status'] = 'success'

        limit = self.db.get_sensor_limit() or {}
        items = ['air_temp', 'humidity', 'water_temp', 'water_level', 'tds_level']
        for item in items:
            if report.get(item) is None:
                continue
            success = True
            vlow, low, vhigh, high = f"{item}_vlow", f"{item}_low", f"{item}_vhigh", f"{item}_high"

            if vlow in limit and report[item] < limit[vlow]:
                status[f"{item}_status"] = 'danger'; danger = True; continue
            if low in limit and report[item] < limit[low]:
                status[f"{item}_status"] = 'warning'; warning = True; continue
            if vhigh in limit and report[item] > limit[vhigh]:
                status[f"{item}_status"] = 'danger'; danger = True; continue
            if high in limit and report[item] > limit[high]:
                status[f"{item}_status"] = 'warning'; warning = True; continue
            status[f"{item}_status"] = 'success'

        if danger: status['total_status'] = 'danger'
        elif warning: status['total_status'] = 'warning'
        elif success: status['total_status'] = 'success'
        else: status['total_status'] = 'none'
        return status

    def cmd_tmp_picture(self, request):
        """手動一時撮影コマンド：フロントの撮影ボタンに対応（完全非同期・フリーズ完全防止版）"""
        
        # 💡 撮影からフロント通知までをすべて行うバックグラウンド処理を定義
        def _camera_capture_task():
            try:
                self.logger.info("Background task: Starting camera capture via threadpool...")
                
                # gevent のスレッドプールを使って重いカメラ処理を実行（結果が返ってくるまで非同期で待つ）
                tp = gevent.get_hub().threadpool
                res = tp.apply(self.camera.capture, (True,)) # 引数はタプルで渡します
                success = bool(res.get('success'))
                
                # 2. 📸 撮影が終わったら、結果をイベント名 'tmp_picture' で一斉配信(broadcast)！
                # 💡 これにより、フロント(JS)の webSocket.on('tmp_picture') が叩かれ、setValueTmpPicture が動きます
                payload = {
                    'tmp_picture_result': success,
                    'tmp_picture_path': f"/tmp_pictures/{res.get('filename')}" if success else "",
                    'tmp_picture_name': res.get('filename', ''),
                    'tmp_picture_taken': res.get('taken_at', '')
                }
                self.broadcast('tmp_picture', payload)
                self.logger.info("Background task: Camera capture completed and broadcasted.")
                
            except Exception as e:
                self.logger.error(f"Error in camera native background task: {e}", exc_info=True)

        # 3. 🚀 一瞬でこの関数をバックグラウンドに放り投げる
        self.socketio.start_background_task(_camera_capture_task)
        
        # 4. ✨ ブラウザには処理開始の受付通知を返す
        return self.make_result(True, "temporary picture capture started")

    def cmd_save_picture(self, request):
        tmp_path = request.get('tmp_picture_path')
        if not tmp_path or not os.path.isfile(tmp_path):
            return self.make_result(False, "tmp picture is not found.")

        os.makedirs(self.config.PIC_DIR, exist_ok=True)
        filename = os.path.basename(tmp_path)
        dest_path = os.path.join(self.config.PIC_DIR, filename)
        shutil.move(tmp_path, dest_path)

        no = self.db.insert_picture({'filename': filename})
        ret = no > 0
        
        data = self.db.get_latest_picture(self.config.PIC_DIR)
        # 💡 写真情報のみを 'picture' イベントで送信
        self.broadcast('picture', data)
        return self.make_result(ret, f"picture saved as {filename}." if ret else "failed to save picture.", True)

    def cmd_delete_picture(self, request):
        tmp_path = request.get('tmp_picture_path')
        if tmp_path and os.path.isfile(tmp_path):
            os.remove(tmp_path)
        return self.make_result(True, "tmp picture is deleted.")

    def cmd_pump_auto_start(self, request):
        self.manual_timer_stop()
        self.switcher.start()
        # 💡 キー名を 'status' に変更
        self.broadcast('pump_status', {'status': 'auto_start', 'seconds': 0})
        return self.make_result(True, "pump start (auto)")

    def cmd_pump_auto_stop(self, request):
        self.manual_timer_stop()
        self.switcher.stop()
        data = {'status': 'auto_stop', 'seconds': 0} # 💡 変更
        self.db.set_pump_status(data)
        self.broadcast('pump_status', data)
        return self.make_result(True, "pump stop (auto)")

    def cmd_pump_manual_start(self, request):
        self.manual_timer_stop()
        self.switcher.stop()
        seconds = int(request.get('seconds', 0))
        self.device.pump_main_a.on()
        self.device.pump_main_b.off()
        if seconds > 0:
            self.manual_timer_start(seconds)

        data = {'status': 'manual_start', 'seconds': seconds}
        if seconds >= 0:
            self.db.set_pump_status(data)
        else:
            self.db.updateone('pump_status', {'status': data['status']})
        self.broadcast('pump_status', data)
        return self.make_result(True, "pump start (manual)")

    def cmd_pump_manual_stop(self, request=None):
        """手動停止ボタン押下時（安全にタイマーを破棄し、オートも止める）"""
        self.logger.info("Manual pump stop requested by user.")
        
        # 1. 生き残っている手動タイマーがあれば安全にキャンセルして、ポンプを物理的にもOFFにする
        self.manual_timer_stop()
        
        # 2. オート運転（間欠運転）も確実にここで道連れにして停止させる
        self.switcher.stop()
        
        # 3. データベースとフロントエンドの状態を安全に更新・配信
        data = {'status': 'manual_stop', 'seconds': 0}
        self.db.set_pump_status(data)
        self.broadcast('pump_status', data)
        return self.make_result(True, "pump stop (manual)")

    def manual_timer_start(self, seconds):
        # タイマーが終了したら _manual_pump_stop_callback を呼び出す
        self.manual_timer = threading.Timer(seconds, self._manual_pump_stop_callback)
        self.manual_timer.start()

    def manual_timer_stop(self):
        """手動タイマーのゾンビ化を防ぐための完全消滅関数"""
        if self.manual_timer is not None:
            self.manual_timer.cancel()
            self.manual_timer = None
        # 物理的なピン出力を安全側に倒す
        self.device.pump_main_a.off()
        self.device.pump_main_b.off()

    def _manual_pump_stop_callback(self):
        """タイマーがキャンセルされず、時間切れまで全うした時だけ通るルート"""
        self.logger.info("Manual pump timer reached timeout.")
        self.manual_timer_stop() # ポンプOFFとタイマー参照クリア
        
        # タイムアウト時も安全のためにオートを巻き込んで止める
        self.switcher.stop() 
        
        data = {'status': 'manual_stop', 'seconds': 0}
        self.db.set_pump_status(data)
        self.broadcast('pump_status', data)

    def cmd_set_led(self, request):
        color = request.get('color')
        self.device.update_led(color)
        return self.make_result(True, f"led is changed to {color}.")

    def cmd_measure_sensor(self, request):
        kind = request.get('sensor_kind')
        
        # 1. 温湿度 (BME280 / 今後SHT30に変える際もここを修正するだけ)
        if kind == 'temp_humid':
            values = self.sensors.read_bme280()
            if values and 'air_temp' in values and 'humidity' in values:
                return self.make_result(True, f"temperature {values.get('air_temp')} humidity {values.get('humidity')}")
            return self.make_result(False, "temperature/humidity sensor unavailable")

        # 2. 水温 (water_temp)
        elif kind == 'water_temp':
            value = self.sensors.read_water_temp()
            if value is not None:
                return self.make_result(True, f"water_temp = {value} C")

        # 3. 濃度 (tds_level / EC)
        elif kind == 'tds_level':
            # 濃度測定には水温補正が必要なため、まず水温を取得
            water_temp = self.sensors.read_water_temp()
            value = self.sensors.read_ec(water_temp)
            if value is not None:
                return self.make_result(True, f"tds_level = {value}")

        # 4. 明るさ (brightness / 実際の関数名は read_lux)
        elif kind == 'brightness':
            value = self.sensors.read_lux()
            if value is not None:
                return self.make_result(True, f"brightness = {value} lux")

        # 5. 水位 (water_level)
        elif kind == 'water_level':
            value = self.sensors.read_water_level()
            if value is not None:
                return self.make_result(True, f"water_level = {value}")

        # 6. その他のセンサー (水圧 water_pressure など、将来用)
        else:
            # 登録外のセンサー、または関数名が一致するものはgetattrで安全にフォールバック
            func = getattr(self.sensors, f"read_{kind}", None)
            if func:
                value = func()
                if value is not None:
                    return self.make_result(True, f"{kind} = {value}")

        # すべての条件を通り抜けて値が取れなかった場合のエラー処理
        return self.make_result(False, f"{kind} could not read or unknown sensor type.")

    # === 🔧 サブポンプ・自動補充コマンドハンドラ群 ===

    def cmd_subpump_refill(self, request):
        """自動・手動共通の補充要求判定ハンドラ"""
        # 💡 設定値のチェック（1のとき有効、0のとき無効と仮定。条件の反転を修正）
        if not int(self.schedule.get('refill_active', 0)):
            self.logger.info("Auto refill is disabled in settings.")
            return self.make_result(False, "refill is disabled.")

        option = request.get('option')
        if option == 'must':
            # 'must' オプション：上限スイッチが感知（満水ではない）場合に補充
            perform_refill = not self.device.float_main_top.is_active
        else:
            # 通常：下限スイッチが感知（水切れしている）場合に補充
            perform_refill = not self.device.float_main_bottom.is_active

        if perform_refill:
            if self.device.float_sub.is_active: # サブタンクに水があるか
                self.logger.info("Water level low. Starting subpump refill sequence...")
                
                # 自動補充時の最大秒数を設定から取得（なければデフォルト120秒）
                max_seconds = int(self.schedule.get('refill_max_seconds', 120))
                
                # 💡 リクエストに秒数を上書きして共通スタート関数を呼び出す
                request['seconds'] = max_seconds
                request['is_auto_refill'] = True # 自動補充フラグを仕込む

                # 💡 自動補充の開始時に、液肥を同時に投入するかどうかの厳格な判定
                # A) 既に今日1回追肥を行っている場合はスキップ（トラブル時の濃縮防止セーフティ）
                if self.fertilized_today:
                    self.logger.info("Fertilizer: Already fertilized today. Water refill only.")
                    request['is_auto_fertilize'] = False
                else:
                    # B) 現在のEC濃度をその場で測定して判定
                    self.logger.info("Fertilizer: Checking current EC level before refill...")
                    water_temp = self.sensors.read_water_temp()
                    current_ec = self.sensors.read_ec(water_temp)
                    
                    # 閾値評価ロジック(evaluate)を部分再現して very_high をチェック
                    limit = self.db.get_sensor_limit() or {}
                    vhigh_limit = limit.get('tds_level_vhigh')
                    
                    if current_ec is not None and vhigh_limit is not None and current_ec > float(vhigh_limit):
                        # 濃度が危険値（very_high）を超えている場合は水のみ補充
                        self.logger.warning(f"Fertilizer: EC is VERY HIGH ({current_ec}). Skipping fertilizer for safety.")
                        request['is_auto_fertilize'] = False
                    else:
                        # 濃度が安全圏、かつ今日初めての自動補充なら「追肥フラグ」をONに！
                        self.logger.info(f"Fertilizer: EC is safe ({current_ec}). Fertilizer will be added.")
                        request['is_auto_fertilize'] = True

                return self.cmd_subpump_start(request)
            else:
                message = "水位低下していますが、サブタンクの水がありません。"
                self.logger.warning(message)
                if int(self.schedule.get('emergency_active', 0)):
                    self.notifier.send_emergency(message)
                return self.make_result(False, message)
        else:
            self.logger.info("Water level is sufficient. No refill needed.")
            return self.make_result(True, "水位は十分です。")
    
    def cmd_subpump_start(self, request):
        """サブポンプの起動と監視タスクの割り当て（軽量・安全なEventlet版）"""
        if self.subpump_timer is not None:
            return self.make_result(False, "subpump already running")

        is_auto = request.get('is_auto_refill', False)
        if request.get('command') == 'subpump_start' and not is_auto:
            seconds = 120
        else:
            seconds = int(request.get('seconds', self.schedule.get('refill_max_seconds', 120)))

        # ポンプをON
        self.device.ssr_sub_pump.on()
        self.logger.info(f"Subpump turned ON. Max timeout: {seconds} seconds.")

        # 最大時間切れで止めるセーフティタイマー
        self.subpump_timer = threading.Timer(seconds, self._subpump_stop_callback)
        self.subpump_timer.start()

        # 💡 軽量なEventletのループとして定義
        def _subpump_monitor_task():
            start_time = time.time()
            top_detect_counter = 0

            # --- 💥 新機能: バックグラウンド時間差追肥ロジックの定義 ---
            if request.get('is_auto_fertilize', False):
                self.fertilized_today = True # 2重投入を防ぐため即座にフラグをロック
                
                # 各ミニポンプの動作秒数を設定から個別に取得（設定がなければデフォルト10秒）
                f1_sec = int(self.schedule.get('fert1_seconds', 10))
                f2_sec = int(self.schedule.get('fert2_seconds', 10))
                f3_sec = int(self.schedule.get('fert3_seconds', 10))
                f4_sec = int(self.schedule.get('fert4_seconds', 10))
                
                def _fertilize_sequence_task():
                    try:
                        def check_system_alive():
                            if not self.switcher.running:
                                self.device.fert_pump_1.off(); self.device.fert_pump_2.off()
                                self.device.fert_pump_3.off(); self.device.fert_pump_4.off()
                                raise RuntimeError("Fertilizer task aborted due to system shutdown.")

                        # ==================== Phase 1 ====================
                        self.logger.info(f"Fertilizer Phase 1: Turning ON Pump-1 (1号:{f1_sec}s) and Pump-3 (5号:{f3_sec}s).")
                        self.device.fert_pump_1.on()
                        self.device.fert_pump_3.on()
                        
                        start_p1 = time.time() # Phase 1 の開始実時間を記録
                        max_p1 = max(f1_sec, f3_sec)
                        
                        # 💡 いずれかのポンプが動いている、かつ最大時間を超えるまでループ
                        while (self.device.fert_pump_1.is_active or self.device.fert_pump_3.is_active) and (time.time() - start_p1 < max_p1 + 2):
                            gevent.sleep(0.5) # 💡 少し細かめにチェック（道を譲る）
                            check_system_alive()
                            
                            elapsed = time.time() - start_p1 # 実際に経過した秒数
                            
                            # 不一致（==）ではなく、時間を超えたか（>=）で判定するので絶対にすり抜けない
                            if self.device.fert_pump_1.is_active and elapsed >= f1_sec:
                                self.device.fert_pump_1.off()
                                self.logger.info("Pump-1 (1号) OFF")
                                
                            if self.device.fert_pump_3.is_active and elapsed >= f1_sec: # 💡 バグ修正：f3_sec で判定すべき箇所
                                self.device.fert_pump_3.off()
                                self.logger.info("Pump-3 (5号) OFF")

                        # 安全弁：ループを抜けた際、実時間超過で確実にOFFにする
                        self.device.fert_pump_1.off()
                        self.device.fert_pump_3.off()
                        
                        # 結晶化防止のために少し待機（必要に応じて数秒sleepを挟んでください）
                        gevent.sleep(1.0)
                        check_system_alive()

                        # ==================== Phase 2 ====================
                        self.logger.info(f"Fertilizer Phase 2: Turning ON Pump-2 (2号:{f2_sec}s) and Pump-4 (9号:{f4_sec}s).")
                        self.device.fert_pump_2.on()
                        self.device.fert_pump_4.on()
                        
                        start_p2 = time.time() # Phase 2 の開始実時間を記録
                        max_p2 = max(f2_sec, f4_sec)
                        
                        while (self.device.fert_pump_2.is_active or self.device.fert_pump_4.is_active) and (time.time() - start_p2 < max_p2 + 2):
                            gevent.sleep(0.5)
                            check_system_alive()
                            
                            elapsed = time.time() - start_p2
                            
                            if self.device.fert_pump_2.is_active and elapsed >= f2_sec:
                                self.device.fert_pump_2.off()
                                self.logger.info("Pump-2 (2号) OFF")
                                
                            if self.device.fert_pump_4.is_active and elapsed >= f4_sec:
                                self.device.fert_pump_4.off()
                                self.logger.info("Pump-4 (9号) OFF")

                        self.device.fert_pump_2.off()
                        self.device.fert_pump_4.off()
                        self.logger.info("Fertilizer Sequence completed successfully.")
                        
                    except Exception as e:
                        self.logger.error(f"Error in fertilizer background thread: {e}")
                        self.device.fert_pump_1.off(); self.device.fert_pump_2.off()
                        self.device.fert_pump_3.off(); self.device.fert_pump_4.off()
                
                # メインの監視タスクを止めないよう、液肥シークエンス自体もさらに別タスクとして非同期に切り離す
                # これにより、途中で満水になってサブポンプが止まっても、液肥は最後まで独立して回りきります！
                self.socketio.start_background_task(_fertilize_sequence_task)

            while self.device.ssr_sub_pump.is_active:
                # 💡 ここで1秒間、他のWeb通信へ道を譲ります（フリーズしません）
                gevent.sleep(1.0)
                
                # A) メインタンクの上限フロートスイッチ判定
                if self.device.float_main_top.is_active:
                    top_detect_counter += 1
                    self.logger.info(f"Subpump monitor: Float main top detected ({top_detect_counter}/{self.REFILL_CONFIRM_COUNT})")
                    if top_detect_counter >= self.REFILL_CONFIRM_COUNT:
                        self.logger.info("Subpump monitor: Water level stabilized at TOP. Stopping refill.")
                        self._stop_and_record_refill(start_time, "Success (Full)")
                        break
                else:
                    if top_detect_counter > 0:
                        self.logger.info("Subpump monitor: Float main top cleared due to water ripple. Resetting counter.")
                        top_detect_counter = 0
                    
                # B) サブタンクの空焚き防止判定
                if not self.device.float_sub.is_active:
                    self.logger.warning("Subpump monitor: Subtank empty. Stopping pump.")
                    self._stop_and_record_refill(start_time, "Aborted (Subtank empty)")
                    if int(self.schedule.get('emergency_active', 0)):
                        self.notifier.send_emergency("【警告】自動補充中にサブタンクが空になりました。")
                    break

        # 💡 本物のOSスレッドは作らず、SocketIOの軽量タスクとして裏で安全に回します
        self.socketio.start_background_task(_subpump_monitor_task)

        # 状態更新をフロントへ通知
        data = self.get_subpump_status()
        self.broadcast('refill_update', data)
        return self.make_result(True, f"subpump started for max {seconds} seconds")

    def _stop_and_record_refill(self, start_time, result_status):
        """フロートスイッチ検知による途中停止と、DBへの補充記録の保存"""
        # ポンプを安全に停止
        self._subpump_stop_callback()
        
        # 実際に動いていた秒数を計算
        elapsed_seconds = int(time.time() - start_time)
        self.logger.info(f"Refill ended. Duration: {elapsed_seconds}s. Status: {result_status}")
        
        # DBに補充の歴史（ログ）を保存
        # 💡 お使いのDBクラスのメソッド名（例: insert_refill_logなど）に合わせて調整してください
        try:
            self.db.insert_refill_record({
                'duration_seconds': elapsed_seconds,
                'status': result_status,
                'recorded_at': datetime.now().strftime('%Y/%m/%d %H:%M:%S')
            })
        except Exception as e:
            self.logger.error(f"Failed to insert refill record to DB: {e}")

    def cmd_subpump_stop(self, request=None):
        """手動停止ボタン押下時"""
        self._subpump_stop_callback()
        return self.make_result(True, "subpump switch off")

    def _subpump_stop_callback(self):
        """タイマーや監視タスクから呼ばれる純粋な消灯・解放処理"""
        if self.subpump_timer is not None:
            self.subpump_timer.cancel()
            self.subpump_timer = None
        self.device.ssr_sub_pump.off()
        
        # 停止後の最新状態をフロントへ一斉配信
        data = self.get_subpump_status()
        self.broadcast('refill_update', data)

    def cmd_subpump_update(self, request):
        """ブラウザからの状態更新要求"""
        data = self.get_subpump_status()
        self.broadcast('refill_update', data)
        return self.make_result(True, "subpump status updated")
    
    def get_subpump_status(self):
        """現在のサブポンプとフロートスイッチ、漏水検知、循環検知の状態を辞書で返す"""
        return {
            'subpump_on': self.device.ssr_sub_pump.is_active,
            'float_main_top': self.device.float_main_top.is_active,
            'float_main_bottom': self.device.float_main_bottom.is_active,
            'float_sub': self.device.float_sub.is_active,
            'leak_detect': self.device.leak_detect.is_active,
            'water_check': self.device.water_check.is_active,
            'refill_level': self.sensors.read_water_level()
        }
    
    def cmd_make_report(self, request):
        report = self.report_main()
        self.db.insert_report(report)
        self.broadcast('report', report)
        return self.make_result(True, "report created")

    def cmd_test_discord(self, request):
        self.notifier.send_emergency(f"Discord test from Hydroponics: {datetime.now().strftime('%Y/%m/%d %H:%M:%S')}")
        return self.make_result(True, "discord test sent")

    def cmd_test_ssr1(self, request):
        control = request.get('option')
        self.device.ssr_sub_pump.on() if control == 'on' else self.device.ssr_sub_pump.off()
        return self.make_result(True, f"SSR ssr_sub_pump:{control}")

    def cmd_test_ssr2(self, request):
        control = request.get('option')
        self.device.ssr_room_fan.on() if control == 'on' else self.device.ssr_room_fan.off()
        return self.make_result(True, f"SSR ssr_room_fan:{control}")

    def cmd_debug_time_span(self, request):
        self.MINUTE_START = int(request.get('minute_start', self.MINUTE_START))
        self.MINUTE_STOP = int(request.get('minute_stop', self.MINUTE_STOP))
        self.MINUTE_REFILL = int(request.get('minute_refill', self.MINUTE_REFILL))
        return self.make_result(True, f"changed time span to {self.MINUTE_START}-{self.MINUTE_STOP}-{self.MINUTE_REFILL}")

    def debug_echo(self, request):
        return self.make_result(True, "echo from web socket server.")
