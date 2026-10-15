# 아키텍처

## 구성
- 단일 Node 프로세스: HTTP 서버 + 발송 큐(10초 주기) + 파기 작업(1시간 주기)
- SQLite 파일(`data/app.db`, WAL). 백업은 이 파일 복사.
- 폰(SMS Gateway 앱)은 **로컬 서버 모드**로 PC가 직접 호출한다. 수신은 폰이 PC의 웹훅 URL로 POST.

## 데이터 모델 (`src/db.js`)
```
departments 1─N gateways 1─N campaigns 1─N candidates
users N─M departments (user_departments)
inbound: 수신 문자 로그 (매칭 여부 포함)
```
- `campaigns.status`: draft → scheduled → sending → done / cancelled
- `candidates.status`: pending → sent → attending | absent | unclear, 또는 failed
- `candidates.manual=1`: 관리자 수동 확정. 이후 답장이 와도 상태는 바꾸지 않고 원문만 기록.
- 사업장은 별도 테이블 없이 `candidates.site` 문자열. 사업장 수천 개여도 `GROUP BY site`로 집계.

## 처리 흐름
1. **생성**: CSV → `candidatesFromCsv` → `createCampaign` (전화번호 정규화, 사업장 없음/번호 오류/중복 제외)
2. **발송**: `scheduleCampaign`(예약/즉시) → `processQueue`가 `scheduled_at` 도래 시 `sending`으로 전환,
   지원자별 `sendSms` 후 `SEND_INTERVAL_MS` 대기(통신사 제한 회피)
3. **수신**: `POST /hook/:gatewayId/:token` → HMAC 검증 → `handleInbound`
   - 매칭 규칙: 같은 게이트웨이로 발송한 건 중 해당 번호의 **가장 최근 발송 건**
   - 같은 번호가 사업장 여러 곳에 지원했다면 최신 발송 건 하나에 반영된다(알려진 한계).
4. **리마인드**: `remindCampaign` — `sent`/`failed`를 `pending`으로 되돌리고 즉시 재발송
5. **파기**: `purgeExpired` — `COALESCE(scheduled_at, created_at) + retention_days` 경과 시
   이름/번호/문자 원문 삭제, 사업장·상태 통계만 남김

## 인증/권한
- 아이디+비밀번호(scrypt), 세션 쿠키(HttpOnly, SameSite=Strict, 12시간), 로그인 5회 실패 시 5분 잠금(IP 기준)
- `super`: 전체 + 관리 메뉴 / `admin`: 배정된 부서의 캠페인만
- 외부 노출 시 반드시 HTTPS 뒤에 둔다. `x-forwarded-proto: https` 또는 `COOKIE_SECURE=1`이면 쿠키에 Secure 적용.
- CSRF: POST의 `Origin` 호스트가 `Host`와 다르면 403. 주요 동작은 `audit` 테이블에 기록(개인정보 미포함, ID만).

## Cloudflare 이전 시 (로드맵)
- 로직(`core.js`, `parser.js`, `gateway.js`)은 Node 전용 API가 `node:sqlite`, `node:crypto` 정도이므로
  Workers + D1 로 옮길 때 DB 접근부(`db.js`, prepare/run 호출)만 비동기 어댑터로 교체하면 된다.
- 큐/예약은 Cron Trigger + Queues, 세션은 D1 또는 KV.
- 이때 폰은 PC 로컬 IP가 아니라 SMS Gateway **클라우드/프라이빗 서버 모드**로 전환해야 한다(Workers에서 사설 IP 접근 불가).
