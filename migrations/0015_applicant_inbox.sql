-- 메일로 들어온 지원 알림(알바몬 등)을 모아 두는 수신함
-- 메일 원문은 저장하지 않고, 해석한 항목만 남긴다. 연락처는 메일에 없어서 이력서 페이지에서 가져와 등록할 때 채운다.
CREATE TABLE applicant_inbox (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'albamon',
  apply_no TEXT NOT NULL,                 -- 지원 번호(중복 방지 기준)
  recruit_no TEXT NOT NULL DEFAULT '',    -- 공고 번호
  company TEXT NOT NULL DEFAULT '',       -- 근무회사명
  job_title TEXT NOT NULL DEFAULT '',     -- 공고 제목
  name TEXT NOT NULL DEFAULT '',
  gender TEXT NOT NULL DEFAULT '',
  age INTEGER,
  address TEXT NOT NULL DEFAULT '',
  education TEXT NOT NULL DEFAULT '',
  career TEXT NOT NULL DEFAULT '',
  resume_url TEXT NOT NULL DEFAULT '',    -- "이력서 보기" 링크
  received_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | registered | ignored
  applicant_id INTEGER,
  handled_by INTEGER,
  handled_at INTEGER,
  UNIQUE (source, apply_no)
);
CREATE INDEX idx_inbox_status ON applicant_inbox(status, received_at);
