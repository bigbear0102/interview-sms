-- 폰(게이트웨이) 상태 감시와 오류 기록
ALTER TABLE gateways ADD COLUMN health TEXT NOT NULL DEFAULT 'unknown';  -- unknown | ok | warn | down
ALTER TABLE gateways ADD COLUMN health_note TEXT NOT NULL DEFAULT '';
ALTER TABLE gateways ADD COLUMN health_checked_at INTEGER;
ALTER TABLE gateways ADD COLUMN last_seen_at INTEGER;   -- 폰이 서버에 마지막으로 응답한 시각
ALTER TABLE gateways ADD COLUMN alerted_at INTEGER;     -- 장애 알림 메일을 마지막으로 보낸 시각

CREATE TABLE error_log (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  scope TEXT NOT NULL,          -- request | cron | monitor
  path TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL
);
CREATE INDEX idx_error_log_at ON error_log(at);
