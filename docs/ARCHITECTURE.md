# 아키텍처

## 구성 (현재: PC 직접 운영)
- **면접 웹** (`src/node/server.js` → `src/worker.js`): 화면(SSR), 웹훅 수신, 10초 주기 발송 큐. SQLite `data/app.db`
- **SMS 게이트웨이 서버** (Docker `deploy/gateway`): Private 모드. 폰 앱이 여기에 등록되고, 웹이 `/api/3rdparty/v1/*` 로 발송
- **Cloudflare Tunnel** `interview-sms`: `interview.bigbears.me`→웹, `sms.bigbears.me`→게이트웨이 (PC 는 인바운드 포트를 열지 않음)
- **폰**: SMS Gateway 앱 → `https://sms.bigbears.me/api/mobile/v1` + Private Token
- (대체 배포) Cloudflare Workers + D1 + Cron: `wrangler.jsonc`. 같은 핸들러를 사용한다.
- 문서상 Private 모드에서도 폰 깨우기용 푸시(FCM) 신호는 upstream(`api.sms-gate.app`)을 경유한다. 문자 내용은 우리 서버에만 있다.

## 데이터 모델 (`migrations/0001_init.sql`)
```
departments 1─N gateways 1─N campaigns 1─N candidates
users N─M departments (user_departments)
inbound: 수신 문자 로그, audit: 감사 로그, login_fail: 로그인 잠금, sessions
```
- `campaigns.status`: draft → scheduled → sending → done / cancelled
- `candidates.status`: pending → sending(선점) → sent → attending | absent | unclear, 또는 failed
- `candidates.manual=1`: 관리자 수동 확정. 이후 답장이 와도 상태는 바꾸지 않고 원문만 기록.
- 사업장은 별도 테이블 없이 `candidates.site` 문자열. `GROUP BY site`로 집계.
- `gateways.password`는 AES-GCM(`ENCRYPTION_KEY`)으로 암호화 저장. 세션 토큰은 SHA-256 해시만 저장.

## 처리 흐름
1. **생성**: CSV → `candidatesFromCsv` → `createCampaign` (정규화, 사업장 없음/번호 오류/중복 제외, 19행씩 batch insert)
2. **발송**: `scheduleCampaign`(예약/즉시) → Cron 의 `processQueue`가 `scheduled_at` 도래 시 `sending`으로 전환
   - 건을 `sending`으로 **선점**(원자적 UPDATE)한 뒤 발송 → `sent`/`failed`. 5분 넘게 `sending`이면 `pending`으로 복구.
   - 호출 1회당 `SEND_BATCH`(25)건. 즉시 발송 버튼은 `ctx.waitUntil`로 바로 1회 실행하고 나머지는 Cron 이 이어받는다.
   - 처리량 ≈ 25건/분 (= 1,500건/시간). 늘리려면 유료 플랜에서 `SEND_BATCH`를 올린다.
3. **수신**: `POST /hook/:gatewayId/:token` → HMAC 검증 → `handleInbound`
   - 매칭: 같은 게이트웨이로 발송한 건 중 해당 번호의 **가장 최근 발송 건**
4. **리마인드**: `remindCampaign` — `sent`/`failed`를 `pending`으로 되돌리고 즉시 재발송
5. **파기**: `purgeExpired` — `COALESCE(scheduled_at, created_at) + retention_days` 경과 시
   이름/번호/문자 원문 삭제, 사업장·상태 통계만 남김

## 인증/권한/보안
- 아이디+비밀번호(PBKDF2-SHA256 100k), 세션 쿠키(HttpOnly, Secure, SameSite=Strict, 12시간)
- 로그인 5회 실패 시 해당 IP 5분 잠금(D1 `login_fail`)
- CSRF: POST 의 `Origin` 호스트가 요청 호스트와 다르면 403
- `super`: 전체 + 관리/감사 메뉴 / `admin`: 배정된 부서의 캠페인만
- 감사 로그: 로그인, 발송, 취소, 리마인드, 수동 확정, 내보내기, 관리 변경 (개인정보 미포함)
- 웹훅: URL 비밀 토큰 + `X-Signature` HMAC(설정 시) + ±5분 타임스탬프

## 한도/주의
- 무료 플랜 서브리퀘스트 한도(호출당 50)와 CPU 시간(10ms)을 고려해 설계했다. 한도 문제가 생기면 Workers 유료 플랜(Paid)으로 올리고 `SEND_BATCH`를 키운다.
- D1 쿼리당 바인딩 100개 제한 → 대량 insert 는 19행(5컬럼)씩 분할.
