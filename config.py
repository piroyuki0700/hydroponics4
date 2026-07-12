import os
import ast
from dotenv import load_dotenv

# .env ファイルを読み込む
load_dotenv()

class Config:
    # バージョン情報
    APP_VERSION = '2026/07/12'
    GITHUB_URL = os.getenv('GITHUB_URL', 'https://github.com/username/repository')
    GITHUB_REPO_NAME = os.getenv('GITHUB_REPO_NAME', 'repository')

    # Flask Settings
    SECRET_KEY = os.getenv('SECRET_KEY', 'default-secret-key')
    FLASK_DEBUG = os.getenv('FLASK_DEBUG', 'false') == 'true'

    # Database
    DB_HOST = os.getenv('DB_HOST', 'localhost')
    DB_NAME = os.getenv('DB_NAME', 'hydroponics4')
    DB_USER = os.getenv('DB_USER', 'hydro_user')
    DB_PASSWORD = os.getenv('DB_PASSWORD')

    # Discord Webhook URL
    DISCORD_WEBHOOK_URL   = os.getenv('DISCORD_WEBHOOK_URL')

    # Directories
    LOG_DIR = 'log'
    PIC_DIR = 'pictures'
    TMP_PIC_DIR = 'tmp_pictures'

    # I2C Settings (💡 ast.literal_eval で 0x48 を自動で整数 72 に変換)
    ADDR_ADS1115 = ast.literal_eval(os.getenv('ADDR_ADS1115', '0x48'))
    ADDR_BME280   = ast.literal_eval(os.getenv('ADDR_BME280', '0x76'))
    ADDR_VEML7700 = ast.literal_eval(os.getenv('ADDR_VEML7700', '0x10'))

    # ADC Channel Mapping (ADS1115)
    CH_TDS_METER = int(os.getenv('CH_TDS_METER', 0))  # AIN0
    CH_PRESSURE  = int(os.getenv('CH_PRESSURE', 1))   # AIN1

    # GPIO Outputs (int型へ変換)
    PIN_SSR_SUB_PUMP = int(os.getenv('PIN_SSR_SUB_PUMP', 17))
    PIN_LED_WS2812   = int(os.getenv('PIN_LED_WS2812', 18))
    PIN_SSR_ROOM_FAN = int(os.getenv('PIN_SSR_ROOM_FAN', 27))
    PIN_PUMP_MAIN_A  = int(os.getenv('PIN_PUMP_MAIN_A', 22))
    PIN_PUMP_MAIN_B  = int(os.getenv('PIN_PUMP_MAIN_B', 10))
    PIN_AERATION     = int(os.getenv('PIN_AERATION', 9))
    PIN_USB_RESERVE  = int(os.getenv('PIN_USB_RESERVE', 11))
    PIN_FERT_PUMP_1  = int(os.getenv('PIN_FERT_PUMP_1', 5))
    PIN_FERT_PUMP_2  = int(os.getenv('PIN_FERT_PUMP_2', 6))
    PIN_FERT_PUMP_3  = int(os.getenv('PIN_FERT_PUMP_3', 13))
    PIN_FERT_PUMP_4  = int(os.getenv('PIN_FERT_PUMP_4', 19))
    PIN_COOLING_FAN  = int(os.getenv('PIN_COOLING_FAN', 26))
    PIN_WATER_VALVE  = int(os.getenv('PIN_WATER_VALVE', 21))

    # GPIO Inputs (int型へ変換)
    PIN_LEAK_DETECT       = int(os.getenv('PIN_LEAK_DETECT', 23))
    PIN_WATER_CHECK      = int(os.getenv('PIN_WATER_CHECK', 24))
    PIN_FLOAT_MAIN_TOP    = int(os.getenv('PIN_FLOAT_MAIN_TOP', 25))
    PIN_FLOAT_MAIN_BOTTOM = int(os.getenv('PIN_FLOAT_MAIN_BOTTOM', 8))
    PIN_FLOAT_SUB         = int(os.getenv('PIN_FLOAT_SUB', 7))
    PIN_FLOAT_RESERVE     = int(os.getenv('PIN_FLOAT_RESERVE', 12))
    PIN_WATER_FLOW        = int(os.getenv('PIN_WATER_FLOW', 20))

    # 1-Wire
    PIN_THERMOMETER = int(os.getenv('PIN_THERMOMETER', 4))

    # 💡 1-Wire 固有IDの追加
    W1_SENSOR_ID = os.getenv('W1_SENSOR_ID', None)

    # Calibration
    TDS_K_VALUE = float(os.getenv('TDS_K_VALUE', 1.0))
    
    # 💡 水圧センサー水位校正用定数の追加
    VOLTAGE_EMPTY = float(os.getenv('VOLTAGE_EMPTY', 0.001))
    VOLTAGE_FULL  = float(os.getenv('VOLTAGE_FULL', 1.400))

    # CPUファン制御設定
    CPU_FAN_INTERVAL = float(os.getenv('CPU_FAN_INTERVAL', 10.0))     # 監視間隔（秒）
    CPU_FAN_HYSTERESIS = float(os.getenv('CPU_FAN_HYSTERESIS', 3.0))  # ヒステリシス（℃）
    CPU_FAN_SPEED_LOW = float(os.getenv('CPU_FAN_SPEED_LOW', 0.5))    # やや高い時のPWM出力 (0.0～1.0)
    CPU_FAN_SPEED_HIGH = float(os.getenv('CPU_FAN_SPEED_HIGH', 1.0))  # とても高い時のPWM出力 (0.0～1.0)

