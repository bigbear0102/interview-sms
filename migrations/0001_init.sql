-- 면접 참석 확인 시스템 스키마 (Cloudflare D1 / SQLite)
CREATE TABLE departments (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE
);

-- 부서별 안드로이드 폰 1대 = 게이트웨이 1개 (SMS Gateway 클라우드 서버 모드 계정)
CREATE TABLE gateways (
  id INTEGER PRIMARY KEY,
  department_id INTEGER NOT NULL REFERENCES departments(id),
  name TEXT NOT NULL,
  base_url TEXT NOT NULL DEFAULT 'https://api.sms-gate.app/3rdparty/v1',
  username TEXT NOT NULL,
  password TEXT NOT NULL,               -- AES-GCM 암호화 저장 (ENCRYPTION_KEY)
  send_path TEXT NOT NULL DEFAULT '/messages',
  signing_key TEXT NOT NULL DEFAULT '', -- 앱의 Webhooks Signing Key
  hook_token TEXT NOT NULL              -- 웹훅 URL 비밀 토큰
);

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',   -- 'super' | 'admin'
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE user_departments (
  user_id INTEGER NOT NULL REFERENCES users(id),
  department_id INTEGER NOT NULL REFERENCES departments(id),
  PRIMARY KEY (user_id, department_id)
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,          -- 세션 토큰의 SHA-256
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL
);

CREATE TABLE login_fail (
  ip TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0, until INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE campaigns (
  id INTEGER PRIMARY KEY,
  department_id INTEGER NOT NULL REFERENCES departments(id),
  gateway_id INTEGER NOT NULL REFERENCES gateways(id),
  name TEXT NOT NULL,
  template TEXT NOT NULL,
  scheduled_at INTEGER,                  -- epoch ms
  status TEXT NOT NULL DEFAULT 'draft',  -- draft | scheduled | sending | done | cancelled
  retention_days INTEGER NOT NULL DEFAULT 90,
  created_by INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL,
  purged_at INTEGER
);

CREATE TABLE candidates (
  id INTEGER PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
  site TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL,
  interview_at TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending', -- pending | sending | sent | attending | absent | unclear | failed
  message_text TEXT NOT NULL DEFAULT '',
  sent_at INTEGER,                        -- 발송 시각 (sending 상태에서는 선점 시각)
  reply_text TEXT NOT NULL DEFAULT '',
  replied_at INTEGER,
  manual INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_cand_campaign ON candidates(campaign_id, site, status);
CREATE INDEX idx_cand_phone ON candidates(phone);

CREATE TABLE inbound (
  id INTEGER PRIMARY KEY,
  gateway_id INTEGER NOT NULL,
  sender TEXT NOT NULL,
  message TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  candidate_id INTEGER,
  result TEXT NOT NULL DEFAULT ''
);

CREATE TABLE audit (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  user_id INTEGER,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
