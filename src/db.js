import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS departments (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE
);

-- 부서별 안드로이드 폰 1대 = 게이트웨이 1개 (android-sms-gateway 앱)
CREATE TABLE IF NOT EXISTS gateways (
  id INTEGER PRIMARY KEY,
  department_id INTEGER NOT NULL REFERENCES departments(id),
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,            -- 예: http://192.168.0.20:8080
  username TEXT NOT NULL,
  password TEXT NOT NULL,
  send_path TEXT NOT NULL DEFAULT '/message',
  signing_key TEXT NOT NULL DEFAULT '',  -- 앱 설정의 Webhooks Signing Key
  hook_token TEXT NOT NULL            -- 웹훅 URL 비밀 토큰
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',   -- 'super' | 'admin'
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS user_departments (
  user_id INTEGER NOT NULL REFERENCES users(id),
  department_id INTEGER NOT NULL REFERENCES departments(id),
  PRIMARY KEY (user_id, department_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY,
  department_id INTEGER NOT NULL REFERENCES departments(id),
  gateway_id INTEGER NOT NULL REFERENCES gateways(id),
  name TEXT NOT NULL,
  template TEXT NOT NULL,
  scheduled_at INTEGER,                  -- epoch ms, NULL = 아직 발송 예약 안 함
  status TEXT NOT NULL DEFAULT 'draft',  -- draft | scheduled | sending | done | cancelled
  retention_days INTEGER NOT NULL DEFAULT 90,
  created_by INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL,
  purged_at INTEGER
);

CREATE TABLE IF NOT EXISTS candidates (
  id INTEGER PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
  site TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL,
  interview_at TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending', -- pending | sent | attending | absent | unclear | failed
  message_text TEXT NOT NULL DEFAULT '',
  sent_at INTEGER,
  reply_text TEXT NOT NULL DEFAULT '',
  replied_at INTEGER,
  manual INTEGER NOT NULL DEFAULT 0,      -- 관리자가 수동 확정한 경우 1
  error TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_cand_campaign ON candidates(campaign_id, site, status);
CREATE INDEX IF NOT EXISTS idx_cand_phone ON candidates(phone);

CREATE TABLE IF NOT EXISTS inbound (
  id INTEGER PRIMARY KEY,
  gateway_id INTEGER NOT NULL,
  sender TEXT NOT NULL,
  message TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  candidate_id INTEGER,
  result TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY, value TEXT NOT NULL
);
`;

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}
