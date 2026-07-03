import logging
import os
import random
import time
from datetime import datetime
from gpiozero import OutputDevice, PWMOutputDevice, Button, Device
import logging

logger = logging.getLogger(__name__)

# 💡 1. フラグと、Ubuntu（開発環境）用のダミーを定義
IS_HARDWARE_OK = False

class DummyW1ThermSensor:
    pass

class DummyOutputDevice:
    def __init__(self, pin=None, **kwargs):
        self.pin = pin
        self._value = 0.0

    def on(self):
        pass

    def off(self):
        pass

    @property
    def is_active(self):
        return False

    @property
    def value(self):
        return self._value

    @value.setter
    def value(self, value):
        self._value = value


class DummyPWMOutputDevice(DummyOutputDevice):
    pass


class DummyButton:
    def __init__(self, pin=None, **kwargs):
        self.pin = pin

    @property
    def is_active(self):
        return False


class DummyNeoPixel:
    def __getitem__(self, index):
        return (0, 0, 0)

    def __setitem__(self, index, value):
        pass


# 💡 2. ラズパイ実機でのみ、実際のライブラリを一括インポート
if os.path.exists("/proc/device-tree/model"):
    try:
        # 先回りインポートで gevent との衝突（デッドロック）を完全に防ぎます
        import lgpio
        _ = lgpio.__name__  # VSCodeの「使われていないインポート警告」を消すためのハック
        
        import board
        import busio
        from w1thermsensor import W1ThermSensor, Sensor
        import adafruit_ads1x15.ads1115 as ADS
        from adafruit_ads1x15.analog_in import AnalogIn
        from adafruit_bme280 import basic as adafruit_bme280
        import adafruit_veml7700
        import neopixel
        # この段階では logging の初期化前である可能性が高いため、確実に出る print を使用
        print("Running on Raspberry Pi. Hardware libraries loaded successfully.")
        IS_HARDWARE_OK = True

    except Exception as e:
        print(f"Failed to load hardware libraries on Raspberry Pi: {e}")
        IS_HARDWARE_OK = False
        W1ThermSensor = DummyW1ThermSensor
else:
    # Ubuntuなどの開発環境では実機ライブラリをロードせず、ダミーを割り当て
    IS_HARDWARE_OK = False
    W1ThermSensor = DummyW1ThermSensor


# 💡 3. app.py の冒頭で呼び出すための案内用関数
def load_hardware_libraries(silent=True):
    """
    app.pyの冒頭で gevent パッチ前に安全先読みさせるためのトリガー関数。
    このファイルがロードされた時点でインポート自体は完了しているため、
    呼び出されたときは進捗ログを表示するだけの役割になります。
    """
    if IS_HARDWARE_OK and not silent:
        print("⚡ [Hardware] すべてのハードウェアライブラリを無傷で先読みしました。")
    return IS_HARDWARE_OK


# ==========================================
# 🛠️ HydroDevices クラス（旧 device.py）
# ==========================================
class HydroDevices:
    def __init__(self, config):
        self.config = config
        self._setup_factory()
        
        # --- 入力デバイス (外部プルダウン回路: 3.3V入力でActive) ---
        input_ok_true = {'pull_up': None, 'active_state': True}
        input_ok_false = {'pull_up': None, 'active_state': False}

        # エラー発生時のために全てのデバイスをダミーで初期化しておく（安全ガード）
        self.ssr_sub_pump = DummyOutputDevice(config.PIN_SSR_SUB_PUMP)
        self.ssr_room_fan = DummyOutputDevice(config.PIN_SSR_ROOM_FAN)
        self.pump_main_a = DummyOutputDevice(config.PIN_PUMP_MAIN_A)
        self.pump_main_b = DummyOutputDevice(config.PIN_PUMP_MAIN_B)
        self.aeration = DummyOutputDevice(config.PIN_AERATION)
        self.usb_reserve = DummyOutputDevice(config.PIN_USB_RESERVE)
        self.fert_pump_1 = DummyOutputDevice(config.PIN_FERT_PUMP_1)
        self.fert_pump_2 = DummyOutputDevice(config.PIN_FERT_PUMP_2)
        self.fert_pump_3 = DummyOutputDevice(config.PIN_FERT_PUMP_3)
        self.fert_pump_4 = DummyOutputDevice(config.PIN_FERT_PUMP_4)
        self.water_valve = DummyOutputDevice(config.PIN_WATER_VALVE)
        self.cooling_fan = DummyPWMOutputDevice(config.PIN_COOLING_FAN)

        self.leak_detect = DummyButton(config.PIN_LEAK_DETECT)
        self.water_check = DummyButton(config.PIN_WATER_CHECK)
        self.float_main_top = DummyButton(config.PIN_FLOAT_MAIN_TOP)
        self.float_main_bottom = DummyButton(config.PIN_FLOAT_MAIN_BOTTOM)
        self.float_sub = DummyButton(config.PIN_FLOAT_SUB)
        self.float_reserve = DummyButton(config.PIN_FLOAT_RESERVE)
        self.water_flow = DummyButton(config.PIN_WATER_FLOW)

        self.pixels = DummyNeoPixel()

        try:
            # --- 出力デバイス (OutputDevice) ---
            self.ssr_sub_pump = OutputDevice(config.PIN_SSR_SUB_PUMP)
            self.ssr_room_fan = OutputDevice(config.PIN_SSR_ROOM_FAN)
            self.pump_main_a = OutputDevice(config.PIN_PUMP_MAIN_A)
            self.pump_main_b = OutputDevice(config.PIN_PUMP_MAIN_B)
            self.aeration = OutputDevice(config.PIN_AERATION)
            self.usb_reserve = OutputDevice(config.PIN_USB_RESERVE)
            self.fert_pump_1 = OutputDevice(config.PIN_FERT_PUMP_1)
            self.fert_pump_2 = OutputDevice(config.PIN_FERT_PUMP_2)
            self.fert_pump_3 = OutputDevice(config.PIN_FERT_PUMP_3)
            self.fert_pump_4 = OutputDevice(config.PIN_FERT_PUMP_4)
            self.water_valve = OutputDevice(config.PIN_WATER_VALVE)
            self.cooling_fan = PWMOutputDevice(config.PIN_COOLING_FAN)

            # --- 入力ボタン (Button) ---
            self.leak_detect = Button(config.PIN_LEAK_DETECT, **input_ok_true)
            self.water_check = Button(config.PIN_WATER_CHECK, **input_ok_true)
            self.float_main_top = Button(config.PIN_FLOAT_MAIN_TOP, **input_ok_false)
            self.float_main_bottom = Button(config.PIN_FLOAT_MAIN_BOTTOM, **input_ok_false)
            self.float_sub = Button(config.PIN_FLOAT_SUB, **input_ok_false)
            self.float_reserve = Button(config.PIN_FLOAT_RESERVE, **input_ok_false)
            self.water_flow = Button(config.PIN_WATER_FLOW, **input_ok_true)

            logger.info(f"GPIO Devices initialized on {Device.pin_factory.__class__.__name__}")
        except Exception as e:
            logger.error(f"Failed to initialize actual GPIO devices: {e}")
            logger.warning("HydroDevices is running with dummy GPIO devices in this environment.")

        # 💡 NeoPixel 初期化は GPIO デバイス初期化と分離し、権限エラーをより詳しく処理
        self._init_neopixel()

    def _init_neopixel(self):
        """NeoPixel LED の初期化（権限エラーをハンドリング）"""
        if 'board' not in globals() or 'neopixel' not in globals():
            logger.info("NeoPixel libraries unavailable; LED support disabled.")
            return

        try:
            self.pixels = neopixel.NeoPixel(
                board.D18,
                1, 
                brightness=1.0, 
                auto_write=True, 
                pixel_order=neopixel.RGB
            )
            logger.info("NeoPixel LED initialized successfully.")
        except PermissionError as e:
            logger.warning(
                f"NeoPixel LED requires elevated permissions: {e}\n"
                f"💡 Workarounds:\n"
                f"  1. Run with sudo: sudo python app.py\n"
                f"  2. Add gpio group to systemd User: User=root in hydroponics4.service\n"
                f"  3. Grant GPIO access: sudo usermod -aG gpio $(whoami)\n"
                f"  LED control will be disabled but system continues."
            )
            self.pixels = DummyNeoPixel()
        except Exception as e:
            logger.error(f"NeoPixel initialization failed: {e}")
            self.pixels = DummyNeoPixel()
        
    def _setup_factory(self):
        """UbuntuかRaspberry Piかを確実に判定してピンファクトリを切り替える"""
        from gpiozero import Device

        if Device.pin_factory is not None:
            return

        if os.path.exists("/proc/device-tree/model"):
            logger.info("Raspberry Pi detected. Leaving gpiozero to choose the native pin factory.")
            return

        try:
            from gpiozero.pins.mock import MockFactory
            Device.pin_factory = MockFactory()
            logger.warning("Running in MOCK MODE (MockFactory enabled for GPIO).")
        except Exception as e:
            logger.error(f"Failed to initialize MockFactory on development environment: {e}")

    def all_off(self):
        """緊急停止用：全ての OutputDevice を強制的にOFFにする"""
        for attr_name in dir(self):
            attr = getattr(self, attr_name)
            if hasattr(attr, 'off') and callable(getattr(attr, 'off')):
                try:
                    attr.off()
                except Exception:
                    pass
        self.update_led('off')  # LEDも消灯
        logger.warning("SAFETY: All OutputDevices have been turned OFF.")

    # 状態表示LED更新
    def update_led(self, color):
        logger.debug(f"called. color={color}")
        
        # 色名とRGB(GRB)値のマッピング（辞書化してスッキリ）
        # 標準的なGRB配列の場合の割り当て例：(G, R, B)
        color_map = {
            'blue':     (0, 0, 50),
            'green':    (50, 0, 0),   # GRBチップならこれで緑になります
            'success':  (50, 0, 0),
            'yellow':   (32, 32, 0),
            'warning':  (32, 32, 0),
            'red':      (0, 50, 0),   # GRBチップならこれで赤になります
            'danger':   (0, 50, 0),
            'cyan':     (32, 0, 32),
            'magenta':  (0, 32, 32),
            'white':    (20, 20, 20),
        }
        
        try:
            # 辞書から色を取得。なければ消灯 (0,0,0)
            target_color = color_map.get(color, (0, 0, 0))
            
            # 保持しておいたインスタンスの値を書き換えるだけ！
            self.pixels[0] = target_color
            return True
            
        except Exception as e:
            logger.error(f"Failed to update NeoPixel LED: {e}")
            return False

# ==========================================
# 📊 HydroSensors クラス（旧 sensors.py）
# ==========================================
class HydroSensors:
    def __init__(self, config):
        self.config = config
        self.i2c = None
        self.ads = None
        self.bme280 = None
        self.veml7700 = None
        self.w1_sensor = None
        
        # 本物のラズパイ環境の時だけ物理I2C/1-Wireを初期化
        if IS_HARDWARE_OK:
            self._init_i2c_devices()
            self._init_w1_sensor()
        else:
            logger.info("HydroSensors running in MOCK mode (Ubuntu detected).")

    def _init_i2c_devices(self):
        """I2Cバスおよびデバイスの初期化"""
        try:
            self.i2c = busio.I2C(board.SCL, board.SDA)
            self.ads = ADS.ADS1115(self.i2c, address=self.config.ADDR_ADS1115)
            self.bme280 = adafruit_bme280.Adafruit_BME280_I2C(self.i2c, address=self.config.ADDR_BME280)
            self.veml7700 = adafruit_veml7700.VEML7700(self.i2c, address=self.config.ADDR_VEML7700)
            logger.info("Physical I2C sensors initialized successfully.")
        except Exception as e:
            logger.error(f"Physical I2C sensors initialization failed: {e}")

    def _init_w1_sensor(self):
        """1-Wire (DS18B20) 水温計の初期化（固有IDピンポイント指定版）"""
        try:
            if self.config.W1_SENSOR_ID:
                # 💡 固有IDを指定して起動スキャンによるタイムアウトと見失いバグを完全防御
                self.w1_sensor = W1ThermSensor(Sensor.DS18B20, self.config.W1_SENSOR_ID)
                logger.info(f"Physical 1-Wire sensor initialized with explicit ID: {self.w1_sensor.id}")
            else:
                # バックアップとして従来の自動検索
                self.w1_sensor = W1ThermSensor()
                logger.warning(f"W1_SENSOR_ID not specified in config. Fell back to auto-scan: {self.w1_sensor.id}")
        except Exception as e:
            logger.error(f"Physical 1-Wire sensor initialization failed: {e}")


    def read_bme280(self):
        """💥 ラズパイ故障時はNone、Ubuntu開発時はデバッグ用ダミー値を返す"""
        if not IS_HARDWARE_OK:
            return {
                "air_temp": round(random.uniform(18.0, 26.0), 1),
                "humidity": round(random.uniform(50.0, 70.0), 1),
                "pressure": round(random.uniform(1005.0, 1015.0), 1)
            }
            
        if not self.bme280: 
            return {"air_temp": None, "humidity": None, "pressure": None}
            
        try:
            return {
                "air_temp": round(self.bme280.temperature, 1),
                "humidity": round(self.bme280.humidity, 1),
                "pressure": round(self.bme280.pressure, 1)
            }
        except Exception as e:
            logger.error(f"BME280 read error: {e}")
            return {"air_temp": None, "humidity": None, "pressure": None}

    def read_water_temp(self):
        """💥 ラズパイ故障時はNone、Ubuntu開発時はデバッグ用ダミー値を返す"""
        if not IS_HARDWARE_OK:
            return round(random.uniform(17.0, 22.0), 1)
            
        if not self.w1_sensor: 
            return None
            
        try:
            return round(self.w1_sensor.get_temperature(), 1)
        except Exception as e:
            logger.error(f"DS18B20 read error: {e}")
            return None

    def read_tds(self, water_temp):
        """💥 ラズパイ故障時はNone、Ubuntu開発時はデバッグ用ダミー値を返す"""
        if not IS_HARDWARE_OK:
            return round(random.uniform(1.2, 2.4), 2)
            
        if not self.ads: 
            return None
        
        k_value = self.config.TDS_K_VALUE 
        try:
            # 💡 物理水温センサーが壊れて水温が None になった場合の完全安全ガード
            actual_temp = water_temp if water_temp is not None else 25.0
            
            chan = AnalogIn(self.ads, self.config.CH_TDS_METER)
            v = chan.voltage
            
            temp_compensation = 1.0 + 0.02 * (actual_temp - 25.0)
            v_compensated = v / temp_compensation
            
            ec_raw = (133.42 * v_compensated**3 - 255.86 * v_compensated**2 + 857.39 * v_compensated)
            ec_value = (ec_raw / 1000.0) * k_value
            return round(max(0, ec_value), 2)
        except Exception as e:
            logger.error(f"EC sensor read error: {e}")
            return None

    def read_pressure_voltage(self):
        """水圧センサーの電圧測定（💡5回連続測定によるチャタリングノイズフィルタ搭載）"""
        if not IS_HARDWARE_OK:
            return round(random.uniform(1.5, 3.5), 3)
            
        if not self.ads: 
            return None
            
        try:
            chan = AnalogIn(self.ads, self.config.CH_PRESSURE)
            
            # 💡 電気的ノイズを極小化する移動平均処理
            voltages = []
            for _ in range(5):
                voltages.append(chan.voltage)
                time.sleep(0.01) # 10msの間隔をあけてサンプリング
                
            avg_voltage = sum(voltages) / len(voltages)
            rounded_voltage = round(avg_voltage, 3)
            logger.info(f"Raw pressure voltage: {rounded_voltage} V")
            return rounded_voltage
        except Exception as e:
            logger.error(f"Pressure sensor read error: {e}")
            return None


    def read_lux(self):
        """💥 ラズパイ故障時はNone、Ubuntu開発時はデバッグ用ダミー値を返す"""
        if not IS_HARDWARE_OK:
            hour = datetime.now().hour
            return round(random.uniform(4000.0, 6000.0), 1) if 6 <= hour < 18 else round(random.uniform(0.0, 10.0), 1)
            
        if not self.veml7700: 
            return None
            
        try:
            return round(self.veml7700.lux, 1)
        except Exception as e:
            logger.error(f"VEML7700 read error: {e}")
            return None

    def read_water_level(self):
        """💡実測の空・満水電圧をベースにした高精度水位(%)計算"""
        voltage = self.read_pressure_voltage()
        if voltage is None:
            return None
            
        v_empty = self.config.VOLTAGE_EMPTY
        v_full = self.config.VOLTAGE_FULL
        
        # 万が一分母が0（設定ミス）になった場合のクラッシュ防止ガード
        if v_full - v_empty == 0:
            logger.error("Calibration error: VOLTAGE_EMPTY and VOLTAGE_FULL cannot be identical.")
            return 0.0
            
        # 💡 実測電圧の傾きに基づく一次関数で正確にパーセント化
        level = (voltage - v_empty) / (v_full - v_empty) * 100.0
        
        # 0%〜100%の範囲を絶対に飛び出さないようにクリッピング
        return round(max(0.0, level), 1)
