-- 종단간 암호화(passphrase 방식) 비밀번호. 앱의 Settings → Encryption 에 정한 값과 같아야 한다.
-- ENCRYPTION_KEY 로 암호화해 저장한다. 비어 있으면 암호화하지 않고 보낸다.
ALTER TABLE gateways ADD COLUMN passphrase TEXT NOT NULL DEFAULT '';
