-- 서버가 그룹웨어에 직접 접속해 알바몬 지원 메일을 1분마다 가져온다(PC·확장 없이).
-- 비밀번호·로그인 세션은 ENCRYPTION_KEY 로 암호화해 저장한다(사용자 결정 2026-10-17).
CREATE TABLE gw_accounts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,             -- 가져온 메일이 들어갈 사람(새 지원 담당자)
  login_id TEXT NOT NULL,               -- 그룹웨어 아이디(메일 주소의 @ 앞)
  pw_enc TEXT NOT NULL,
  session_enc TEXT NOT NULL DEFAULT '', -- 로그인 쿠키(매번 로그인하지 않게)
  active INTEGER NOT NULL DEFAULT 1,
  blocked INTEGER NOT NULL DEFAULT 0,   -- 비밀번호가 틀려 쉬는 중(계정 잠김 방지, 비밀번호를 고치면 풀림)
  updated_at INTEGER NOT NULL,
  last_check_at INTEGER,
  last_ok_at INTEGER,
  last_error TEXT NOT NULL DEFAULT '',
  last_added INTEGER NOT NULL DEFAULT 0,
  diag TEXT NOT NULL DEFAULT '',        -- 마지막 접속 단계 기록(비밀값 없음, 문제 진단용)
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, login_id)
);
-- 이미 읽은 메일(다시 본문을 받지 않게)
CREATE TABLE gw_seen (
  account_id INTEGER NOT NULL,
  mail_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (account_id, mail_id)
);
