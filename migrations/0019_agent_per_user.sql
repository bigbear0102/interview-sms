-- 사람마다 자기 연결 키(확장 프로그램용)를 갖고, 수신함 건에는 담당자(owner)가 붙는다.
-- owner_user_id 가 NULL 인 건은 담당자 없는 공용 건(기존 건, 공용 수신 주소로 온 메일)이다.
CREATE TABLE agent_tokens (
  user_id INTEGER PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
ALTER TABLE applicant_inbox ADD COLUMN owner_user_id INTEGER;
CREATE INDEX idx_inbox_owner ON applicant_inbox(owner_user_id, status);
