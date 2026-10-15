-- 직접 발송한 문자(캠페인과 무관) 기록. 수신 문자는 inbound 테이블을 그대로 사용한다.
CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  gateway_id INTEGER NOT NULL REFERENCES gateways(id),
  phone TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL,                -- sent | failed
  error TEXT NOT NULL DEFAULT '',
  user_id INTEGER REFERENCES users(id),
  at INTEGER NOT NULL
);
CREATE INDEX idx_messages_at ON messages(at);
