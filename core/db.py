import mariadb  # 以前と同じライブラリを使用
import logging
import threading
from datetime import datetime, timedelta
from decimal import Decimal

logger = logging.getLogger(__name__)

class HydroDB:
    def __init__(self, config):
        self.config = config
        self.lock_db = threading.Lock()
        try:
            self.conn = mariadb.connect(
                user=config.DB_USER,
                password=config.DB_PASSWORD,
                host=config.DB_HOST,
                port=3306,
                database=config.DB_NAME
            )
            self.conn.autocommit = True
            logger.info("MariaDB connected successfully.")
        except mariadb.Error as e:
            logger.error(f"Error connecting to MariaDB: {e}")
            raise

    def _check_connection(self):
        """接続が生きているか確認し、切れていれば再接続する"""
        try:
            self.conn.ping()
        except Exception:
            logger.warning("MariaDB connection lost. Reconnecting...")
            self.conn = mariadb.connect(
                user=self.config.DB_USER,
                password=self.config.DB_PASSWORD,
                host=self.config.DB_HOST,
                port=3306,
                database=self.config.DB_NAME
            )
            self.conn.autocommit = True

    def _serialize_value(self, value):
        if isinstance(value, datetime):
            return value.strftime('%Y/%m/%d %H:%M:%S')
        if isinstance(value, Decimal):
            return float(value)
        return value

    def exec(self, sql, params=None):
        with self.lock_db:
            try:
                self._check_connection()
                cur = self.conn.cursor()
                cur.execute(sql, params or ())
                cur.close()
                self.conn.commit()
                return True
            except mariadb.Error as e:
                logger.error(f"mariadb.Error: {e}")
                return False

    def getkeys(self, cur, table):
        sql = f"DESCRIBE {table}"
        cur.execute(sql)
        return [row[0] for row in cur.fetchall()]

    def getcolumn(self, table, columns):
        with self.lock_db:
            try:
                self._check_connection()
                cur = self.conn.cursor()
                cols = ','.join(columns)
                sql = f"SELECT {cols} FROM {table} WHERE no = 1"
                cur.execute(sql)
                row = cur.fetchone()
                cur.close()
                if row is None:
                    return {}
                return {column: self._serialize_value(row[i]) for i, column in enumerate(columns)}
            except mariadb.Error as e:
                logger.error(f"mariadb.Error: {e}")
                return {}

    def get(self, table, condition=None):
        with self.lock_db:
            try:
                self._check_connection()
                cur = self.conn.cursor()
                keys = self.getkeys(cur, table)
                if condition is None:
                    sql = f"SELECT * FROM {table}"
                else:
                    sql = f"SELECT * FROM {table} {condition}"
                cur.execute(sql)
                rows = cur.fetchall()
                result = []
                for row in rows:
                    data = {}
                    for i in range(0, len(row)):
                        data[keys[i]] = self._serialize_value(row[i])
                    result.append(data)
                cur.close()
                return result
            except mariadb.Error as e:
                logger.error(f"mariadb.Error: {e}")
                return []

    def getone(self, table):
        data = self.get(table, "WHERE no = 1")
        return data[0] if data else {}

    def getlatest(self, table, num=1):
        data = self.get(table, f"ORDER BY no DESC LIMIT {num}")
        if num == 1:
            return data[0] if data else {}
        return data

    def insert(self, table, data):
        with self.lock_db:
            try:
                self._check_connection()
                cur = self.conn.cursor()
                keys = self.getkeys(cur, table)
                columns = []
                values = []
                params = []
                for key in keys:
                    if key in data and key != 'no':
                        columns.append(key)
                        values.append('?')
                        params.append(data[key])
                if not columns:
                    cur.close()
                    return -1
                sql = f"INSERT INTO {table} ({','.join(columns)}) VALUES ({','.join(values)})"
                cur.execute(sql, params)
                lastrowid = cur.lastrowid
                cur.close()
                self.conn.commit()
                return lastrowid
            except mariadb.Error as e:
                logger.error(f"mariadb.Error: {e}")
                return -1

    def updateone(self, table, data):
        with self.lock_db:
            try:
                self._check_connection()
                cur = self.conn.cursor()
                keys = self.getkeys(cur, table)
                assignments = []
                params = []
                for key in keys:
                    if key in data and key != 'no':
                        assignments.append(f"{key} = ?")
                        params.append(data[key])
                if not assignments:
                    cur.close()
                    return False
                sql = f"UPDATE {table} SET {', '.join(assignments)} WHERE no = 1"
                cur.execute(sql, params)
                cur.close()
                self.conn.commit()
                return True
            except mariadb.Error as e:
                logger.error(f"mariadb.Error: {e}")
                return False

    def get_settings(self, table_name):
        return self.getone(table_name)

    def get_basic(self):
        basic = self.getone('setting_basic')
        if basic:
            basic['myid'] = self.config.DB_NAME
        return basic

    def get_schedule(self):
        return self.getone('setting_schedule')

    def get_sensor_limit(self):
        return self.getone('setting_sensor_limit')

    def get_latest_picture(self, picture_dir):
        result = self.getlatest('picture')
        if not result:
            return {}
        return {
            'picture_path': f"{picture_dir}/{result['filename']}",
            'picture_taken': result.get('taken') or result.get('created_at')
        }

    def get_latest_report(self):
        return self.getlatest('report')

    def make_refill_record_string(self, data):
        before = 'ー' if data.get('level_before') is None else f"{data['level_before']}"
        after = 'ー' if data.get('level_after') is None else f"{data['level_after']}"
        main_top = 'ー' if data.get('main_top') is None else ('○' if data['main_top'] == 1 else '×')
        main_bottom = 'ー' if data.get('main_bottom') is None else ('○' if data['main_bottom'] == 1 else '×')
        sub = 'ー' if data.get('sub') is None else ('○' if data['sub'] == 1 else '×')
        return f"{data.get('created_at')}({data.get('on_seconds')} sec) {data.get('trigger')} 上:{main_top} 下:{main_bottom} 補:{sub} （{before}％→{after}％)"

    def get_latest_refill_record(self):
        """最新3件の給水履歴を改行で連結した1本の文字列としてフロントに返す"""
        dic_array = self.getlatest('refill_record', 3)
        
        # 3件のログ文字列をリスト化
        records_list = [self.make_refill_record_string(data) for data in dic_array]
        
        # 💡 サーバー側で最初から改行コードで合体させる（末尾にも改行を付与）
        joined_string = "\n".join(records_list) + "\n" if records_list else ""
            
        return {
            'refill_records': joined_string
        }

    def set_basic(self, data):
        now = datetime.now()
        setdata = {f"{data['kind']}ed": now.strftime('%Y/%m/%d %H:%M:%S')}
        return self.updateone('setting_basic', setdata)

    def set_schedule(self, data):
        return self.updateone('setting_schedule', data)

    def set_sensor_limit(self, data):
        return self.updateone('setting_sensor_limit', data)

    def set_pump_status(self, data):
        end_time = datetime.now() + timedelta(seconds=data['seconds'])
        return self.updateone('pump_status', {'status': data['status'], 'end_time': end_time.strftime('%Y/%m/%d %H:%M:%S')})

    def get_pump_status(self):
        row = self.getone('pump_status')
        if not row:
            return {'pump_status': 'manual_stop', 'seconds': 0}
        end = datetime.strptime(row.get('end_time'), '%Y/%m/%d %H:%M:%S') if row.get('end_time') else None
        seconds = 0
        if end:
            seconds = (end - datetime.now()).total_seconds()
            if seconds < 0:
                seconds = 0
                row['status'] = 'error_stop'
        return {'pump_status': row.get('status', 'manual_stop'), 'seconds': seconds}

    def insert_picture(self, data):
        return self.insert('picture', data)

    def insert_report(self, data):
        return self.insert('report', data)

    def insert_refill_record(self, data):
        return self.insert('refill_record', data)

    def countup_sensor_error(self, sensor, limit):
        data = self.getone('sensor_error')
        if sensor not in data:
            logger.error(f"Unknown sensor key: {sensor}")
            return False
        data[sensor] = data.get(sensor, 0) + 1
        over_limit = False
        if data[sensor] == limit:
            data[sensor] = 0
            over_limit = True
        self.updateone('sensor_error', data)
        return over_limit

    def __del__(self):
        try:
            self.conn.close()
        except Exception:
            pass
