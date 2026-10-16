-- 수신함: 원가중심점(지원한 곳) 지정. 같은 공고(공고번호)는 한 번 정하면 기억해서 이후 메일에 자동으로 붙인다.
ALTER TABLE applicant_inbox ADD COLUMN cost_center TEXT NOT NULL DEFAULT '';
CREATE TABLE inbox_cost_rules (
  recruit_no TEXT PRIMARY KEY,
  cost_center TEXT NOT NULL,
  updated_by INTEGER,
  updated_at INTEGER NOT NULL
);
