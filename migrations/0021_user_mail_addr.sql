-- 사람마다 자기 메일 수신 주소(apply-<이름>@도메인)를 갖는다. 이름은 본인이 바꿀 수 있다.
-- 이 주소로 온 알바몬 지원 메일은 그 사람의 수신함(owner)으로 들어간다.
CREATE TABLE user_mail_addr (
  user_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  updated_at INTEGER NOT NULL
);
