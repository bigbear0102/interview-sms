-- 그룹웨어 메일 읽는 방식: 'pop3'(기본, 웹 로그인은 그룹웨어가 서버 접속을 처리하지 못함) | 'web'
-- 그룹웨어 POP3(110)는 암호화를 지원하지 않는다. 사용자가 위험을 알고 승인(2026-10-17).
ALTER TABLE gw_accounts ADD COLUMN mode TEXT NOT NULL DEFAULT 'pop3';
-- POP3 에 성공한 아이디 형식(전체 주소 또는 아이디만)을 기억한다(틀린 시도를 줄여 잠김 방지)
ALTER TABLE gw_accounts ADD COLUMN pop3_user TEXT NOT NULL DEFAULT '';
