-- 자동 가져오기(5분마다)에서 실패한 건을 무한히 다시 열지 않도록 실패 횟수를 센다
ALTER TABLE applicant_inbox ADD COLUMN fetch_tries INTEGER NOT NULL DEFAULT 0;
