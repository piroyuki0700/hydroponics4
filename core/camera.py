import os
import time
import logging
import subprocess
import shutil
from datetime import datetime

logger = logging.getLogger(__name__)

class HydroCamera:
    def __init__(self, config):
        self.config = config
        self.device_path = self._detect_device_path()
        
        # どの撮影コマンドがシステムにインストールされているか自動チェック
        self.has_fswebcam = shutil.which("fswebcam") is not None
        self.has_ffmpeg = shutil.which("ffmpeg") is not None
        
        if self.has_fswebcam:
            logger.info("Camera Command Mode: fswebcam を使用します。")
        elif self.has_ffmpeg:
            logger.info("Camera Command Mode: ffmpeg を使用します。")
        else:
            logger.warning("⚠️ 撮影コマンド（fswebcamまたはffmpeg）が見つかりません。")

    def _detect_device_path(self):
        """/dev/video2 があればUSBカメラ（開発環境）とみなし、なければ /dev/video0 を使う"""
        if os.path.exists("/dev/video2"):
            logger.info("Detected /dev/video2. Using /dev/video2 (Development environment).")
            return "/dev/video2"
        
        logger.info("Using default /dev/video0 (Production environment).")
        return "/dev/video0"

    def capture(self, is_tmp=False):
        """呼ばれたら外部コマンドを使ってその場で軽量に撮影する"""
        save_dir = self.config.TMP_PIC_DIR if is_tmp else self.config.PIC_DIR
        now = datetime.now()
        filename = f"picture_{now.strftime('%Y%m%d_%H%M%S')}.jpg"
        filepath = os.path.join(save_dir, filename)
        
        # 呼び出し元の既存ロジックを壊さないよう、同じ形式の辞書を用意
        result = {
            "success": False,
            "filename": filename,
            "filepath": filepath,
            "taken_at": now.strftime('%Y/%m/%d %H:%M:%S')
        }

        # フォルダがない場合は作成
        os.makedirs(save_dir, exist_ok=True)

        # 1. fswebcamが使える場合（ラズパイ・Ubuntu共通の基本モード）
        if self.has_fswebcam:
            # -d: デバイス指定, -r: 解像度, --no-banner: 下部の黒帯インフォを消す
            # 💡 もし写真が暗い場合は、"--skip" "5" を追加すると、5フレーム分空読み（露出調整）してから撮影してくれます。
            cmd = ["fswebcam", "-d", self.device_path, "-r", "1280x720", "--skip", "2", "--no-banner", filepath]
            
        # 2. ffmpegしか使えない場合（Ubuntuなどでのバックアップモード）
        elif self.has_ffmpeg:
            cmd = [
                "ffmpeg", "-y", "-f", "video4linux2", "-video_size", "1280x720", 
                "-i", self.device_path, "-vframes", "1", filepath
            ]
        else:
            logger.error("撮影可能なコマンド（fswebcam / ffmpeg）がインストールされていません。")
            return result

        logger.info(f"Starting camera capture via command using {self.device_path}...")
        
        try:
            # コマンドを実行（ログ出力を非表示にしてバックグラウンドで静かに実行）
            subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            result["success"] = True
            logger.info(f"Captured successfully via command: {filepath}")
            
        except subprocess.CalledProcessError as e:
            logger.error(f"Failed to capture image via command. Error: {e}")
        except Exception as e:
            logger.error(f"Unexpected error during camera capture: {e}")

        return result