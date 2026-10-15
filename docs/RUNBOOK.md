# 운영 가이드

운영 주소: https://interview-sms.bigbears.workers.dev (Cloudflare Worker, 계정은 `npx wrangler whoami`로 확인)

## 1. 부서 폰 연결 (부서마다 1대)
1. 안드로이드 폰에 [SMS Gateway for Android](https://github.com/capcom6/android-sms-gateway) 설치, SMS 권한 허용
2. 앱의 **Cloud Server** 를 켜고 **Offline** 버튼을 눌러 **Online** 이 될 때까지 연결
   - 최초 연결 시 **Username / Password 가 자동 생성**되어 앱의 Cloud Server 화면에 표시된다.
   - (앱이 "QR 코드를 스캔하라"고 먼저 요구하면, 화면의 건너뛰기/수동 설정이 있는지 확인하고 아래 *QR 안내*를 본다.)
3. 배터리 최적화 제외, 백그라운드 실행 허용(그렇지 않으면 발송이 멈춘다)
4. (권장) 앱 Settings → Webhooks 에서 **Signing Key**를 확인하고 웹의 게이트웨이 등록 시 입력

### QR 안내
공식 문서의 클라우드 모드 절차에는 QR 스캔이 없다. QR 화면은 앱 버전에 따른 연결 마법사일 수 있다.
QR 로 연결되는 대상(서버 주소)이 `api.sms-gate.app`(공개 클라우드)인지 확인하고, 그 방식이 자체 서버(Private)용이라면
앱 설정에서 서버를 **Public Cloud**로 선택해야 한다. 막히면 화면 캡처를 보고 판단한다.

## 2. 웹에서 최초 설정 (전체 관리자)
1. `/login` — 아이디 `admin`, 비밀번호는 최초 배포 시 전달된 값 → **바로 `/password`에서 변경**
2. 관리 → 부서 추가
3. 관리 → 게이트웨이 추가: 앱에 표시된 Username/Password 입력 (API 주소/경로 기본값 유지)
4. 게이트웨이 목록의 **웹훅 등록** 클릭 (폰이 답장 수신 시 이 Worker 로 알려주게 한다)
5. 관리자 계정 추가: 담당 부서 ID 지정

## 3. 첫 시험
1. 본인 번호 1건만 담은 CSV 로 캠페인 생성 → 즉시 발송 (Cron 이 매 분 이어받음)
2. 문자를 받고 "참석"/"불참"으로 답장 → 캠페인 상세에서 상태 확인
3. 안 바뀌면: 웹훅 등록 여부, 서명 키 불일치(401), `inbound` 수신 로그, 폰 앱 로그 확인

## 4. 배포/변경
```bash
npm test
npm run db:migrate   # 스키마 변경이 있을 때
npm run deploy
npx wrangler tail    # 실시간 로그
```
시크릿 교체: `npx wrangler secret put ADMIN_PASSWORD` 등. **`ENCRYPTION_KEY`를 바꾸면 저장된 게이트웨이 비밀번호를 복호화할 수 없다** — 게이트웨이를 다시 등록해야 한다.

## 5. 백업
```bash
npx wrangler d1 export interview-sms --remote --output backup.sql
```
개인정보가 포함되므로 안전한 곳에 보관하고 보관기간 정책에 따라 삭제한다.

## 6. 장애 대응
| 증상 | 확인 |
|---|---|
| 발송이 시작되지 않음 | 캠페인 상태/예약 시각(KST), Cron 동작(`wrangler tail`) |
| 발송 실패(`failed`) | 폰 Online 여부, 게이트웨이 계정, 실패 사유 → "리마인드 발송"으로 재시도 |
| 답장이 반영 안 됨 | 웹훅 등록/서명 키(401), `inbound` 테이블 |
| "확인필요" 다수 | 답장 문구 확인 → `docs/PARSING_RULES.md` 규칙 보강 후 수동 확정 |
| 로그인 잠김 | 5분 대기 |
