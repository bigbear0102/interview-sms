-- 채용 워크플로우: 전날 리마인드, 답 없으면 한 번 더, 일정 고르기, 일정 변경 요청, 결과 안내 문자
-- 이미 만들어 둔 면접 안내에는 새 자동 발송을 적용하지 않는다(기본값 0).
ALTER TABLE campaigns ADD COLUMN remind_prev INTEGER NOT NULL DEFAULT 0;      -- 면접 전날 17:00 리마인드
ALTER TABLE campaigns ADD COLUMN auto_followup INTEGER NOT NULL DEFAULT 0;    -- 답이 없으면 한 번 더 보내기
ALTER TABLE campaigns ADD COLUMN slots TEXT NOT NULL DEFAULT '';              -- 일정 고르기 후보(줄바꿈 구분). 비어 있으면 정해진 일시 안내

ALTER TABLE candidates ADD COLUMN reminded_prev_at INTEGER;                   -- 전날 리마인드 보낸 시각
ALTER TABLE candidates ADD COLUMN followed_at INTEGER;                        -- 자동으로 한 번 더 보낸 시각
ALTER TABLE candidates ADD COLUMN reply_kind TEXT NOT NULL DEFAULT '';        -- '' | reschedule (일정 변경 요청)
ALTER TABLE candidates ADD COLUMN template_override TEXT NOT NULL DEFAULT ''; -- 이 사람에게만 다른 문구(일정 다시 안내)
ALTER TABLE candidates ADD COLUMN result_sent_at INTEGER;                     -- 결과 안내 문자 보낸 시각

CREATE INDEX idx_cand_followup ON candidates(status, followed_at);
