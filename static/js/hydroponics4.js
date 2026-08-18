//
// hydroponics javascript
//

// グローバル変数
let pump_active = false;

let timerIdPump = null;
let timerIdCamera = null;
let timerIdReconnect = null;
let timerIdCpuTemp = null;

let webSocket = null;
let connectRetry = true;
let master = {};  // masterデータ保持用連想配列

const server_uri = location.origin; // Socket.IO uses the same origin and port

// DOM選択の共通ヘルパー定義
const $ = (selector, context = document) => context.querySelector(selector);
const $$ = (selector, context = document) => Array.from(context.querySelectorAll(selector));

// 📝 テキスト入力欄・数値入力欄
  const textInputItems = [
  "time_morning", "time_noon", "time_evening", "time_night",
  "morning_on", "morning_off", "noon_on", "noon_off", "evening_on", "evening_off", "night_on", "night_off",
  "refill_max_seconds", "forced_refill_hour", "valve_open", "valve_close",
  "fert1_seconds", "fert2_seconds", "fert3_seconds", "fert4_seconds", "fert_adjust_hour",
  "camera1", "camera2", "camera3", "camera4", "camera5",
  "minute_start", "minute_stop", "minute_refill"  ,
  "notify_time"
];

// 🔄 トグルスイッチ（チェックボックス）
const toggleItems = [
  'schedule_active', 'room_fan_active', 'nightly_active', 'camera_active', 'refill_active', 'forced_refill_active',
  'valve_active', 'fert_adjust_active', 'notify_active', 'normal_active', 'emergency_active'
];

//
// 初期化処理
//
document.addEventListener('DOMContentLoaded', () => {
  // 最初は非表示にするもの
  const settingEl = $('#setting');
  if (settingEl) settingEl.style.display = 'none'; // 設定ページ
  const pictureSaveButtonsEl = $('#picture_save_buttons');
  if (pictureSaveButtonsEl) pictureSaveButtonsEl.style.display = 'none'; // カメラ保存ボタン
  const pumpWorkingEl = $('#pump_working');
  if (pumpWorkingEl) pumpWorkingEl.style.display = 'none'; // ポンプ動作表示

  // 時計の表示
  setTimeout(UpdateClock, 500);

  // タブイベントハンドラーの初期化
  initTabEventHandlers();

  // レポート日付入力（カレンダー）ハンドラの初期化
  const reportDateEl = $('#txt_report_date');
  if (reportDateEl) {
    // 最大は今日までにする
    try { reportDateEl.max = getTodayString(); } catch (e) {}
    reportDateEl.addEventListener('change', () => {
      if (reportDateEl.value) {
        currentDisplayDate = reportDateEl.value;
        refreshCurrentDateReports();
        updateDateButtonsState();
      }
    });
  }

  // websocket-serverと接続
  websocketConnect();
});

//
// 再接続ボタン
//
function reconnectButtonClick()
{
  if (webSocket.connected) {
    printDebugMessage("websocket is already connected.");
  } else {
    printDebugMessage("Connecting websocket...");
    webSocket.open();
    connectRetry = true;
  }
}

//
// 切断ボタン
//
function disconnectButtonClick()
{
  if (webSocket.connected) {
    printDebugMessage("Disconnecting websocket...");
    connectRetry = false;
    webSocket.close();
  } else {
    printDebugMessage("websocket is not connected.");
  }
}

//
// メインページへ移動
//
function goMain()
{
  const settingEl = $('#setting');
  if (settingEl) settingEl.style.display = 'none';
  
  const mainEl = $('#main');
  // ⚠️ 'block' ではなく 'flex' を指定して、CSSの横並びを崩さないようにする
  if (mainEl) mainEl.style.display = 'flex';
}

//
// 設定ページへ移動
//
function goSetting()
{
  const settingEl = $('#setting');
  // ⚠️ 'block' ではなく 'flex' を指定して、CSSの横並びを崩さないようにする
  if (settingEl) settingEl.style.display = 'flex';
  
  const mainEl = $('#main');
  if (mainEl) mainEl.style.display = 'none';
}

//
// websocket-serverと接続
//
function websocketConnect()
{
  if (timerIdReconnect != null)
  {
    clearTimeout(timerIdReconnect);
    timerIdReconnect = null;
  }

// 🔌 Socket.IO の初期化（自動再接続を完全に無効化）
  webSocket = io(server_uri, { 
    transports: ['websocket'],
    reconnection: false  // 自動再接続（5秒ごとのリトライ）をオフにする
  });

  // 🔌 Socket.IO イベントハンドラの設定
  webSocket.on('connect', websocket_open);
  webSocket.on('disconnect', websocket_close);
  webSocket.on('connect_error', websocket_error);
  webSocket.on('error', websocket_error);

  // 1回限定の初期化データ受信イベント（サーバーから最初に送られてくる全データを一括で受け取る）
  webSocket.on('initial_data', (data) => {
    websocket_initial_data(data);
    Object.assign(master, data);
  });

  // リアルタイム更新用イベント（マスターへの記憶 Object.assign もここで一括処理）
  webSocket.on('report', (data) => {
    setValueReport(data);
    Object.assign(master, data);
  });

  webSocket.on('picture', (data) => {
    setValuePicture(data);
    Object.assign(master, data);
  });

  webSocket.on('setting_basic', (data) => {
    setValueBasic(data);
    Object.assign(master, data);
  });

  webSocket.on('setting_schedule', (data) => {
    setValueSchedule(data);
    Object.assign(master, data);
  });

  webSocket.on('setting_sensor_limit', (data) => {
    setValueSensorLimit(data);
    Object.assign(master, data);
  });

  webSocket.on('pump_status', (data) => {
    setValuePumpStatus(data);
    Object.assign(master, data);
  });

  webSocket.on('tmp_picture', (data) => {
    setValueTmpPicture(data);
    Object.assign(master, data);
  });

  // サーバー側からの汎用ログ出力（デバッグ用）を受け取り、デバッグ領域に追記する
  webSocket.on('server_log', (data) => {
    const msg = (data && data.message) ? data.message : JSON.stringify(data);
    printDebugMessage((data && data.datetime ? data.datetime + ': ' : '') + msg);
  });

  webSocket.on('refill_update', (data) => {
    setValueRefillUpdate(data);
    Object.assign(master, data);
  });

  webSocket.on('refill_record', (data) => {
    setValueRefillUpdate(data, true);
    Object.assign(master, data);
  });

  webSocket.on('inactive_color', (data) => {
    setValueInactiveColor(data);
    Object.assign(master, data);
  });

  webSocket.on('cpu_temperature_response', (data) => {
    console.log("Received CPU temperature data:", data); // デバッグ用ログ
    if (data.success) {
      const cpuTempEl = $('#cpu_temperature');
      if (cpuTempEl) {
        cpuTempEl.textContent = data.cpu_temp + " ℃";
      }
      Object.assign(master, data);
    } else {
      // サーバー側での読み取りエラー発生時はタイマーを止めてボタンを出す
      handleCpuUpdateError();
    }
  });

  // 過去24時間データ受信イベント
  webSocket.on('response_past_24h', (data) => {
    if (data && data.past_reports && Array.isArray(data.past_reports)) {

      const resDate = data.target_date || "";
      currentDisplayDate = resDate;

      // 画面上の日付テキスト表示領域を更新
      const dateEl = $('#txt_report_date');
      if (dateEl) {
        if (dateEl.tagName === 'INPUT') dateEl.value = resDate; else dateEl.textContent = resDate;
      }

      const formattedReports = data.past_reports.map(r => {
        const copy = Object.assign({}, r);
        [
          'air_temp', 'humidity', 'water_temp', 'water_pressure',
          'water_level', 'tds_volt', 'tds_level', 'brightness', 'water_pulses'
        ].forEach(k => {
          if (k in copy && copy[k] !== null && copy[k] !== undefined) {
            const n = Number(copy[k]);
            copy[k] = Number.isNaN(n) ? copy[k] : n;
          }
        });
        return copy;
      });

      // 取得したデータをカレンダーキャッシュに記憶
      // 給水データも一緒にキャッシュマップに保存する
      reportDateCacheMap[resDate] = {
        reports: formattedReports,
        refills: data.refill_records || [] // 給水アレイもキャッシュに同梱
      };

      // キャッシュが容量オーバー（5日分超）したら古い日付のキーを削除してメモリを節約
      const cacheKeys = Object.keys(reportDateCacheMap);
      if (cacheKeys.length > MAX_CACHE_DAYS) {
        const oldestKey = cacheKeys[0]; // 最初に入った古いキー
        delete reportDateCacheMap[oldestKey];
        printDebugMessage(`[Cache Clean] 古いキャッシュ(${oldestKey})を削除しました。`);
      }

      // グラフ描画へ渡すグローバル変数の展開
      rawReportsCache = formattedReports;
      initOrUpdateChart();

    } else {
      printDebugMessage("グラフデータの取得に失敗したか、データが空です。");
    }
    updateDateButtonsState()
  });
}

function websocket_open()
{
  printDebugMessage("websocket opened. " + server_uri);
  const reconnectBtn = $('#reconnectButton');
  if (reconnectBtn) reconnectBtn.style.display = 'none';
  
  const confirmModalEl = $('#confirmModal');
  if (confirmModalEl) {
    const modalInstance = bootstrap.Modal.getInstance(confirmModalEl) || new bootstrap.Modal(confirmModalEl);
    modalInstance.hide();
  }
}

//
// websocket切断時の処理（再接続の準備としてログ用キャッシュをリセット）
//
function websocket_close(event)
{
  printDebugMessage("websocket closed.");
  const reconnectBtn = $('#reconnectButton');
  if (reconnectBtn) reconnectBtn.style.display = 'block';
  
  setValuePumpStatus({'status': 'manual_stop', 'seconds': 0});
  setValueRefillUpdate({'subpump_on': false});

  // 再接続時にサーバーから最新データを綺麗に取り直すため、master内の記録を一度クリア
  if (master) {
    delete master['refill_records'];
  }

  // 1分後に１回だけ自動再接続を試みる
  if (connectRetry == true) {
    connectRetry = false;
    printDebugMessage("reconnect timer start");
    timerIdReconnect = setTimeout(websocketConnect, 60 * 1000);
  }
}

function websocket_error(event)
{
  if (timerIdReconnect != null){
    clearTimeout(timerIdReconnect);
    timerIdReconnect = null;
  } else {
    printDebugMessage("websocket error occured." + event);
    const now = new Date();
    const nowstr = now.getFullYear() + "/" + (now.getMonth() + 1) + "/" + now.getDate()
      + " " + now.getHours() + ":" + now.getMinutes() + ":" + now.getSeconds();
    showModalResult({'result': 'error', 'message': 'websocket error.', 'datetime': nowstr});
  }
}

function websocket_initial_data(data)
{
  setValueReport(data);
  setValuePicture(data);
  setValueBasic(data);
  setValueSchedule(data);
  setValueSensorLimit(data);
  setValuePumpStatus(data);
  setValueRefillUpdate(data);
  setValueInactiveColor(data);
  setValueVersionData(data);
}

//
// websocketサーバーへデータ送信（個別レスポンス処理対応版）
//
function websocket_send(data) {
  // 💡 もしwebSocketが未接続または切断状態の場合は、再接続を試みる
  if (!webSocket) {
    websocketConnect();
  } else if (!webSocket.connected) {
    webSocket.open();
  }

  if (webSocket && webSocket.connected) {
    webSocket.emit('command', data, (response) => {
      if (response) {
        // 1. サーバーから 'result'（'ok'または'error'）と 'message'、'datetime' が確実に届きます
        printDebugMessage(response['datetime'] + ': ' + response['result'] + ' - ' + response['message']);
        
        if (response['show_popup']) {
          showModalResult(response);
        }

        // 2. 💥 新設: サーバーからの応答の中に、個別イベント用のデータが含まれているかチェック
        // サーバー側が response['type'] や response['data'] という形で温度を返してきた場合、
        // 既存の webSocket.on('イベント名') を手動でトリガー（発火）させます。
        if (response['type']) {
          const eventType = response['type']; // 例: 'cpu_temperature_response'
          const eventData = response['data'] || response; // データそのもの、またはresponse全体

          // Socket.IOの内部マネージャーを通じて、登録済みの 'cpu_temperature_response' などの関数を呼び出す
          webSocket.listeners(eventType).forEach(listener => listener(eventData));
        }
      }
    });
  }
}

//
// メイン：定時撮影写真の反映
//
function setValuePicture(data)
{
  if ('picture_path' in data) {
    const frame = $('#picture_frame');
    if (frame) frame.style.backgroundImage = 'url(' + data['picture_path'] + ')';
    const timestamp = $('#picture_timestamp');
    if (timestamp) timestamp.textContent = data['picture_taken'];
  }
}

//
// メイン：測定データの反映
//
function setValueReport(data)
{
  const sensors = new Array('air_temp', 'humidity', 'water_temp', 'water_level', 'tds_level', 'brightness');
  const decimal = new Array(1,1,1,0,2,0);

  for (let i = 0; i < sensors.length; i++) {
    const name = '#' + sensors[i];
    let value = 'XX.X';
    const item = '#sensor_' + sensors[i];
    let color_name = 'bg-secondary';

    // ⚠️ データ内にキーが存在し、かつ値が null や undefined でない場合のみ処理を行う
    if (sensors[i] in data && data[sensors[i]] !== null && data[sensors[i]] !== undefined) {
      value = data[sensors[i]].toFixed(decimal[i]);
      const status = data[sensors[i] + '_status'];
      if (status == 'danger') {
        color_name = 'bg-danger';
      } else if (status == 'warning') {
        color_name = 'bg-warning';
      } else if (status == 'success') {
        color_name = 'bg-success';
      }   
    }

    // センサー値の更新
    const nameEl = $(name);
    if (nameEl) nameEl.textContent = value;
    
    // センサー値エリアの色変更
    const itemEl = $(item);
    if (itemEl) {
      itemEl.classList.remove("bg-success", "bg-warning", "bg-danger", "bg-secondary");
      itemEl.classList.add(color_name);
    }
  }

  // タイトル部分の色変更
  let value = "unknown";
  let status = "secondary";
  if ('total_status' in data && data['total_status'] !== null && data['total_status'] !== undefined && data['total_status'] !== "") {
    // ⚠️ もし 'none' または 'None' だった場合は、上書きせずにデフォルトの 'secondary' のままにする
    if (data['total_status'].toLowerCase() !== 'none') {
      status = data['total_status'];
      value = (status == 'success') ? 'all OK' : status;
    }
  }
  // ステータスエリア全体の色変更
  const statusColorEl = $('#status_color');
  if (statusColorEl) {
    statusColorEl.classList.remove("alert-success", "alert-warning", "alert-danger", "alert-secondary");
    statusColorEl.classList.add("alert-" + status);
  }
  
  // バッジの色と文字列変更
  const statusBadgeEl = $('#status_badge');
  if (statusBadgeEl) {
    statusBadgeEl.classList.remove("bg-success", "bg-warning", "bg-danger", "bg-secondary");
    statusBadgeEl.classList.add("bg-" + status); // Bootstrap 5 では badge-* から bg-* が基本スタイルになります
    statusBadgeEl.textContent = value;
  }
}

//
// 設定：基本情報の反映
//
function setValueBasic(data)
{
  const titlenameEl = $('#titlename');
  if (titlenameEl) titlenameEl.textContent = data['myname'];
  const myidEl = $('#myid');
  if (myidEl) myidEl.textContent = data['myid'];
  const mynameEl = $('#myname');
  if (mynameEl) mynameEl.textContent = data['myname'];
  const memoEl = $('#memo');
  if (memoEl) memoEl.textContent = data['memo'];

  if (data['started'] != null) {
    const startedEl = $('#started');
    if (startedEl) startedEl.textContent = data['started'];
  }
  if (data['finished'] != null) {
    const finishedEl = $('#finished');
    if (finishedEl) finishedEl.textContent = data['finished'];
  }
}

//
// 設定：定時処理の設定の反映（サーバーから受信したデータの画面反映）
//
function setValueSchedule(data)
{
  // 📝 テキスト入力欄・数値入力欄への値のセット
  textInputItems.forEach(name => {
    if (name in data) {
      // 時刻指定なしにしたいとき（マイナス値は無効として空文字にする処理）
      if (data[name] < 0)
        data[name] = "";
      const inputEl = $(`input[name="${name}"]`);
      if (inputEl) inputEl.value = data[name];
    }
  });

  // 🔄 トグルスイッチ（チェックボックス）のON/OFF制御
  // 新しい「fert_adjust（液肥の自動調整）」を追加しました
  toggleItems.forEach(name => {
    if (name in data) {
      const toggleEl = $(`input[name="${name}"]`);
      if (toggleEl) {
        toggleEl.checked = !!data[name];
        toggleEl.dispatchEvent(new Event('change'));
      }
    }
  });
}

//
// 設定：センサー閾値の反映
//
function setValueSensorLimit(data)
{
  const limits = [
    "air_temp_vlow", "air_temp_low", "air_temp_high", "air_temp_vhigh",
    "humidity_vlow", "humidity_low",
    "water_temp_vlow", "water_temp_low", "water_temp_high", "water_temp_vhigh",
    "water_level_vlow", "water_level_low",
    "tds_level_vlow", "tds_level_low", "tds_level_high", "tds_level_vhigh",
    "cpu_temp_high", "cpu_temp_vhigh"
  ];

  limits.forEach(name => {
    if (name in data) {
      const inputEl = $(`input[name="${name}"]`);
      if (inputEl) inputEl.value = data[name];
    }
  });
}

//
// メイン／設定：ポンプ状態の反映
//
function setValuePumpStatus(data)
{
  const pumpInfoEl = $('#pump_info');
  const cycleIconEl = $('#cycle_icon');

  switch (data['status'])
  {
    case 'auto_start':
      // 時間がわからないのでカウントダウン更新はしない
      return;

    case 'cycle_start':
      if (pumpInfoEl) pumpInfoEl.textContent = 'オート動作中';
      if (cycleIconEl) cycleIconEl.classList.add('bi-spin');
      pump_active = true;
      break;

    case 'cycle_stop':
      if (pumpInfoEl) pumpInfoEl.textContent = 'オート動作中';
      if (cycleIconEl) cycleIconEl.classList.remove('bi-spin');
      pump_active = false;
      setValuePumpStatusWaterCheck(data);
      break;

    case 'manual_start':
      if (pumpInfoEl) pumpInfoEl.textContent = 'マニュアル動作中';
      if (cycleIconEl) cycleIconEl.classList.add('bi-spin');
      pump_active = true;
      break;

    case 'cycle_ok':
    case 'cycle_ng':
      setValuePumpStatusWaterCheck(data);
      return;

    case 'auto_stop':
    case 'manual_stop':
    default:
      if (pumpInfoEl) pumpInfoEl.textContent = '待機中'; // 👈 '動作モード' から '待機中' へ変更
      if (cycleIconEl) cycleIconEl.classList.remove('bi-spin');
      pump_active = false;
      break;
  }

  pumpStatusUpdate(data['seconds']);
}

function setValuePumpStatusWaterCheck(data) {
  // 循環検知状態
  // ポンプ循環状態の変数（例として'unchecked', 'ok', 'ng' の3つの文字列を想定）
  // 実際のシステムに合わせて変数の取得方法を変更してください
  const water_check = data['status'];
  const pumpIcon = $('#icon_water_check'); // ポンプ表示用のHTML要素

  if (pumpIcon) {
    // 1. まず現在の状態に関わるクラスをすべてリセット
    const allClasses = [
      'bi-dash-circle', 'text-secondary', // 未チェック
      'bi-check-circle', 'text-success',  // OK
      'bi-x-circle', 'text-danger'        // NG
    ];
    pumpIcon.classList.remove(...allClasses);

    // 2. 状態（3パターン）に応じて適切なクラスを追加
    switch (water_check) {
      case 'cycle_ok': // OK状態（緑のチェック）
        pumpIcon.classList.add('bi-check-circle', 'text-success');
        break;

      case 'cycle_ng': // NG状態（赤のバツ）
        pumpIcon.classList.add('bi-x-circle', 'text-danger');
        break;

      case 'cycle_stop': // チェック無効状態（グレーのハイフン）
      default:
        pumpIcon.classList.add('bi-dash-circle', 'text-secondary');
        break;
    }
  }
}

/**
 * サーバーから画像データを受信したとき、または失敗したときの表示切り替え
 */
function setValueTmpPicture(data) {
  const tmpPictureFrame = $('#tmp_picture_frame');
  const tmpPictureTimestamp = $('#tmp_picture_timestamp');
  const pictureSaveButtons = $('#picture_save_buttons');
  const countdownNumber = $('#countdown_number');
  const cameraSpinner = $('#camera_spinner');

  if (data['tmp_picture_result']) {
    // 【撮影成功時】
    if (tmpPictureFrame && data['tmp_picture_path']) {
      const cacheBuster = '?t=' + new Date().getTime();
      tmpPictureFrame.style.backgroundImage = 'url(' + data['tmp_picture_path'] + cacheBuster + ')';
    }
    if (tmpPictureTimestamp) tmpPictureTimestamp.textContent = data['tmp_picture_taken'];

    if (pictureSaveButtons) pictureSaveButtons.style.setProperty('display', 'block', 'important');
    
    // 💡 撮影が終わったので、スピナーを隠す
    if (cameraSpinner) cameraSpinner.style.display = 'none';
    if (countdownNumber) countdownNumber.textContent = '';
    
  } else {
    // 【撮影失敗時】
    if (pictureSaveButtons) pictureSaveButtons.style.setProperty('display', 'none', 'important');
    
    // 💡 スピナーを隠し、エラー文字を出す
    if (cameraSpinner) cameraSpinner.style.display = 'none';
    if (countdownNumber) countdownNumber.textContent = 'error';
  }
}

//
// 設定：水の補充・履歴ログの反映（サーバーから受信したデータの画面反映）
//
function setValueRefillUpdate(data, append = false) {
  const subpumpWorking = $('#subpump_working');
  
  // サブポンプ動作状態
  if ('subpump_on' in data) {
    if (subpumpWorking) {
      if (data['subpump_on']) { // 💡 真偽値（True/False）で判定
        subpumpWorking.classList.add('text-primary', 'bi-spin');
        subpumpWorking.classList.remove('text-secondary');
      } else {
        subpumpWorking.classList.remove('text-primary', 'bi-spin');
        subpumpWorking.classList.add('text-secondary');
      }
    }
  }
  
  // メインタンク水位
  const refillLevel = $('#refill_level');
  if ('refill_level' in data) {
    if (refillLevel) refillLevel.textContent = data['refill_level'];
  } else {
    if (refillLevel) refillLevel.textContent = 'ー';
  }

  // 対象とするスイッチのリスト（サーバー側で値の正負は調整済み前提）
  const input_switchs = ['float_main_top', 'float_main_bottom', 'float_sub', 'leak_detect', 'water_valve'];

  for (const input_switch of input_switchs) {
    if (input_switch in data) {
      const iconSwitch = $('#icon_' + input_switch);

      if (iconSwitch) {
        const isTrue = data[input_switch];

        // 1. 基本となるON/OFFのアイコンと色を定義
        let onIcon  = 'bi-check-circle';
        let offIcon = 'bi-x-circle';

        // 2. ボールバルブの場合だけ、アイコンの種類を上書き
        if (input_switch === 'water_valve') {
          onIcon  = 'bi-play-circle';
          offIcon = 'bi-stop-circle';
        }

        // 3. 状態に応じてクラスを一括で張り替え
        if (isTrue) {
          iconSwitch.classList.remove(offIcon, 'text-danger');
          iconSwitch.classList.add(onIcon, 'text-success');
        } else {
          iconSwitch.classList.remove(onIcon, 'text-success');
          iconSwitch.classList.add(offIcon, 'text-danger');
        }
      }
    }
  }

  // 📜 給水履歴ログの反映（サーバー側で連結済みのテキストを一括流し込み）
  const refillLog = $('#refill_log');
  if (refillLog && 'refill_records' in data) {
    if (append) {
      // 追加モードの場合は、既存のログに追記する
      refillLog.value += data['refill_records'];
    } else {
      // 上書きモードの場合は、既存のログを置き換える
      refillLog.value = data['refill_records'];
    }
    
    // 常に最新のログ（最下部）が見えるように自動スクロール
    requestAnimationFrame(() => {
      refillLog.scrollTop = refillLog.scrollHeight;
    });
  }
}

function setValueInactiveColor(data) {
  if (data['activate'] == false) {
    const sensors = ['air_temp', 'humidity', 'water_temp', 'water_level', 'tds_level', 'brightness'];

    for (let i = 0; i < sensors.length; i++) {
      const itemEl = $('#sensor_' + sensors[i]);
      if (itemEl) {
        // センサー値エリアの色変更
        itemEl.classList.remove("bg-success", "bg-warning", "bg-danger", "bg-secondary");
        itemEl.classList.add("bg-secondary");
      }
    }

    // ステータスエリア全体の色変更
    const statusColorEl = $('#status_color');
    if (statusColorEl) {
      statusColorEl.classList.remove("alert-success", "alert-warning", "alert-danger", "alert-secondary");
      statusColorEl.classList.add("alert-primary");
    }
    
    // バッジの色と文字列変更
    const statusBadgeEl = $('#status_badge');
    if (statusBadgeEl) {
      statusBadgeEl.classList.remove("bg-success", "bg-warning", "bg-danger", "bg-secondary");
      statusBadgeEl.classList.add("bg-primary");
      statusBadgeEl.textContent = data['inactive_string'];
    }
  }
}

//
// バージョン情報の反映
//
function setValueVersionData(data) {
  // --- 既存の初期データ展開処理（省略） ---
  // $('#water_level').textContent = data.water_level; などの後ろに追記

  // 💥 サーバーから受け取ったバージョン情報を展開
  const versionEl = $('#app_version');
  if (versionEl) {
      versionEl.textContent = data.app_version || 'Ver.Unknown';
  }

  const hwVersionEl = $('#hw_version');
  if (hwVersionEl) {
      hwVersionEl.textContent = data.hw_version || '---';
  }

  const osVersionEl = $('#os_version');
  if (osVersionEl) {
      osVersionEl.textContent = data.os_version || '---';
  }

  const githubUrlEl = $('#github_url');
  if (githubUrlEl) {
      githubUrlEl.href = data.github_url || '#';
      githubUrlEl.textContent = data.github_repo_name || 'GitHub Link';
  }
}
//
// メイン：ポンプボタン
//
function cycleButtonClick() {
  // オート動作の反転とする
  pump_active ^= 1;
  websocket_send({'command': pump_active ? 'pump_auto_start' : 'pump_auto_stop'});
}

//
// メイン：測定データ更新ボタン
// 　一時的なデータなので直接受け取る。websocketのbroadcastはしない。
//
function reloadButtonClick() {
  const sensors = ['air_temp', 'humidity', 'water_temp', 'water_level', 'tds_level', 'brightness'];

  //一時的に無効の色に変える
  for (let i = 0; i < sensors.length; i++) {
    const itemEl = $('#sensor_' + sensors[i]);
    if (itemEl) {
      itemEl.classList.remove("bg-success", "bg-warning", "bg-danger");
      itemEl.classList.add("bg-secondary");
    }
  }

  websocket_send({'command': 'tmp_report'});
}

//
// 時計の更新
//
function UpdateClock()
{
  const now = new Date();

  let year = now.getFullYear();
  let month = now.getMonth() + 1;
  let day = now.getDate();

  let weekdays = ["日","月","火","水","木","金","土"];
  let weekday = weekdays[now.getDay()];

  let hour = now.getHours();
  let minute = now.getMinutes();
  let second = now.getSeconds();

  let ampm = '午前';
  if (12 <= hour) {
    ampm = '午後';
    hour -= 12;
  }

  // 時計の更新
  const dateStrEl = $('#date_string');
  if (dateStrEl) dateStrEl.textContent = year + '年' + month + '月' + day + '日';
  
  const weekdayStrEl = $('#weekday_string');
  if (weekdayStrEl) weekdayStrEl.textContent = weekday + '曜日';
  
  const timeStrEl = $('#time_string');
  if (timeStrEl) timeStrEl.textContent = ampm + hour + '時' + minute + '分';

  // タイマー再設定
  let ms = (59 - second) * 1000;
  if (ms < 300)
    ms = 300;
  setTimeout(UpdateClock, ms);
}

function basicButtonClick(kind) {
  websocket_send({'command': 'post_basic', 'kind': kind});
}

//
// 定時処理の設定を「反映する」ボタン（画面の入力をサーバーへ送信）
//
function scheduleCommitClick() {
  const scheduleForm = $('#schedule_form');
  const formData = new FormData(scheduleForm);
  const data = Object.fromEntries(formData);

  // トグルスイッチ（チェックボックス）の確定処理
  // FormDataはチェックの外れているスイッチの値を送信しない性質があるため、ここで"1"または"0"を確定させます
  toggleItems.forEach(name => {
    const el = $(`input[name="${name}"]`);
    data[name] = el && el.checked ? "1" : "0";
  });

  // 時刻指定なしにしたいとき（空欄の場合は -1 に変換して送信）
  for (const item of textInputItems) {
    // フォームに存在し、かつ空文字の場合のみ -1 をセット
    if (data[item] === "")
      data[item] = "-1";
  }

  data['command'] = 'post_schedule';
  websocket_send(data);
}

//
// 定時処理の設定を「元に戻す」ボタン
// （resetではなくデータベースから取得した値に戻す必要がある）
//
function scheduleCancelClick() {
  const form = $('#schedule_form');
  if (form) form.disabled = true;
  setValueSchedule(master);
}

//
// 設定：ポンプ動作ボタン
//
function pumpButtonClick(request, seconds=0) {
  // サーバーへポンプ動作秒数を設定
  websocket_send({'command': 'pump_' + request, 'seconds': seconds});
}

function pumpStatusUpdate(seconds)
{
  // いったん停止
  clearInterval(timerIdPump);

  const pumpWorking = $('#pump_working');
  const pumpStop = $('#pump_stop');
  const pumpCountdown = $('#pump_countdown');

  if (pump_active) {
    if (pumpWorking) pumpWorking.style.display = 'block';
    if (pumpStop) pumpStop.style.display = 'none';
  } else {
    if (pumpWorking) pumpWorking.style.display = 'none';
    if (pumpStop) pumpStop.style.display = 'block';
  }

  // カウントダウン表示
  if (seconds < 0) {
    // 連続動作
    if (pumpCountdown) pumpCountdown.textContent = "連続";
  } else if (seconds == 0) {
    // 停止
    if (pumpCountdown) pumpCountdown.textContent = "停止";
  } else {
    // カウントダウン開始
    pumpCountdownStart(seconds);
  }
}

function pumpCountdownStart(seconds)
{
  const pumpCountdown = $('#pump_countdown');
  if (seconds <= 0) {
    clearInterval(timerIdPump);
    if (pumpCountdown) pumpCountdown.textContent = "";
  } else {
    // 最初の表示
    pumpCountdownPrint(seconds);

    // 終了時刻を現在時刻＋カウントダウンする秒数に設定
    let start = new Date();
    let end = new Date(start.getTime() + seconds * 1000);

    // タイマー設定
    timerIdPump = setInterval(function(){
      let now = new Date();
      let diff = (end.getTime() - now.getTime()) / 1000;
      if (diff <= 0) {
        clearInterval(timerIdPump);
        diff = 0;
      }
      pumpCountdownPrint(diff);
    }, 500);
  }
}

function pumpCountdownPrint(seconds) {
  seconds += 0.9;
  let min = parseInt(seconds / 60);
  let sec = parseInt(seconds % 60);
  if (sec < 10) {
    sec = '0' + sec;
  }
  const pumpCountdown = $('#pump_countdown');
  if (pumpCountdown) pumpCountdown.textContent = min + ":" + sec;
}

// ==========================================
// 📸 カメラ撮影UI 制御処理
// ==========================================
/**
 * [イベント] カメラ撮影ボタン・タイマーボタン・中止ボタンのクリックハンドラ
 * @param {number} seconds - 0: 今すぐ撮影, 1以上: タイマー秒数, -1: 撮影中止
 */
function cameraButtonClick(seconds) {
  // すでに動いているタイマーがあれば一旦クリアして二重起動を防ぐ
  cameraCountdownStop();
  
  const pictureSaveButtons = $('#picture_save_buttons');
  const countdownNumber = $('#countdown_number');
  const cameraSpinner = $('#camera_spinner');
  
  // 新しい撮影動作が始まったため、古い写真の「保存/破棄」ボタンは非表示にする
  if (pictureSaveButtons) pictureSaveButtons.style.display = 'none';
  
  // 💡 操作開始時はスピナーを一律で非表示にする
  if (cameraSpinner) cameraSpinner.style.display = 'none';

  if (seconds < 0) {
    // 【中止】カウントダウンの数字を消去
    if (countdownNumber) countdownNumber.textContent = "";
  } else if (seconds === 0) {
    // 【今すぐ】数字を消去して即座にサーバーへ撮影リクエスト
    if (countdownNumber) countdownNumber.textContent = "";
    takePicture();
  } else {
    // 【タイマー撮影】最初の秒数をセットしてカウントダウンを開始
    if (countdownNumber) countdownNumber.textContent = seconds;
    cameraCountdownStart(seconds);
  }
}

/**
 * 指定された秒数からカウントダウンタイマーを開始する
 * @param {number} seconds - タイマー秒数
 */
function cameraCountdownStart(seconds) {
  const countdownNumber = $('#countdown_number');

  if (seconds <= 0) {
    cameraCountdownStop();
    if (countdownNumber) countdownNumber.textContent = "";
  } else {
    // 最初の数字を画面に描画
    cameraCountdownPrint(seconds);

    // ミリ秒単位のズレを吸収するため、現在時刻を基準に正確な「終了時刻」を算出
    let start = new Date();
    let end = new Date(start.getTime() + seconds * 1000);

    // 0.5秒（500ms）周期で残り時間を監視
    timerIdCamera = setInterval(function(){
      let now = new Date();
      let diff = (end.getTime() - now.getTime()) / 1000;

      // 画面上の数字を更新
      cameraCountdownPrint(diff);

      // 残り時間が0以下になったらタイマーを止めて撮影リクエストを送信
      if (diff <= 0) {
        cameraCountdownStop();
        takePicture();
      }
    }, 500);
  }
}

/**
 * カウントダウンタイマーを強制停止する
 */
function cameraCountdownStop() {
  if (typeof timerIdCamera !== 'undefined') {
    clearInterval(timerIdCamera);
  }
}

/**
 * 残り秒数を整数に切り上げて画面上にパッと美しく表示する（最大60秒制限）
 * @param {number} seconds - 小数点を含む残り秒数
 */
function cameraCountdownPrint(seconds) {
  // ユーザーの体感に合わせるため 0.9秒 を足して繰り上げ処理を行う
  seconds += 0.9;
  let sec = parseInt(seconds % 60);
  if (60 < sec) {
    sec = 60;  /* 最大60秒でクリップ */
  }

  const countdownNumber = $('#countdown_number');
  const cameraSpinner = $('#camera_spinner');
  
  // 💡 数字を描画するときはスピナーを確実に隠し、数字用の枠に値を入れます
  if (cameraSpinner) cameraSpinner.style.display = 'none';
  if (countdownNumber) countdownNumber.textContent = sec;
}

/**
 * サーバー（Flask-SocketIO）へ撮影コマンドを送信する
 */
function takePicture() {
  const countdownNumber = $('#countdown_number');
  const cameraSpinner = $('#camera_spinner');
  
  // 💡 カウントダウンの文字を消去し、用意してあるスピナーをインライン要素として出現させます
  if (countdownNumber) countdownNumber.textContent = '';
  if (cameraSpinner) cameraSpinner.style.display = 'inline-block';

  // WebSocketで撮影リクエストを送信
  websocket_send({'command': 'tmp_picture'});
}

/**
 * [イベント] 撮影された一時写真の保存、または破棄ボタンのクリックハンドラ
 * @param {boolean} needed - true: 保存する, false: 破棄（削除）する
 */
function saveButtonClick(needed) {
  const pictureSaveButtons = $('#picture_save_buttons');

  if (needed) {
    // 【保存】一時保存された写真を本番保存フォルダへ移動するコマンドを送信
    websocket_send({
      'command': 'save_picture', 
      'tmp_picture_name': master['tmp_picture_name'],
      'tmp_picture_path': master['tmp_picture_path'], 
      'tmp_picture_taken': master['tmp_picture_taken']
    });
  } else {
    // 【破棄】一時保存されたファイルをディスクから物理削除するコマンドを送信
    websocket_send({'command': 'delete_picture', 'tmp_picture_path': master['tmp_picture_path']});

    // 画面にプレビュー表示されていた背景画像を消去し、初期テキストに戻す
    const tmpPictureFrame = $('#tmp_picture_frame');
    const tmpPictureTimestamp = $('#tmp_picture_timestamp');
    if (tmpPictureFrame) tmpPictureFrame.style.backgroundImage = '';
    if (tmpPictureTimestamp) tmpPictureTimestamp.textContent = 'no data';
  }

  // 処理が完了したため、保存/破棄ボタンを再び隠す
  if (pictureSaveButtons) pictureSaveButtons.style.display = 'none';
}

//
// センサー閾値の設定を「反映する」ボタン
//
function limitCommitClick() {
  const sensorForm = $('#sensor_limit_form');
  const formData = new FormData(sensorForm);
  const data = Object.fromEntries(formData);

  data['command'] = 'post_sensor_limit';
  websocket_send(data);
}

//
// センサー閾値の設定を「元に戻す」ボタン
// （resetではなくデータベースから取得した値に戻す必要がある）
//
function limitCancelClick() {
  const form = $('#sensor_limit_form');
  if (form) form.disabled = true;
  setValueSensorLimit(master);
}

//
// 結果ポップアップ表示
//
function showModalResult(data)
{
  const modalResult = $('#modal_result');
  const modalMessage = $('#modal_message');
  const modalDatetime = $('#modal_datetime');
  
  if (modalResult) modalResult.textContent = data['result'];
  if (modalMessage) modalMessage.textContent = data['message'];
  if (modalDatetime) modalDatetime.textContent = data['datetime'];
  
  // Bootstrap 5 のモーダル制御（jQuery不要形式）
  const confirmModalEl = $('#confirmModal');
  if (confirmModalEl) {
    const modalInstance = bootstrap.Modal.getInstance(confirmModalEl) || new bootstrap.Modal(confirmModalEl);
    modalInstance.show();
  }
}

/**
 * すべてのタブの表示・非表示イベントを一括して管理する汎用ハンドラー
 */
function initTabEventHandlers() {
  // 1. タブが表示された瞬間のイベント
  document.addEventListener('shown.bs.tab', (event) => {
    const activatedTab = event.target;
    if (!activatedTab) return;

    const href = activatedTab.getAttribute('href');

    // ① バージョンタブが開かれた場合
    if (href === '#pane_version') {
      startCpuAutoUpdate();
    }
    // ② 💥 レポート確認タブが開かれた場合
    else if (href === '#pane_report_check') {
      // グラフがまだ生成されていない、またはキャッシュが空なら自動で「今日」のデータを要求
      if (!reportChartInstance || rawReportsCache.length === 0) {
        requestTodayReports();
      }
    }
  });

  // 2. 他のタブに切り替わって隠れた瞬間のイベント
  document.addEventListener('hidden.bs.tab', (event) => {
    const deactivatedTab = event.target;
    if (!deactivatedTab) return;

    const href = deactivatedTab.getAttribute('href');

    // ① バージョンタブから離脱した場合
    if (href === '#pane_version') {
      stopCpuAutoUpdate();
    }
  });
}
/**
 * CPU温度の自動定期更新を開始する
 */
function startCpuAutoUpdate() {
  // 既存のタイマーがあれば一度クリア（二重起動防止）
  if (timerIdCpuTemp) {
    clearInterval(timerIdCpuTemp);
  }

  // CPU 再開ボタンは常時表示にする（表示/非表示操作は行わない）

  // 表示された瞬間にまず1回最新値をリクエスト
  requestCpuTemperature();

  // 1分(60000ミリ秒)ごとに繰り返し実行
  timerIdCpuTemp = setInterval(function() {
    requestCpuTemperature();
  }, 60000);
}

/**
 * CPU温度の自動定期更新を完全に停止する（新規追加）
 */
function stopCpuAutoUpdate() {
  if (timerIdCpuTemp) {
    clearInterval(timerIdCpuTemp);
    timerIdCpuTemp = null;
  }
}

/**
 * サーバーへCPU温度をリクエストする
 */
function requestCpuTemperature() {
  try {
    websocket_send({'command': 'get_cpu_temperature'});
    const cpuTempEl = $('#cpu_temperature');
    if (cpuTempEl) {
      cpuTempEl.textContent = "-- ℃";
    }
  } catch (e) {
    handleCpuUpdateError();
  }
}

/**
 * 「再開」ボタンが押されたときに自動更新をリトライする関数
 */
function retryCpuUpdate() {
  startCpuAutoUpdate();
}

/**
 * 通信エラーなど、更新が失敗したときの処理
 */
function handleCpuUpdateError() {
  printDebugMessage("CPU温度の取得に失敗しました。通信状態を確認してください。");
  // エラー時もタイマーを安全に止める
  stopCpuAutoUpdate();
}
//
// デバッグ：サーバーへリクエストを送ってLEDをON/OFFするテスト
//
function ledButtonClick(color) {
  websocket_send({'command': 'set_led', 'color': color});
}

//
// デバッグ：センサーひとつの値取得
//
function debugButtonMeasure(sensor_kind) {
  websocket_send({'command': 'measure_sensor', 'sensor_kind': sensor_kind});
}

//
// デバッグ：サブポンプ動作
//
function subPumpButtonClick(request, trigger="none") {
  websocket_send({'command': 'subpump_' + request, 'trigger': trigger});
}

// 📊 グラフ・キャッシュ制御用グローバル変数
let reportChartInstance = null;
let rawReportsCache = [];     // 選択された1日分の生データ
let currentDisplayDate = "";  // 現在表示中の日付 (YYYY-MM-DD)

// 💡 拡張：カレンダーキャッシュオブジェクト（最大7日分）
let reportDateCacheMap = {};
const MAX_CACHE_DAYS = 7; // これを超えたら古いキャッシュから自動削除

// 各項目の設定（表示名、単位、カラー、初期表示状態）
const TARGET_FIELDS = {
  air_temp:       { label: '気温', unit: '℃', color: 'rgb(255, 90, 110)', defaultShow: true },    // 赤
  humidity:       { label: '湿度', unit: '%',  color: 'rgb(75, 192, 192)',  defaultShow: true },    // 青
  water_temp:     { label: '水温', unit: '℃', color: 'rgb(54, 142, 235)', defaultShow: true },    // 青緑
  water_pressure: { label: '水圧', unit: 'V',  color: 'rgb(255, 140, 64)',  defaultShow: false },   // 橙（初期OFF）
  water_level:    { label: '水位', unit: '%',  color: 'rgb(153, 102, 255)', defaultShow: true },   // 紫（初期OFF）
  tds_volt:       { label: 'EC電圧', unit: 'V',  color: 'rgb(255, 140, 160)', defaultShow: false },   // ピンク（初期OFF）
  tds_level:      { label: 'EC値', unit: 'ms/cm', color: 'rgb(255, 205, 86)', defaultShow: true },  // 緑
  brightness:     { label: '照度', unit: 'lx', color: 'rgb(201, 203, 207)', defaultShow: true },   // 灰（初期OFF）
  water_pulses:   { label: '水流パルス', unit: '回', color: 'rgb(60, 139, 34)', defaultShow: false } // 黄（初期OFF）
};

/**
 * 💡 修正：今日を割り出すためのヘルパー関数
 */
function getTodayString() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * 今日のレポートを要求する
 */
function requestTodayReports() {
  currentDisplayDate = getTodayString(); // バグのない正確な今日の日付文字列を格納
  refreshCurrentDateReports();
  updateDateButtonsState();
}

/**
 * UI: カレンダー横の「強制再読み込み」ボタンから呼ばれる
 */
function forceReloadReports() {
  const dateEl = $('#txt_report_date');
  if (dateEl) {
    if (dateEl.tagName === 'INPUT') currentDisplayDate = dateEl.value || getTodayString();
  }
  refreshCurrentDateReports(true);
}

/**
 * 💡 修正：サーバーへデータを要求する関数（今日だけキャッシュをスルーする仕様）
 */
function refreshCurrentDateReports(force = false) {
  if (!currentDisplayDate) return;

  const todayStr = getTodayString();

  // もし force でない（通常）かつキャッシュにデータが存在すれば、サーバーへ通信せず即座に描画
  if (!force && currentDisplayDate !== todayStr && reportDateCacheMap[currentDisplayDate]) {
    printDebugMessage(`[Cache Hit] 過去データのため、${currentDisplayDate} をキャッシュから展開します。`);

    // キャッシュ展開時にも、画面上の日付テキスト表示領域を確実に更新する
    const dateEl = $('#txt_report_date');
    if (dateEl) {
      if (dateEl.tagName === 'INPUT') dateEl.value = currentDisplayDate; else dateEl.textContent = currentDisplayDate;
    }

    rawReportsCache = reportDateCacheMap[currentDisplayDate].reports;
    initOrUpdateChart();
    return;
  }

  // 今日であるか、キャッシュがない場合、または force=true の場合は必ずサーバーへ最新データを要求
  const logPrefix = (currentDisplayDate === todayStr) ? "[Network - Today最新]" : "[Network]";
  printDebugMessage(`${logPrefix} ${currentDisplayDate} のグラフデータをサーバーに要求中... (force=${force})`);

  websocket_send({
    command: 'get_report_by_date',
    date: currentDisplayDate
  });
}

/**
 * 日付を1日前後させる（今日より未来へは進ませない仕様）
 */
function moveDate(days) {
  if (!currentDisplayDate) return;

  // 1. 文字列からDateオブジェクトを作成して日付を加算・減算
  const d = new Date(currentDisplayDate);
  d.setDate(d.getDate() + days);

  // 2. 加算後の日付を YYYY-MM-DD 文字列に変換
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const nextDateStr = `${year}-${month}-${day}`;

  // 3. 💥 未来ブロック判定：もし計算結果が「今日の日付」より未来だったら処理を拒否
  const todayStr = getTodayString();
  if (nextDateStr > todayStr) {
    printDebugMessage("明日以降のレポートデータは存在しないため移動できません。");
    return;
  }

  // 4. 未来でなければ日付を更新して読み込み
  currentDisplayDate = nextDateStr;
  refreshCurrentDateReports();

  // 5. ボタンの見た目の制御を呼び出す
  updateDateButtonsState();
}

/**
 * 現在の日付に応じて「翌日 ▶」ボタンの有効・無効を自動で切り替える補助関数
 */
function updateDateButtonsState() {
  const nextBtn = $('#btn_report_next');
  if (!nextBtn) return;

  const todayStr = getTodayString();

  if (currentDisplayDate === todayStr) {
    // 💥 現在表示しているのが「今日」なら、翌日ボタンを半透明にしてクリック不能にする
    nextBtn.disabled = true;
    nextBtn.style.opacity = '0.4';
    nextBtn.style.cursor = 'not-allowed';
  } else {
    // 過去データを見ている時は、通常通りクリック可能にする
    nextBtn.disabled = false;
    nextBtn.style.opacity = '1.0';
    nextBtn.style.cursor = 'pointer';
  }
}

/**
 * グラフ描画コア関数（0:00〜23:00固定枠 ＆ アラート背景バグ修正 ＆ 1行統計連動版）
 */
function initOrUpdateChart() {
  const MAX_INTERPOLATE_GAPS = 2; // 飛ばすことが可能な点の数（3つ以上空いたら自動で切る）

  const ctx = $('#reportChart');
  if (!ctx) return;

  // グローバルフォント設定を大きくする（全グラフ要素に適用）
  Chart.defaults.font.size = 14;
  Chart.defaults.font.weight = '500';

  // 各項目の最小・最大値の基準範囲、実際の値がこれをはみ出したらグラフのスケールを自動調整する
  const minMaxRef = {
    air_temp: { min: 15, max: 40 },
    humidity: { min: 0, max: 100 },
    water_temp: { min: 15, max: 40 },
    water_pressure: { min: 0, max: 1.3 },
    water_level: { min: 0, max: 100 },
    tds_volt: { min: 1, max: 3 },
    tds_level: { min: 0, max: 4 },
    brightness: { min: 0, max: 4000 },
    water_pulses: { min: 0, max: 2000 }
  };

  // 1. 各項目の過去24時間における最小・最大値を計算（生データ全体から抽出）
  const minMaxMap = {};
  Object.keys(TARGET_FIELDS).forEach(field => {
    const values = rawReportsCache.map(r => r[field]).filter(v => v !== null && v !== undefined);
    if (values.length > 0) {
      const min = Math.min(...values, minMaxRef[field].min);
      const max = Math.max(...values, minMaxRef[field].max);
      minMaxMap[field] = { min: min, max: max === min ? max + 1 : max };
    } else {
      minMaxMap[field] = { min: 0, max: 100 };
    }
  });


  // 2. 0:00 〜 24:00 の25コマの固定スロットを生成
  const fixedLabels = [];
  const fixedReports24 = [];
  const statusTimeline = [];

  for (let hour = 0; hour <= 24; hour++) {
    const hourStr = String(hour).padStart(2, '0');
    
    // 💡 表示用ラベルの設定
    const displayLabel = (hour === 24) ? "24:00" : `${hourStr}:00`;
    fixedLabels.push(displayLabel);

    // 💡 サーバーから display_time = "24:00"（またはその時間のデータ）が降ってくるので、一発で検索できます
    const searchStr = (hour === 24) ? "24:00" : `${hourStr}:`;
    const found = rawReportsCache.find(r => r.display_time && r.display_time.startsWith(searchStr));

    if (found) {
      fixedReports24.push(Object.assign({ _isInterpolated: {} }, found));
      statusTimeline.push(found.total_status || 'success');
    } else {
      const emptyReport = { total_status: 'success', _isInterpolated: {} };
      Object.keys(TARGET_FIELDS).forEach(field => { emptyReport[field] = null; });
      fixedReports24.push(emptyReport);
      statusTimeline.push('success');
    }
  }

  // 3. 指定された数（MAX_INTERPOLATE_GAPS）までのデータ欠損を自動線形補間するロジック
  Object.keys(TARGET_FIELDS).forEach(field => {
    for (let i = 0; i <= 24; i++) {
      if (fixedReports24[i][field] === null || fixedReports24[i][field] === undefined) {

        // ① 直前の有効なデータ（左側）を探す
        let leftIdx = -1;
        for (let l = i - 1; l >= 0; l--) {
          if (fixedReports24[l][field] !== null && fixedReports24[l][field] !== undefined && !fixedReports24[l]._isInterpolated?.[field]) {
            leftIdx = l;
            break;
          }
        }

        // ② 直後の有効なデータ（右側）を探す
        let rightIdx = -1;
        for (let r = i + 1; r < 24; r++) {
          if (fixedReports24[r][field] !== null && fixedReports24[r][field] !== undefined && !fixedReports24[r]._isInterpolated?.[field]) {
            rightIdx = r;
            break;
          }
        }

        // ③ 両側にデータが見つかり、かつその隙間が指定数以内の場合のみ埋める
        if (leftIdx !== -1 && rightIdx !== -1) {
          const gapSize = rightIdx - leftIdx - 1;

          if (gapSize <= MAX_INTERPOLATE_GAPS) {
            const leftVal = fixedReports24[leftIdx][field];
            const rightVal = fixedReports24[rightIdx][field];

            // 線形補間（前後の値から均等に配分）
            const interpolatedValue = leftVal + (rightVal - leftVal) * ((i - leftIdx) / (rightIdx - leftIdx));
            fixedReports24[i][field] = interpolatedValue;
            fixedReports24[i]._isInterpolated[field] = true;
          }
        }
      }
    }
  });

  // 4. 横書き1行のコンパクトな統計枠（上部）への、気温・水温範囲の同期書き込み
  const validAirTemps = [];
  const validWaterTemps = [];

  fixedReports24.forEach(r => {
    // 自動補間されたデータは統計値（最高・最低）から除外して純粋な測定値だけで集計する
    if (r.air_temp !== null && r.air_temp !== undefined && !r._isInterpolated?.air_temp) {
      validAirTemps.push(r.air_temp);
    }
    if (r.water_temp !== null && r.water_temp !== undefined && !r._isInterpolated?.water_temp) {
      validWaterTemps.push(r.water_temp);
    }
  });

  // ① 気温範囲「最小 〜 最大 ℃」の更新
  const tempRangeEl = $('#stat_temp_range');
  if (tempRangeEl) {
    if (validAirTemps.length > 0) {
      const min = Math.min(...validAirTemps).toFixed(1);
      const max = Math.max(...validAirTemps).toFixed(1);
      tempRangeEl.textContent = `${min} 〜 ${max} ℃`;
    } else {
      tempRangeEl.textContent = `--.- 〜 --.- ℃`;
    }
  }

  // ② 水温範囲「最小 〜 最大 ℃」の更新
  const wtempRangeEl = $('#stat_wtemp_range');
  if (wtempRangeEl) {
    if (validWaterTemps.length > 0) {
      const min = Math.min(...validWaterTemps).toFixed(1);
      const max = Math.max(...validWaterTemps).toFixed(1);
      wtempRangeEl.textContent = `${min} 〜 ${max} ℃`;
    } else {
      wtempRangeEl.textContent = `--.- 〜 --.- ℃`;
    }
  }


  // 5. 各データセットの組み立て（水位の不定期プロット ＆ その他センサーの分離マッピング）
  const datasets = Object.keys(TARGET_FIELDS).map(field => {
    const config = TARGET_FIELDS[field];
    const mm = minMaxMap[field];

    // 現在表示中の日付に紐づく給水記録アレイをキャッシュから取得
    const currentRefillLogs = reportDateCacheMap[currentDisplayDate]?.refills || [];

    // 💧 水位（water_level）の場合：不定期な給水前後の点を時間の隙間に正確にマージする
    if (field === 'water_level') {
      let mixedTimeline = [];

      // A. 定期レポート25コマ分を小数点インデックス座標（0.0 〜 24.0）としてプッシュ
      fixedReports24.forEach((r, idx) => {
        if (r[field] !== null && r[field] !== undefined) {
          const normalized = ((r[field] - mm.min) / (mm.max - mm.min)) * 100;
          mixedTimeline.push({
            x: parseFloat(idx),
            displayTime: `${String(idx).padStart(2, '0')}:00`,
            y: normalized,
            rawValue: r[field],
            status: r[`${field}_status`] || 'success',
            isInterpolated: !!r._isInterpolated?.[field],
            refillType: 'none'
          });
        }
      });

      // B. 給水ログを、時間の隙間の小数点座標に換算して割り込ませる
      currentRefillLogs.forEach(log => {
        if (log.time_before && log.time_before.includes(':') && log.level_before !== null && log.level_before !== undefined) {
          const parts = log.time_before.split(':');
          const xPos = parseInt(parts[0], 10) + (parseInt(parts[1], 10) / 60);
          const yPos = ((log.level_before - mm.min) / (mm.max - mm.min)) * 100;
          mixedTimeline.push({
            x: xPos, displayTime: log.time_before, y: yPos, rawValue: log.level_before,
            status: 'success', isInterpolated: false, refillType: 'before'
          });
        }
        if (log.time_after && log.time_after.includes(':') && log.level_after !== null && log.level_after !== undefined) {
          const parts = log.time_after.split(':');
          const xPos = parseInt(parts[0], 10) + (parseInt(parts[1], 10) / 60);
          const yPos = ((log.level_after - mm.min) / (mm.max - mm.min)) * 100;
          mixedTimeline.push({
            x: xPos, displayTime: log.time_after, y: yPos, rawValue: log.level_after,
            status: 'success', isInterpolated: false, refillType: 'after'
          });
        }
      });

      // C. 時間の数値（0.0 〜 23.99）の順に、確実にソート（これでV字に線が繋がります）
      mixedTimeline.sort((a, b) => a.x - b.x);

      const pointStyles = [];
      const pointRadii = [];
      const pointBgColors = [];
      const statusArray = [];
      const finalRawValues = [];
      const chartDataPoints = [];
      const isInterpolatedArray = [];
      const displayTimesArray = [];
      const refillTypesArray = []; // 💡 給水種別をストック

      mixedTimeline.forEach(pt => {
        chartDataPoints.push({ x: pt.x, y: pt.y }); // 💥 [{x: 16.066, y: 15.3}, ...] のオブジェクト形式
        statusArray.push(pt.status);
        finalRawValues.push(pt.rawValue);
        isInterpolatedArray.push(pt.isInterpolated);
        displayTimesArray.push(pt.displayTime);
        refillTypesArray.push(pt.refillType);

        if (pt.refillType === 'before') {
          pointStyles.push('rect'); pointRadii.push(5); pointBgColors.push('#ffffff');
        } else if (pt.refillType === 'after') {
          pointStyles.push('rect'); pointRadii.push(5); pointBgColors.push(config.color);
        } else if (pt.isInterpolated) {
          pointStyles.push('circle'); pointRadii.push(0); pointBgColors.push(config.color);
        } else if (pt.status === 'danger') {
          pointStyles.push('crossRot'); pointRadii.push(6); pointBgColors.push(config.color);
        } else if (pt.status === 'warning') {
          pointStyles.push('triangle'); pointRadii.push(4); pointBgColors.push(config.color);
        } else {
          pointStyles.push('circle'); pointRadii.push(2); pointBgColors.push(config.color);
        }
      });

      return {
        label: config.label,
        xAxisID: 'x_time', // 💥重要：水位だけは、新設する「数値用のx_time軸」に紐付ける！
        borderColor: config.color,
        backgroundColor: config.color,
        tension: 0,
        hidden: !config.defaultShow,
        data: chartDataPoints,
        rawValues: finalRawValues,
        pointStyle: pointStyles,
        pointRadius: pointRadii,
        pointHoverRadius: 10,
        pointBackgroundColor: pointBgColors,
        pointBorderColor: config.color,
        pointBorderWidth: 2,
        itemStatuses: statusArray,
        isInterpolatedArray: isInterpolatedArray,
        displayTimesArray: displayTimesArray,
        refillTypes: refillTypesArray,

        segment: {
          borderDash: (ctx) => {
            const idx0 = ctx.p0.$context ? ctx.p0.$context.dataIndex : ctx.p0.index;
            const idx1 = ctx.p1.$context ? ctx.p1.$context.dataIndex : ctx.p1.index;

            const r0 = fixedReports24[idx0];
            const r1 = fixedReports24[idx1];

            const p0Interpolated = r0?._isInterpolated?.[field];
            const p1Interpolated = r1?._isInterpolated?.[field];

            // 始点か終点どちらかが補間値なら、3px描いて3px空ける細かい点線にする
            if (p0Interpolated || p1Interpolated) {
              return [3, 3]; // [3, 3] 配列を直接返す
            }
            return undefined; // 通常データ間は実線
          }
        },
        spanGaps: false
      };
    }

    // 📊 水位以外のその他すべてのセンサー（気温、湿度、EC値など）：これまで通りの24コマ固定
    else {
      const rawValues = fixedReports24.map(r => r[field]);
      const normalizedValues = rawValues.map(v => {
        if (v === null || v === undefined) return null;
        return ((v - mm.min) / (mm.max - mm.min)) * 100;
      });

      const pointStyles = [];
      const pointRadii = [];
      const pointBgColors = [];
      const statusArray = [];

      fixedReports24.forEach((r) => {
        const itemStatus = r[`${field}_status`] || 'success';
        statusArray.push(itemStatus);
        const isInterpolated = r._isInterpolated?.[field];

        if (isInterpolated) {
          pointStyles.push('circle'); pointRadii.push(0); pointBgColors.push(config.color);
        } else if (itemStatus === 'danger') {
          pointStyles.push('crossRot'); pointRadii.push(6); pointBgColors.push(config.color);
        } else if (itemStatus === 'warning') {
          pointStyles.push('triangle'); pointRadii.push(4); pointBgColors.push(config.color);
        } else {
          pointStyles.push('circle'); pointRadii.push(2); pointBgColors.push(config.color);
        }
      });

      return {
        label: config.label,
        borderColor: config.color,
        backgroundColor: config.color,
        tension: 0,
        hidden: !config.defaultShow,
        data: normalizedValues,
        rawValues: rawValues,

        pointStyle: pointStyles,
        pointRadius: pointRadii,
        pointHoverRadius: 9,
        pointBackgroundColor: pointBgColors,
        pointBorderColor: config.color,
        pointBorderWidth: 2,

        itemStatuses: statusArray,

        // 文字や空欄ではなく、[3, 3] という数値配列を直接返却します
        segment: {
          borderDash: (ctx) => {
            const idx0 = ctx.p0.$context ? ctx.p0.$context.dataIndex : ctx.p0.index;
            const idx1 = ctx.p1.$context ? ctx.p1.$context.dataIndex : ctx.p1.index;

            const r0 = fixedReports24[idx0];
            const r1 = fixedReports24[idx1];

            const p0Interpolated = r0?._isInterpolated?.[field];
            const p1Interpolated = r1?._isInterpolated?.[field];

            // 始点か終点どちらかが補間値なら、3px描いて3px空ける細かい点線にする
            if (p0Interpolated || p1Interpolated) {
              return [3, 3]; // [3, 3] 配列を直接返す
            }
            return undefined; // 通常データ間は実線
          }
        }
      };
    }
  });

  // 6. 既存グラフインスタンスの安全な破棄と再生成
  if (reportChartInstance) {
    reportChartInstance.destroy();
    reportChartInstance = null;
  }

  reportChartInstance = new Chart(ctx, {
    type: 'line',
    data: { labels: fixedLabels, datasets: datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { left: 5, right: 15, top: 10, bottom: 10 } },
      scales: {
        // Y軸：共通の割合軸（0〜100%）
        y: {
          min: 0,
          max: 100,
          title: { display: true, text: '最小〜最大間の割合(%)', font: { size: 15, weight: 'bold' } }
        },
        // X軸①：通常センサー用の「文字（カテゴリー）」軸
        x: {
          type: 'category', // 文字モード
          bounds: 'data',
          ticks: { font: { size: 14, weight: '500' } }
        },
        // X軸②：水位データが中間の時間にプロットするための「裏方数値」軸
        x_time: {
          type: 'linear',   // 数値モード
          min: 0,           // 0:00
          max: 24,          // 24:00（横軸のLabels配列の最大インデックスと完全に合わせる）
          display: false,   // 画面上には目盛りを非表示にしてスッキリさせる（裏で位置計算だけさせる）
        }
      },
      plugins: {
        legend: { display: true, position: 'top', labels: { boxWidth: 14, padding: 12, font: { size: 14, weight: '600' } } },
        tooltip: {
          callbacks: {
            // 💡 1行目のタイトル（時刻文字列）のカスタム制御
            title: function(context) {
              if (!context || context.length === 0) return '';
              const ctxObj = context[0];
              const rIdx = ctxObj.dataIndex;

              // dataset が無ければフォールバックでチャート内の対応するデータセットを参照
              const ds = ctxObj.dataset || reportChartInstance.data.datasets[ctxObj.datasetIndex];

              // 時刻ラベルは displayTimesArray が優先、それ以外は軸ラベルを使用
              const timeLabel = (ds && ds.displayTimesArray && ds.displayTimesArray[rIdx]) ? ds.displayTimesArray[rIdx] : (ctxObj.label || '');

              // アイコン付与ロジック（給水／ステータス）をインラインで処理
              let note = '';
              if (ds && ds.refillTypes && ds.refillTypes[rIdx]) {
                const rt = ds.refillTypes[rIdx];
                if (rt === 'before') note = ' ⛽給水開始';
                else if (rt === 'after') note = ' 🏁給水終了';
              } else {
                const st = ds && ds.itemStatuses ? ds.itemStatuses[rIdx] : null;
                if (st === 'danger') note = ' 🚨危険';
                else if (st === 'warning') note = ' ⚠️警告';
              }
              return timeLabel + note;
            },

            // 💡 2行目の数値テキスト表示のカスタム制御
            label: function(context) {
              const datasetLabel = context.dataset.label;
              const dIdx = context.datasetIndex;
              const rIdx = context.dataIndex;

              const dataset = reportChartInstance.data.datasets[dIdx];
              const rawData = dataset.rawValues[rIdx];
              const fieldKey = Object.keys(TARGET_FIELDS).find(k => TARGET_FIELDS[k].label === datasetLabel);
              const unit = fieldKey ? TARGET_FIELDS[fieldKey].unit : '';

              if (rawData === null || rawData === undefined) return `${datasetLabel}: データなし`;

              // 2行目は「値（Δ差分）」の一定書式にする
              const dec = (fieldKey === 'tds_level') ? 2 : 1;
              const valueStr = `${rawData.toFixed(dec)} ${unit}`;

              // 差分表示：1つ前のデータとの差分を計算（rIdx が 0 の場合は差分表示なし）
              let deltaStr = '';
              if (rIdx > 0) {
                const prevRaw = dataset.rawValues[rIdx - 1];
                if (prevRaw !== null && prevRaw !== undefined) {
                  const delta = rawData - prevRaw;
                  const sign = delta >= 0 ? '+' : '';
                  deltaStr = ` (${sign}${delta.toFixed(dec)})`;
                }
              }

              // 補間フラグがある場合は注釈を末尾に付ける（括弧ではない）
              let interpolatedNote = '';
              let isInterpolated = false;
              if (fieldKey === 'water_level' && dataset.isInterpolatedArray) {
                isInterpolated = dataset.isInterpolatedArray[rIdx];
              } else {
                isInterpolated = !!fixedReports24[rIdx]?._isInterpolated?.[fieldKey];
              }
              if (isInterpolated) interpolatedNote = ' ※自動補間';

              return `${datasetLabel}: ${valueStr}${deltaStr}${interpolatedNote}`;
            }
          },
          titleFont: { size: 15, weight: 'bold' },
          bodyFont: { size: 14, weight: '500' }
        }
      }
    },
    // 💡 7. 各時間のステータスに応じた背景アラートの描画（しきい値オーバー時間帯を薄い赤/黄の帯で塗る）
    plugins: [{
      id: 'alertBackground',
      beforeDatasetsDraw: (chart) => {
        const { ctx, chartArea } = chart;
        if (!chartArea || statusTimeline.length === 0) return;
        const count = 25;
        const columnWidth = chartArea.width / (count - 1 || 1);
        ctx.save();
        for (let i = 0; i < count; i++) {
          const status = statusTimeline[i];
          if (status === 'danger' || status === 'warning') {
            ctx.fillStyle = (status === 'danger') ? 'rgba(255, 0, 0, 0.08)' : 'rgba(255, 215, 0, 0.12)';
            const left = chartArea.left + (i - 0.5) * columnWidth;
            const drawLeft = Math.max(left, chartArea.left);
            const drawWidth = Math.min(left + columnWidth, chartArea.right) - drawLeft;
            if (drawWidth > 0) ctx.fillRect(drawLeft, chartArea.top, drawWidth, chartArea.height);
          }
        }
        ctx.restore();
      }
    }]
  });
}

//
// デバッグ：汎用動作テスト
//
function debugButtonExec(debug_request="debug_echo", option="none", extra="none") {
  websocket_send({'command': debug_request, 'option': option, 'extra': extra});
}
//
// デバッグ：時間区分の変更
//
function debugTimeSpan() {
  const minuteStart = $('input[name="minute_start"]');
  const minuteStop = $('input[name="minute_stop"]');
  const minuteRefill = $('input[name="minute_refill"]');

  const data = {
    'command': 'debug_time_span',
    "minute_start": minuteStart ? minuteStart.value : "",
    "minute_stop": minuteStop ? minuteStop.value : "",
    "minute_refill": minuteRefill ? minuteRefill.value : ""
  };
  websocket_send(data);
}

//
// デバッグ：メッセージ表示
//
function printDebugMessage(message)
{
  const debugMessage = $('#debug_message');
  if (debugMessage) {
    debugMessage.value = debugMessage.value + message + '\n';
    debugMessage.scrollTop = debugMessage.scrollHeight;
  }
}

//
// デバッグ：メッセージクリア
//
function clearMessageClick() {
  const debugMessage = $('#debug_message');
  if (debugMessage) debugMessage.value = '';
}

