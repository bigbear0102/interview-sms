-- 업로드 묶음(되돌리기용). 업로드로 생긴 사람·지원 건·블랙리스트·기록에 batch_id 를 남긴다.
ALTER TABLE applicants ADD COLUMN batch_id TEXT NOT NULL DEFAULT '';
ALTER TABLE applicant_applications ADD COLUMN batch_id TEXT NOT NULL DEFAULT '';
ALTER TABLE blacklist ADD COLUMN batch_id TEXT NOT NULL DEFAULT '';
ALTER TABLE applicant_events ADD COLUMN batch_id TEXT NOT NULL DEFAULT '';

CREATE TABLE applicant_batches (
  id TEXT PRIMARY KEY,
  user_id INTEGER,
  created_at INTEGER NOT NULL,
  rows_total INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL DEFAULT 0,      -- 새로 등록한 사람
  added INTEGER NOT NULL DEFAULT 0,        -- 이미 있던 사람에게 새 내용을 추가한 수
  blacklisted INTEGER NOT NULL DEFAULT 0,  -- 블랙리스트로 등록한 수
  duplicates INTEGER NOT NULL DEFAULT 0,   -- 새 내용이 없어서 올리지 않은 줄
  undone_at INTEGER
);
CREATE INDEX idx_applicant_batches_at ON applicant_batches(created_at);
CREATE INDEX idx_applicants_batch ON applicants(batch_id) WHERE batch_id != '';
CREATE INDEX idx_applications_batch ON applicant_applications(batch_id) WHERE batch_id != '';
CREATE INDEX idx_blacklist_batch ON blacklist(batch_id) WHERE batch_id != '';
CREATE INDEX idx_events_batch ON applicant_events(batch_id) WHERE batch_id != '';
