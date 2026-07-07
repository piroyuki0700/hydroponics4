import json
import logging
import requests
import os

logger = logging.getLogger(__name__)

class HydroNotifier:
    def __init__(self, config):
        self.config = config
        self.webhook_url = config.DISCORD_WEBHOOK_URL

    def send_normal(self, message):
        """通常通知：テキストのみで即座に送信"""
        if not self.webhook_url: return

        payload = {"content": f"✅ **【通常報告】**\n{message}"}
        try:
            requests.post(self.webhook_url, json=payload, timeout=5)
            logger.info("Normal Discord notification sent.")
        except Exception as e:
            logger.error(f"Failed to send normal notification: {e}")

    def send_emergency(self, message):
        """緊急通知：テキストのみで即座に送信"""
        if not self.webhook_url: return
        
        payload = {"content": f"🚨 **【緊急警報】**\n{message}"}
        try:
            requests.post(self.webhook_url, json=payload, timeout=5)
            logger.info("Emergency Discord notification sent.")
        except Exception as e:
            logger.error(f"Failed to send emergency notification: {e}")

    def send_daily_report(self, message, image_path=None):
        """定時報告：テキストと（あれば）画像ファイルを送信"""
        if not self.webhook_url: return

        payload = {"content": f"📊 **【定時報告】**\n{message}"}
        
        try:
            if image_path and os.path.exists(image_path):
                # 画像がある場合は multipart/form-data で送信
                with open(image_path, 'rb') as f:
                    files = {'file': (os.path.basename(image_path), f, 'image/jpeg')}
                    # payloadを'payload_json'として送るのがDiscordの仕様
                    response = requests.post(
                        self.webhook_url, 
                        data={'payload_json': json.dumps(payload)},
                        files=files, 
                        timeout=10
                    )
            else:
                # 画像がない場合は通常のJSON送信
                response = requests.post(self.webhook_url, json=payload, timeout=5)
            
            response.raise_for_status()
            logger.info("Daily report sent to Discord.")
        except Exception as e:
            logger.error(f"Failed to send daily report: {e}")
