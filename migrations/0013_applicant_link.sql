-- 지원자 관리 ↔ 문자 시스템 연결 설정, 노쇼 후보 제안 무시 기록
CREATE TABLE applicant_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

CREATE TABLE applicant_suggest_dismissed (
  phone TEXT PRIMARY KEY,
  dismissed_count INTEGER NOT NULL DEFAULT 0,   -- 무시할 때의 노쇼 횟수. 이보다 늘어나면 다시 제안한다
  dismissed_at INTEGER NOT NULL,
  user_id INTEGER
);
