import os
import eventlet
# VSCodeから渡された環境変数 'FLASK_DEBUG' が「ない」ときだけパッチを当てる
if os.environ.get('FLASK_DEBUG') != 'true':
    eventlet.monkey_patch()
    print("[通常起動] eventlet のモンキーパッチを適用しました。")
else:
    print("[デバッグ起動] VSCodeデバッガを検出したため、パッチをスキップしました。")

import logging
import signal
import sys
from flask import Flask, render_template, request, send_from_directory
from flask_socketio import SocketIO

# プロジェクト内の各モジュールをインポート
from config import Config
from core.db import HydroDB
from core.hardware import HydroDevices, HydroSensors
from core.camera import HydroCamera
from core.manager import HydroManager

# 1. ログ設定 (以前のロジックを継承・統合)
from logging.handlers import RotatingFileHandler

def setup_logger():
    logger = logging.getLogger() # ルートロガーを設定
    logger.setLevel(logging.INFO)
    formatter = logging.Formatter('%(asctime)s: [%(levelname)s] %(name)s - %(message)s')
    
    # フォルダがない場合は作成
    os.makedirs(Config.LOG_DIR, exist_ok=True)
    
    fh = RotatingFileHandler(f"{Config.LOG_DIR}/hydroponics.log", maxBytes=1024000, backupCount=10)
    fh.setFormatter(formatter)
    logger.addHandler(fh)
    
    ch = logging.StreamHandler()
    ch.setFormatter(formatter)
    logger.addHandler(ch)
    return logger

logger = setup_logger()

# 2. Flask & SocketIO の初期化
app = Flask(__name__)
app.config['SECRET_KEY'] = Config.SECRET_KEY

if sys.gettrace() is not None:
    # VSCodeデバッガが動いている時は、衝突を避けるため
    # eventletを明示的に「使用禁止（threadingモード）」にする
    print("⚠️ VSCodeデバッガを検出: eventletを無効化し、標準スレッドモードで起動します。")
    socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading')
else:
    # 通常起動（ターミナルから python app.py などを叩いた時）はeventletで高速に動かす
    socketio = SocketIO(app, cors_allowed_origins="*", async_mode='eventlet')

# 3. 各マネージャーのインスタンス化 (Dependency Injection)
db = HydroDB(Config)
device = HydroDevices(Config)
sensors = HydroSensors(Config)
camera = HydroCamera(Config)
# 司令塔 manager に SocketIO を渡し、内部から broadcast できるようにする
manager = HydroManager(Config, db, device, sensors, camera, socketio)

# --- HTTP Routes ---
@app.route('/')
def index():
    return render_template('index.html')

@app.route('/pictures/<path:filename>')
def serve_pictures(filename):
    # プロジェクト直下の pictures フォルダからファイルを返す
    return send_from_directory(Config.PIC_DIR, filename)

@app.route('/tmp_pictures/<path:filename>')
def serve_tmp_pictures(filename):
    return send_from_directory(Config.TMP_PIC_DIR, filename)

# --- WebSocket Events ---
@socketio.on('connect')
def handle_connect(auth=None):
    logger.info("Client connected")
    # クライアント接続時に初期データを一括送信
    manager.send_initial_data()

@socketio.on('command')
def handle_command(json_data):
    logger.debug(f"Received command: {json_data}")
    # managerに処理を委譲。結果はボタンを押した本人だけに自動で返却される
    response = manager.handle_request(json_data)
    return response

@socketio.on('disconnect')
def handle_disconnect():
    logger.info("Client disconnected")

# --- メイン処理 ---
if __name__ == '__main__':
    logger.info("##### hydroponics4 server start #####")
    
    # 💡 systemctl stop (SIGTERM) を安全にキャッチする関数を定義
    def handle_sigterm(signum, frame):
        logger.info("SIGTERM received from systemd. Initiating graceful shutdown...")
        # Eventletのループやサーバーを安全に止めるため、sys.exitを実行してfinally節へ落とす
        sys.exit(0)

    # 💡 信号の登録
    signal.signal(signal.SIGTERM, handle_sigterm)
    signal.signal(signal.SIGINT, handle_sigterm) # Ctrl+C用

    try:
        # 制御用シーケンス開始（タイマースタート等）
        manager.start()
        
        # サーバー起動 (use_reloader=Falseを明示して二重起動バグを完全防御)
        socketio.run(app, host='0.0.0.0', port=5000, debug=True, use_reloader=False)

    except (KeyboardInterrupt, SystemExit):
        logger.info("Server shutdown initiated via interrupt/exit.")
    except Exception as e:
        logger.error(f"Fatal error in server main: {e}", exc_info=True)
    finally:
        # ⚠️ ここが心臓部です。systemctl stop 時に必ずここを通過させます。
        logger.info("Executing manager.stop() for hardware safety...")
        manager.stop() # 内部でタイマー破棄、switcher.stop()、device.all_off()が実行される
        logger.info("##### hydroponics4 server end #####")
# end.
