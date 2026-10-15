-- 게이트웨이(폰) 사용 중지 표시. 삭제 대신 중지해서 과거 발송 기록을 보존한다.
ALTER TABLE gateways ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
