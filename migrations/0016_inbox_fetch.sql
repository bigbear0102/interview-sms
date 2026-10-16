-- 수신함: 이력서에서 연락처를 가져오는 요청 상태(에이전트가 처리)
ALTER TABLE applicant_inbox ADD COLUMN phone TEXT NOT NULL DEFAULT '';
ALTER TABLE applicant_inbox ADD COLUMN fetch_state TEXT NOT NULL DEFAULT '';  -- '' | requested | done | failed
ALTER TABLE applicant_inbox ADD COLUMN fetch_note TEXT NOT NULL DEFAULT '';
ALTER TABLE applicant_inbox ADD COLUMN fetch_at INTEGER;
CREATE INDEX idx_inbox_fetch ON applicant_inbox(fetch_state, status);
