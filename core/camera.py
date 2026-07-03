import os
import time
import logging
import subprocess
from types import SimpleNamespace
import shutil
from datetime import datetime

logger = logging.getLogger(__name__)

class HydroCamera:
    MAX_CAPTURE_ATTEMPTS = 3

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

        for attempt in range(self.MAX_CAPTURE_ATTEMPTS):
            if os.path.exists(filepath):
                try:
                    os.remove(filepath)
                except Exception as e:
                    logger.warning(f"Failed to remove stale capture file before retry: {e}")

            success = False
            completed = None
            try:
                success, completed = self._capture_once(cmd, filepath)
                if success:
                    result["success"] = True
                    logger.info(f"Captured successfully via command: {filepath}")
                    if completed and completed.stdout:
                        output_lines = completed.stdout.strip().splitlines()
                        if output_lines:
                            logger.debug("Camera stdout: %s", " | ".join(output_lines[:3]))
                    break
            finally:
                # 成功しなかった場合は生成されたファイル（もしあれば）を削除しておく
                if not success and os.path.exists(filepath):
                    try:
                        os.remove(filepath)
                        logger.info(f"Removed failed capture file: {filepath}")
                    except Exception as e:
                        logger.warning(f"Failed to remove failed capture file: {e}")

            if attempt < self.MAX_CAPTURE_ATTEMPTS - 1:
                logger.info(f"Retrying camera capture in 1 second... ({attempt + 1}/{self.MAX_CAPTURE_ATTEMPTS})")
                time.sleep(1)

        if not result["success"]:
            # 可能であればコマンドの stdout/stderr を返しておく（呼び出し元がユーザー通知に使える）
            if completed is not None:
                try:
                    result["stdout"] = completed.stdout
                    result["stderr"] = completed.stderr
                except Exception:
                    pass
            logger.error("Camera capture failed after retries: %s", filepath)

        return result

    def _capture_once(self, cmd, filepath):
        """1回分のキャプチャ実行と、ファイル生成・サイズ確認を行う。"""
        try:
            completed = subprocess.run(
                cmd,
                check=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )

            if os.path.exists(filepath) and os.path.getsize(filepath) > 0:
                return True, completed

            logger.warning(
                "Capture command completed but output file was not created or was empty: %s",
                filepath,
            )
            return False, completed

        except subprocess.CalledProcessError as e:
            stdout = e.stdout if e.stdout else ""
            stderr = e.stderr if e.stderr else ""
            # エラー時は stdout/stderr を全文ログに残す
            logger.error(
                "Failed to capture image via command. exit=%s\nSTDOUT:\n%s\nSTDERR:\n%s",
                e.returncode,
                stdout,
                stderr,
            )
            # 呼び出し元が内容を通知できるように SimpleNamespace で返す
            return False, SimpleNamespace(stdout=stdout, stderr=stderr)
        except Exception as e:
            logger.exception("Unexpected error during camera capture")
            return False, None
