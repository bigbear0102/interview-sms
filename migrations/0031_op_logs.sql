-- 진행 기록: 오래 걸리는 작업을 기다리는 동안 화면에 보여 줄 서버 단계(개인정보 없음, 하루 뒤 삭제)
CREATE TABLE IF NOT EXISTS op_logs (
  op TEXT NOT NULL,          -- 화면이 만든 작업 번호
  user_id INTEGER NOT NULL,  -- 본인 기록만 읽는다
  at INTEGER NOT NULL,
  msg TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_op_logs ON op_logs(op, at);
