-- 2단계: 전달 결과 추적, 자동 재시도, 새 답장 알림
-- delivery: ''(미추적) | queued(문자 서버가 접수) | sent(폰이 통신사로 보냄) | delivered(상대 단말 전달) | failed
ALTER TABLE candidates ADD COLUMN gw_msg_id TEXT NOT NULL DEFAULT '';
ALTER TABLE candidates ADD COLUMN delivery TEXT NOT NULL DEFAULT '';
ALTER TABLE candidates ADD COLUMN delivered_at INTEGER;
ALTER TABLE candidates ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE candidates ADD COLUMN next_retry_at INTEGER;

ALTER TABLE messages ADD COLUMN gw_msg_id TEXT NOT NULL DEFAULT '';
ALTER TABLE messages ADD COLUMN delivery TEXT NOT NULL DEFAULT '';
ALTER TABLE messages ADD COLUMN delivered_at INTEGER;
ALTER TABLE messages ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_cand_gwmsg ON candidates(gw_msg_id) WHERE gw_msg_id != '';
CREATE INDEX idx_msg_gwmsg ON messages(gw_msg_id) WHERE gw_msg_id != '';

-- 받은 문자 읽음 표시(부서 공유 받은편지함), 새 답장 메일 알림(사용자별 선택)
ALTER TABLE inbound ADD COLUMN read_at INTEGER;
UPDATE inbound SET read_at = received_at;      -- 기존 문자는 읽은 것으로 본다
ALTER TABLE users ADD COLUMN notify_replies INTEGER NOT NULL DEFAULT 0;
