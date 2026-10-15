-- 게이트웨이 폰 자신의 전화번호 (받기 시험용)
ALTER TABLE gateways ADD COLUMN own_number TEXT NOT NULL DEFAULT '';
