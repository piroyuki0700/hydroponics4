import cv2
import os
import time
import logging
from datetime import datetime

logger = logging.getLogger(__name__)

class HydroCamera:
    def __init__(self, config):
        self.config = config
        self.device_id = self._detect_device_id()

    def _detect_device_id(self):
        # """/dev/video2 があればUSBカメラ（開発環境）とみなし、なければ 0 を使う"""
        # # Ubuntu等でUSBカメラがvideo2に割り当てられているか確認
        # if os.path.exists("/dev/video2"):
        #     logger.info("Detected /dev/video2. Using device ID 2 (Development environment).")
        #     return 2
        
        # なければRaspberry Pi等のデフォルトである 0 を採用
        logger.info("Using default device ID 0 (Production environment).")
        return 0

    def capture(self, is_tmp=False):
        """呼ばれたらその場で愚直に撮影する（エコ設計）"""
        save_dir = self.config.TMP_PIC_DIR if is_tmp else self.config.PIC_DIR
        now = datetime.now()
        filename = f"picture_{now.strftime('%Y%m%d_%H%M%S')}.jpg"
        filepath = os.path.join(save_dir, filename)
        
        result = {
            "success": False,
            "filename": filename,
            "filepath": filepath,
            "taken_at": now.strftime('%Y/%m/%d %H:%M:%S')
        }

        logger.info(f"Opening camera device ID: {self.device_id}...")
        cap = cv2.VideoCapture(self.device_id, cv2.CAP_V4L2)
        
        if not cap.isOpened():
            logger.error(f"Could not open camera device ID {self.device_id}.")
            return result

        try:
            # 解像度設定
            cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)

            # 露出（明るさ）調整のための空読み
            # 💡環境によって、ここが一番時間を食います。
            # もし写真が暗くなければ、レンジを「range(2)」程度に減らすと数秒短縮できます。
            for _ in range(5):
                cap.read()
                time.sleep(0.1) # Linuxのバッファクリアを確実にするため、ごくわずかなウェイトを入れる

            # 本撮影
            ret, frame = cap.read()
            if ret:
                cv2.imwrite(filepath, frame)
                result["success"] = True
                logger.info(f"Captured successfully: {filepath}")
            else:
                logger.error("Failed to capture image from camera.")

        except Exception as e:
            logger.error(f"Camera error: {e}")
        finally:
            # 使い終わったら確実に解放して省電力化
            cap.release()
            logger.info("Camera device released.")

        return result
