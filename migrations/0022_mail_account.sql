-- 수신함 건이 어느 그룹웨어 메일함(계정)에서 왔는지 아이디만 남긴다(비밀번호는 서버에 두지 않는다).
ALTER TABLE applicant_inbox ADD COLUMN mail_account TEXT NOT NULL DEFAULT '';
