import os
import requests
import json
from dotenv import load_dotenv

# .envを読み込む
load_dotenv()

def test_discord():
    webhook_url = os.getenv('DISCORD_WEBHOOK_URL')
    
    if not webhook_url:
        print("エラー: .env に DISCORD_WEBHOOK_URL が設定されていません。")
        return

    print("--- Discord通知テスト開始 ---")

    # 1. テキストのみのテスト（緊急通知を想定）
    print("1. テキスト通知を送信中...")
    payload_text = {"content": "🚨 **テスト通知**: システムは正常に起動しています。"}
    try:
        res1 = requests.post(webhook_url, json=payload_text, timeout=5)
        res1.raise_for_status()
        print("   ✅ テキスト通知成功")
    except Exception as e:
        print(f"   ❌ テキスト通知失敗: {e}")

    # 2. 画像付きのテスト（定時報告を想定）
    # pictures/ フォルダに何か画像があるか確認し、あればそれを使います
    print("2. 画像付き通知を送信中...")
    image_path = "pictures/test_image.jpg" # テスト用の画像パス
    
    # テスト画像がない場合は、とりあえず何もしない
    if not os.path.exists(image_path):
        print(f"   ⚠️  テスト画像が見つかりません ({image_path})。画像テストをスキップします。")
        print("      (実際に写真を1枚置いて実行すると、画像アップロードのテストができます)")
        return

    payload_json = json.dumps({"content": "📊 **テスト報告**: 画像付きの投稿テストです。"})
    try:
        with open(image_path, 'rb') as f:
            files = {'file': (os.path.basename(image_path), f, 'image/jpeg')}
            res2 = requests.post(
                webhook_url,
                data={'payload_json': payload_json},
                files=files,
                timeout=10
            )
            res2.raise_for_status()
            print("   ✅ 画像付き通知成功")
    except Exception as e:
        print(f"   ❌ 画像付き通知失敗: {e}")

if __name__ == "__main__":
    test_discord()
