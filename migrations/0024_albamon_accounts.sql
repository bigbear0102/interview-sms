-- 알바몬 기업회원 계정 여러 개(관리자 등록). 비밀번호는 ENCRYPTION_KEY 로 암호화해 저장하고,
-- 관리자 계정에 연결된 확장 프로그램에만 내려준다. 확장이 계정을 바꿔 가며 이력서를 연다.
CREATE TABLE albamon_accounts (
  id INTEGER PRIMARY KEY,
  label TEXT NOT NULL,                 -- 화면 이름(예: 아마노 현장HR)
  login_id TEXT NOT NULL UNIQUE,
  pw_enc TEXT NOT NULL,                -- AES-GCM(ENCRYPTION_KEY)
  active INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,         -- 비밀번호를 바꾸면 갱신(확장이 막아 둔 계정을 다시 시도하는 기준)
  last_ok_at INTEGER,
  last_error TEXT NOT NULL DEFAULT '',
  last_error_at INTEGER,
  created_at INTEGER NOT NULL
);
-- 공고(알바몬 공고 번호)가 어느 계정 것인지: 처음 연락처를 가져온 계정으로 저절로 배운다
CREATE TABLE recruit_accounts (
  recruit_no TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL,
  learned_at INTEGER NOT NULL
);
