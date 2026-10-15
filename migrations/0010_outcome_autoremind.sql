-- 면접 결과(출석/노쇼/합격/입사/불합격)와 자동 리마인드
-- outcome: ''(미입력) | showed | noshow | passed | hired | rejected
ALTER TABLE candidates ADD COLUMN outcome TEXT NOT NULL DEFAULT '';
ALTER TABLE candidates ADD COLUMN outcome_at INTEGER;
ALTER TABLE candidates ADD COLUMN reminded_at INTEGER;

ALTER TABLE campaigns ADD COLUMN auto_remind INTEGER NOT NULL DEFAULT 1;
ALTER TABLE campaigns ADD COLUMN remind_template TEXT NOT NULL DEFAULT '';
-- 이미 만들어 둔 면접 안내에는 자동 리마인드를 적용하지 않는다 (예상 못 한 발송 방지)
UPDATE campaigns SET auto_remind = 0;

CREATE INDEX idx_cand_remind ON candidates(status, reminded_at);
