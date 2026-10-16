-- 쓰지 않는 폰 삭제: 기록이 남아 있는 폰은 행을 지우지 않고 삭제 표시만 한다(보낸 문자·면접 안내 기록 보존).
ALTER TABLE gateways ADD COLUMN deleted_at INTEGER;
