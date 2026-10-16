-- 지원자·블랙리스트 관리 모듈 (문자 관리 시스템과 독립된 별도 데이터)
-- applicants      : 사람(전화번호 기준 1명)
-- applicant_applications : 지원 건(지원한 곳, 직무)
-- blacklist       : 블랙리스트 등록 이력. status: active | released (수동 해제만, 자동 만료 없음)
-- applicant_events: 변경 기록(누가, 언제, 무엇)
CREATE TABLE applicants (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  memo TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'manual',   -- manual | paste | linked(문자 시스템 연결, 이후 단계)
  created_by INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_applicants_name ON applicants(name);

CREATE TABLE applicant_applications (
  id INTEGER PRIMARY KEY,
  applicant_id INTEGER NOT NULL REFERENCES applicants(id) ON DELETE CASCADE,
  applied_to TEXT NOT NULL DEFAULT '',
  job TEXT NOT NULL DEFAULT '',
  created_by INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_applications_applicant ON applicant_applications(applicant_id);

CREATE TABLE blacklist (
  id INTEGER PRIMARY KEY,
  applicant_id INTEGER NOT NULL REFERENCES applicants(id) ON DELETE CASCADE,
  reason_code TEXT NOT NULL,               -- noshow | absent | false_info | misconduct | other
  reason_text TEXT NOT NULL DEFAULT '',    -- 기타는 필수
  status TEXT NOT NULL DEFAULT 'active',   -- active | released
  created_by INTEGER,
  created_at INTEGER NOT NULL,
  released_by INTEGER,
  released_at INTEGER,
  release_note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_blacklist_applicant ON blacklist(applicant_id, status);

CREATE TABLE applicant_events (
  id INTEGER PRIMARY KEY,
  applicant_id INTEGER NOT NULL REFERENCES applicants(id) ON DELETE CASCADE,
  action TEXT NOT NULL,                    -- create | edit | apply | blacklist | release
  detail TEXT NOT NULL DEFAULT '',
  user_id INTEGER,
  at INTEGER NOT NULL
);
CREATE INDEX idx_applicant_events ON applicant_events(applicant_id, id);
