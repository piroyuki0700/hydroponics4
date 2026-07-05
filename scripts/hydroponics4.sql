-- 水耕栽培システムのデータベーススキーマ定義
-- 2026年夏のプロジェクト用に設計されたスキーマです。
-- source /home/piro/Documents/git/hydroponics4/scripts/hydroponics4.sql

USE hydro2026summer;

-- 基本設定
DROP TABLE IF EXISTS `setting_basic`;
CREATE TABLE `setting_basic` (
  `no` INT PRIMARY KEY DEFAULT 1,
  
  -- 栽培システム名
  `myname` VARCHAR(64) DEFAULT NULL,
  
  -- 栽培する植物の種類やメモ
  `memo` TEXT DEFAULT NULL,
  
  -- 栽培開始日時：これが入力されていると「栽培中」と判定
  `started` DATETIME DEFAULT NULL,
  -- 栽培終了日時：これが入力されると「栽培終了（過去ログ化）」と判定
  `finished` DATETIME DEFAULT NULL,

  -- 更新日時
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  
  -- 1行制限
  CONSTRAINT `check_api_one_row` CHECK (`no` = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- 初期データ
INSERT INTO `setting_basic` (`no`, `myname`, `memo`) VALUES (1, '水耕2026年夏', '2026年夏の温室トマト栽培用データベース') ON DUPLICATE KEY UPDATE `no` = 1;

-- スケジュール設定
DROP TABLE IF EXISTS `setting_schedule`;
CREATE TABLE `setting_schedule` (
  `no` INT NOT NULL DEFAULT 1,
  -- 全体制御
  `schedule_active` BOOLEAN DEFAULT TRUE,
  `room_fan_active` BOOLEAN DEFAULT TRUE, -- 送風機スイッチ
  `nightly_active` BOOLEAN DEFAULT FALSE, -- 夜間スイッチ

  -- 時間帯の区切り（例: 6, 12, 17, 21 など時間を数値で格納）
  `time_morning` INT DEFAULT 6,
  `time_noon` INT DEFAULT 12,
  `time_evening` INT DEFAULT 17,
  `time_night` INT DEFAULT 21,
  
  -- ポンプ間欠運転（ON時間 / OFF時間：単位は分を想定）
  `morning_on` INT DEFAULT 5, `morning_off` INT DEFAULT 10,
  `noon_on` INT DEFAULT 5,   `noon_off` INT DEFAULT 5,
  `evening_on` INT DEFAULT 5, `evening_off` INT DEFAULT 10,
  `night_on` INT DEFAULT 5,   `night_off` INT DEFAULT 50,
   
  -- スポット運転設定（夜中の動作用）
  -- `spot_on_seconds` INT DEFAULT 0, -- スポット運転時間
  -- `time_spot1` INT DEFAULT NULL, `time_spot2` INT DEFAULT NULL, `time_spot3` INT DEFAULT NULL,
  
  -- 自動給水設定 (Refill)
  `refill_active` BOOLEAN DEFAULT TRUE,
  `refill_max_seconds` INT DEFAULT 180, -- 給水の最大ON時間（秒）

  `valve_active` BOOLEAN DEFAULT TRUE, -- 給水用バルブのON/OFF制御有効化
  `valve_open` INT DEFAULT 4, -- 給水用バルブの開時刻（時）
  `valve_close` INT DEFAULT 6, -- 給水用バルブの閉時刻（時）

  -- 液肥追加設定
  `fert1_seconds` INT DEFAULT 20, -- 液肥1の追加秒数
  `fert2_seconds` INT DEFAULT 20, -- 液肥2の追加秒数
  `fert3_seconds` INT DEFAULT 20, -- 液肥3の追加秒数
  `fert4_seconds` INT DEFAULT 10, -- 液肥4の追加秒数
  `fert_adjust_active` BOOLEAN DEFAULT FALSE, -- 液肥調整の有効化
  `fert_adjust_hour` INT DEFAULT 12, -- 液肥調整時刻（時）

  -- カメラ撮影設定
  `camera_active` BOOLEAN DEFAULT TRUE,
  -- カメラ撮影タイミング（時）
  `camera1` INT DEFAULT 8, `camera2` INT DEFAULT 10, `camera3` INT DEFAULT 12, `camera4` INT DEFAULT 14, `camera5` INT DEFAULT 16,
  
  -- 通知設定
  `notify_time` INT DEFAULT 12, -- 定時報告の時間（お昼のdiscord投稿など）
  `notify_active` BOOLEAN DEFAULT TRUE,
  `emergency_active` BOOLEAN DEFAULT TRUE,

  -- 処理切替タイミング
  `minute_start` INT DEFAULT 0,
  `minute_stop` INT DEFAULT 54,
  `minute_refill` INT DEFAULT 56,
 
  -- 更新日時
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  
  -- 1行制限
  CONSTRAINT `check_api_one_row` CHECK (`no` = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- 初期データ
INSERT INTO `setting_schedule` (`no`) VALUES (1) ON DUPLICATE KEY UPDATE `no` = 1;

-- センサーしきい値設定
DROP TABLE IF EXISTS `setting_sensor_limit`;
CREATE TABLE `setting_sensor_limit` (
  `no` INT NOT NULL DEFAULT 1,
  
  -- 気温 (Air Temperature)
  `air_temp_vlow`  DECIMAL(4,1) DEFAULT 5.0,
  `air_temp_low`   DECIMAL(4,1) DEFAULT 15.0,
  `air_temp_high`  DECIMAL(4,1) DEFAULT 30.0,
  `air_temp_vhigh` DECIMAL(4,1) DEFAULT 35.0,

  -- 湿度 (Humidity)
  `humidity_vlow`  DECIMAL(4,1) DEFAULT 20.0,
  `humidity_low`   DECIMAL(4,1) DEFAULT 40.0,

  -- 水温 (Water Temperature)
  `water_temp_vlow`  DECIMAL(4,1) DEFAULT 10.0,
  `water_temp_low`   DECIMAL(4,1) DEFAULT 18.0,
  `water_temp_high`  DECIMAL(4,1) DEFAULT 28.0,
  `water_temp_vhigh` DECIMAL(4,1) DEFAULT 32.0,

  -- 水位 (Water Level %)
  `water_level_vlow` DECIMAL(4,1) DEFAULT 10.0,
  `water_level_low`  DECIMAL(4,1) DEFAULT 30.0,

  -- 肥料濃度 (EC値: mS/cm) 
  -- DECIMAL(4,2) により 0.00 ～ 99.99 まで保持可能。水耕栽培(通常1.0~2.5)に最適。
  `tds_level_vlow`  DECIMAL(4,2) DEFAULT 0.50,
  `tds_level_low`   DECIMAL(4,2) DEFAULT 1.00,
  `tds_level_high`  DECIMAL(4,2) DEFAULT 3.00,
  `tds_level_vhigh` DECIMAL(4,2) DEFAULT 5.00,

  -- CPU温度 (CPU Temperature)
  `cpu_temp_high`  DECIMAL(4,1) DEFAULT 55.0,
  `cpu_temp_vhigh` DECIMAL(4,1) DEFAULT 70.0,

  -- 更新日時
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  
  -- 1行制限
  CONSTRAINT `check_api_one_row` CHECK (`no` = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- 初期データ
INSERT INTO `setting_sensor_limit` (`no`) VALUES (1) ON DUPLICATE KEY UPDATE `no` = 1;


-- レポート情報
DROP TABLE IF EXISTS `report`;
CREATE TABLE `report` (
  -- 主キーを一行で定義。自動で番号が振られます。
  `no` INT AUTO_INCREMENT PRIMARY KEY,
  
  -- 各種センサー値（精度重視のDECIMAL型）
  `air_temp`    DECIMAL(4,1) DEFAULT NULL COMMENT '気温',
  `humidity`    DECIMAL(4,1) DEFAULT NULL COMMENT '湿度',
  `water_temp`  DECIMAL(4,1) DEFAULT NULL COMMENT '水温',
  
  -- 水圧・水位関連
  `water_pressure` DECIMAL(5,2) DEFAULT NULL COMMENT '水圧(生データ/電圧等)',
  `water_level`    DECIMAL(4,1) DEFAULT NULL COMMENT '水位%',
    
  -- 肥料濃度（EC値：0.00〜9.99）
  `tds_level` DECIMAL(4,2) DEFAULT NULL COMMENT 'EC値',
  
  -- 照度
  `brightness` DECIMAL(6,1) DEFAULT NULL COMMENT '照度',

  -- 水流パルス数
  `water_pulses` INT DEFAULT NULL COMMENT '前回レポートからの水流パルス数',
  
  -- 写真テーブルの no と紐付け
  `picture_no` INT DEFAULT NULL,
  
  -- 測定日時
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  -- 検索高速化のためのインデックス
  INDEX `idx_report_time` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;


-- カメラ画像
DROP TABLE IF EXISTS `picture`;
CREATE TABLE `picture` (
  -- 主キー：自動採番（reportテーブルのpicture_noと紐付けます）
  `no` INT AUTO_INCREMENT PRIMARY KEY,
  
  -- 画像ファイル名（例：20260701_1200.jpg など）
  `filename` VARCHAR(64) DEFAULT NULL,
  
  -- 撮影日時（ファイル作成日時）
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP ,
  -- 検索高速化のためのインデックス
  INDEX `idx_taken` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;


-- ポンプ動作状況
DROP TABLE IF EXISTS `pump_status`;
CREATE TABLE `pump_status` (
  -- 主キー：1固定
  `no` INT PRIMARY KEY DEFAULT 1,
  
  -- 現在の状態（'running', 'stopped', 'manual' など）
  `status` VARCHAR(16) DEFAULT 'stopped' COMMENT '稼働状態',
  
  -- 自動停止予定日時（スケジュール実行時に算出）
  `end_time` DATETIME DEFAULT NULL COMMENT '停止予定時刻',
  
  -- データがいつ更新されたか（プログラム側での最終確認用）
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  
  -- 物理的に1行しか存在させない制約
  CONSTRAINT `check_pump_one_row` CHECK (`no` = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- 初期データ
INSERT INTO `pump_status` (`no`, `status`) VALUES (1, 'stopped') ON DUPLICATE KEY UPDATE `no` = 1;


-- 水の補充記録
DROP TABLE IF EXISTS `refill_record`;
CREATE TABLE `refill_record` (
  -- 主キー：一行定義（自動採番）
  `no` INT AUTO_INCREMENT PRIMARY KEY,
  
  -- ポンプ作動時間（秒）
  `on_seconds` INT DEFAULT NULL,
  
  -- 起動トリガー（例: 'schedule', 'manual'）
  `trigger` VARCHAR(16) DEFAULT NULL,
  -- 結果の状態
  `result_status` VARCHAR(32) DEFAULT NULL,
  
  -- 水圧計による参考水位（給水前後）
  `level_before` DECIMAL(4,1) DEFAULT NULL,
  `level_after`  DECIMAL(4,1) DEFAULT NULL,
  
  -- 物理フロートスイッチの状態
  `main_top` BOOLEAN DEFAULT NULL,
  `main_bottom` BOOLEAN DEFAULT NULL,
  `sub` BOOLEAN DEFAULT NULL,

  -- 作成日時
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  -- 履歴検索用の索引
  INDEX `idx_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;




