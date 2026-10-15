-- 직접 보내는 문자도 예약/큐로 처리한다.
-- messages.status: scheduled(예약/대기) → sending → sent | failed, 취소 시 cancelled
ALTER TABLE messages ADD COLUMN scheduled_at INTEGER;
CREATE INDEX idx_messages_sched ON messages(status, scheduled_at);
