-- 직원 회원가입(이메일 인증) 지원
ALTER TABLE users ADD COLUMN name TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN email TEXT;
ALTER TABLE users ADD COLUMN phone TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN email_verified_at INTEGER;   -- NULL 이면 이메일 인증 전(로그인 불가)
ALTER TABLE users ADD COLUMN created_at INTEGER;
CREATE UNIQUE INDEX idx_users_email ON users(email) WHERE email IS NOT NULL;

-- 이메일 인증/비밀번호 재설정 링크 (토큰은 SHA-256 해시만 저장, 1회용, 만료 있음)
CREATE TABLE email_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  purpose TEXT NOT NULL,            -- 'verify' | 'reset'
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX idx_email_tokens_user ON email_tokens(user_id, purpose);

-- 가입/메일 재발송 횟수 제한
CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  n INTEGER NOT NULL DEFAULT 0,
  reset_at INTEGER NOT NULL
);

-- 기존 계정은 인증된 것으로 본다
UPDATE users SET email_verified_at = CAST(strftime('%s','now') AS INTEGER) * 1000, created_at = CAST(strftime('%s','now') AS INTEGER) * 1000
  WHERE email_verified_at IS NULL;

-- 부서 목록: 기존 'HR' 은 'HR본부' 로 이름을 맞추고, 나머지는 추가
UPDATE departments SET name = 'HR본부'
  WHERE name = 'HR' AND NOT EXISTS (SELECT 1 FROM departments WHERE name = 'HR본부');
INSERT OR IGNORE INTO departments (name) VALUES
  ('임원실'), ('경영지원본부'), ('마케팅영업본부'), ('CRM운영본부'), ('물류사업본부'), ('윌비모터스'),
  ('HR본부'), ('FM사업부문'), ('IT사업본부'), ('지사'), ('동부캐리어'), ('센터');
