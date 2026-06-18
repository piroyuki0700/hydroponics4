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
  // バージョン表示の初期化
  initVersionPane();
  
  // websocket-serverと接続
  websocketConnect();
});

//
// 再接続ボタン
//
function reconnectButtonClick()
{
  if (webSocket == null) {
    websocketConnect();
    connectRetry = true;
  } else {
    printDebugMessage("websocket is already connected.");
  }
}

//
// 切断ボタン
//
function disconnectButtonClick()
{
  if (webSocket == null) {
    printDebugMessage("websocket is not connected.");
  } else {
    connectRetry = false;
    webSocket.close();
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

  if (webSocket != null)
  {
    printDebugMessage("already connected.");
    return;
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

  webSocket.on('refill_update', (data) => {
    setValueRefillUpdate(data);
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

  // // 結果ポップアップ通知
  // webSocket.on('result', (data) => {
  //   printDebugMessage(data['datetime'] + ': ' + data['result'] + ' - ' + data['message']);
  //   if (data['show_popup']) showModalResult(data);
  // });
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
  webSocket = null;
  const reconnectBtn = $('#reconnectButton');
  if (reconnectBtn) reconnectBtn.style.display = 'block';
  
  setValuePumpStatus({'status': 'manual_stop', 'seconds': 0});
  setValueRefillUpdate({ 'subpump_on': false});

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
  // 時刻指定なしにしたいとき（マイナス値は無効として空文字にする処理）
  const items = [
    "time_morning", "time_noon", "time_evening", "time_night",
    "camera1", "camera2", "camera3", "camera4", "camera5",
    "refill_max_seconds", "valve_open", "valve_close",
    "fert1_seconds", "fert2_seconds", "fert3_seconds", "fert4_seconds", "fert_adjust_hour"
  ];

  for (const item of items) {
    if (data[item] < 0)
      data[item] = "";
  }

  // 📝 テキスト入力欄・数値入力欄への値のセット
   const valItems = [
    "time_morning", "time_noon", "time_evening", "time_night",
    "morning_on", "morning_off", "noon_on", "noon_off", "evening_on", "evening_off",
    "night_on", "night_off",
    "refill_max_seconds", "valve_open", "valve_close",
    "fert1_seconds", "fert2_seconds", "fert3_seconds", "fert4_seconds", "fert_adjust_hour",
    "camera1", "camera2", "camera3", "camera4", "camera5",
    "minute_start", "minute_stop", "minute_refill"  ,
    "notify_time"
  ];

  valItems.forEach(name => {
    if (name in data) {
      const inputEl = $(`input[name="${name}"]`);
      if (inputEl) inputEl.value = data[name];
    }
  });

  // 🔄 トグルスイッチ（チェックボックス）のON/OFF制御
  // 新しい「fert_adjust（液肥の自動調整）」を追加しました
  const toggleItems = [
    'schedule_active', 'room_fan_active', 'nightly_active', 
    'refill_active', 'fert_adjust_active', 'notify_active', 'emergency_active'
  ];

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

    case 'auto_stop':
      if (pumpInfoEl) pumpInfoEl.textContent = '待機中'; // 👈 '動作モード' から '待機中' へ変更
      if (cycleIconEl) cycleIconEl.classList.remove('bi-spin');
      pump_active = false;
      break;

    case 'cycle_start':
      if (pumpInfoEl) pumpInfoEl.textContent = 'オート動作中';
      if (cycleIconEl) cycleIconEl.classList.add('bi-spin');
      pump_active = true;
      break;

    case 'cycle_stop':
      if (pumpInfoEl) pumpInfoEl.textContent = 'オート動作中';
      if (cycleIconEl) cycleIconEl.classList.remove('bi-spin');
      pump_active = false;
      break;

    case 'manual_start':
      if (pumpInfoEl) pumpInfoEl.textContent = 'マニュアル動作中';
      if (cycleIconEl) cycleIconEl.classList.add('bi-spin');
      pump_active = true;
      break;

    case 'manual_stop':
    default:
      if (pumpInfoEl) pumpInfoEl.textContent = '待機中'; // 👈 '動作モード' から '待機中' へ変更
      if (cycleIconEl) cycleIconEl.classList.remove('bi-spin');
      pump_active = false;
      break;
  }

  pumpStatusUpdate(data['seconds']);
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
function setValueRefillUpdate(data) {
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

  // フロートスイッチ、漏水検知、循環検知状態
  const input_switchs = ['float_main_top', 'float_main_bottom', 'float_sub', 'leak_detect', 'water_check', 'water_valve'];
  for (const input_switch of input_switchs) {
    if (input_switch in data) {
      const iconSwitch = $('#icon_' + input_switch);
      if (iconSwitch) {
        if (data[input_switch]) {
          iconSwitch.classList.remove('bi-x-circle', 'text-danger');
          iconSwitch.classList.add('bi-check-circle', 'text-success');
        } else {
          iconSwitch.classList.remove('bi-check-circle', 'text-success');
          iconSwitch.classList.add('bi-x-circle', 'text-danger');
        }
      }
    }
  }
  
  // 📜 給水履歴ログの反映（サーバー側で連結済みのテキストを一括流し込み）
  const refillLog = $('#refill_log');
  if (refillLog && 'refill_records' in data) {
    // 💡 届いた文字列をそのまま代入するだけ！
    refillLog.value = data['refill_records'];
    
    // 常に最新のログ（最下部）が見えるように自動スクロール
    refillLog.scrollTop = refillLog.scrollHeight;
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
  const toggles = [
    "schedule_active", "room_fan_active", "nightly_active", 
    "refill_active", "fert_adjust_active", "notify_active", "emergency_active"
  ];
  
  toggles.forEach(name => {
    const el = $(`input[name="${name}"]`);
    data[name] = el && el.checked ? "1" : "0";
  });

  // 時刻指定なしにしたいとき（空欄の場合は -1 に変換して送信）
  const items = [
  //  "time_spot1", "time_spot2", "time_spot3", // ⚠️ 旧データの互換性・データベース保護のために残す場合はこのままでOK
    "time_morning", "time_noon", "time_evening", "time_night",
    "morning_on", "morning_off", "noon_on", "noon_off", "evening_on", "evening_off", "night_on", "night_off",
    "refill_max_seconds", "valve_open", "valve_close",
    "fert1_seconds", "fert2_seconds", "fert3_seconds", "fert4_seconds", "fert_adjust_hour",
    "camera1", "camera2", "camera3", "camera4", "camera5",
    "notify_time"
  ];

  for (const item of items) {
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
  }
  else if (seconds == 0) {
    // 停止
    if (pumpCountdown) pumpCountdown.textContent = "停止";
  }
  else
  {
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
 * 画面起動時、またはWebSocket接続完了時に一度だけ呼び出す初期化関数
 */
function initVersionPane() {
  // 💡 確実にイベントを拾うため、document全体でタブ切り替えイベントを監視します

  // 1. タブが表示された瞬間のイベント
  document.addEventListener('shown.bs.tab', (event) => {
    // event.target はクリックされた <a> タグを指します
    const activatedTab = event.target;

    // <a>タグの href 属性が「#pane_version」だったら、バージョンタブが開かれたと判断
    if (activatedTab && activatedTab.getAttribute('href') === '#pane_version') {
      // 1分ごとの自動更新タイマーを開始
      startCpuAutoUpdate();
    }
  });

  // 2. 他のタブに切り替わって隠れた瞬間のイベント
  document.addEventListener('hidden.bs.tab', (event) => {
    const deactivatedTab = event.target;

    // 隠れたタブが「#pane_version」だったら、タイマーを即座に停止！
    if (deactivatedTab && deactivatedTab.getAttribute('href') === '#pane_version') {
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

  // エラー再開ボタンを隠す
  const btnRefresh = $('#btn_refresh_cpu');
  if (btnRefresh) {
    btnRefresh.classList.add('d-none');
  }

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

  const btnRefresh = $('#btn_refresh_cpu');
  if (btnRefresh) {
    btnRefresh.classList.remove('d-none');
  }
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
function subPumpButtonClick(request, option="none") {
  websocket_send({'command': 'subpump_' + request, 'option': option});
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

