# 운영 가이드

## 현재 운영 형태 (2026-10-15 기준)

| 구성요소 | 위치 | 주소 |
|---|---|---|
| **면접 웹** | **Cloudflare Workers + D1** (`interview-sms`) | https://interview.bigbears.me |
| **SMS 게이트웨이** | **공개 클라우드 `api.sms-gate.app`** (문자 내용/번호는 앱의 종단간 암호화로 보호) | `https://api.sms-gate.app/3rdparty/v1` |
| (이전 방식) 자체 게이트웨이 서버 (Docker) | 이 PC — **2026-10-15 중지함** (데이터 볼륨은 보존) | https://sms.bigbears.me (터널도 중지, DNS 레코드는 남아 있음) |
| 폰 (SMSGate 앱) | 부서 폰 | — |

- 공개 클라우드를 쓰면 **PC/서버가 필요 없다.** (웹=Cloudflare, 게이트웨이=공개 서버, 폰만 켜져 있으면 됨)
- 폰은 SMSGate 앱에서 서버 주소를 **기본값**으로 두고, Settings → Encryption 의 Passphrase 를 웹 설정의 "암호화 비밀번호"와 똑같이 맞춘다.
- 자체 서버(`deploy/gateway`)로 되돌릴 때는 `wrangler.jsonc` 의 `GATEWAY_URL` 을 `https://<도메인>/api/3rdparty/v1` 로 바꾸고 폰의 서버 주소/토큰을 설정한다.
- 웹 코드는 같은 코드가 Node(회사 서버)에서도 돈다. 이전 절차는 아래 "회사 서버로 이전".
- 암호화 반복 횟수 `E2E_ITERATIONS`(기본 10000)는 Workers **무료 플랜 CPU 한도(10ms)** 때문에 낮다. 유료 플랜이면 75000 이상으로 올린다. 무료 플랜에서 발송이 `CPU time limit` 로 실패하면 유료 플랜이 필요하다.
- Worker 설정: `wrangler.jsonc`. 시크릿: `ENCRYPTION_KEY`, `GATEWAY_PRIVATE_TOKEN` (`deploy/cloudflare/put-secrets.mjs`).
- 접속 경로: DNS(`interview`)는 기존 터널 CNAME 그대로 두고, Worker **경로(route) `interview.bigbears.me/*`** 가 요청을 가로챈다.
  응답 헤더 `X-Runtime: workers` 로 어느 쪽이 응답했는지 확인할 수 있다 (`node` 이면 PC 가 응답한 것).

### PC 게이트웨이 중지 상태와 되돌리기
- 중지한 것: Docker 컨테이너 3개(`docker compose stop`), 작업 `interview-sms-tunnel`/`interview-sms-web` 비활성화.
- **PC 는 꺼도 된다.** 웹/발송/수신은 Cloudflare + 공개 서버 + 폰만으로 동작한다 (중지 후 연결 확인/받기 시험 통과).
- 자체 서버 방식으로 되돌리려면: `cd deploy/gateway && docker compose --env-file .env start`, 작업 `interview-sms-tunnel` 사용 설정,
  `wrangler.jsonc` 의 `GATEWAY_URL` 을 `https://sms.bigbears.me/api/3rdparty/v1` 로 바꿔 배포, 폰 앱 서버 주소/토큰을 되돌리고 설정 화면에서 계정을 다시 연결한다.
- 더 이상 필요 없으면 `docker compose down -v`(데이터 삭제)와 Cloudflare DNS 의 `sms` 레코드, 터널 `interview-sms` 를 삭제한다.

### 배포/변경 (Worker)
```bash
npm test
npm run db:migrate     # 스키마 변경이 있을 때 (원격 D1)
npm run deploy         # Worker 배포
npx wrangler tail      # 실시간 로그
```
- 비밀값 교체: `node --env-file=.env deploy/cloudflare/put-secrets.mjs` (값은 출력되지 않음)
- **`ENCRYPTION_KEY`를 바꾸면** 저장된 게이트웨이 비밀번호를 복호화할 수 없다 → 설정 화면에서 폰 계정을 다시 입력한다.
- 백업: `npx wrangler d1 export interview-sms --remote --output backup.sql` (개인정보 포함, 보관 후 삭제 정책 준수)

### 회사 서버로 이전 (Worker/D1 → Node/SQLite)
1. 회사 서버에 Node 22.5+ 설치, 레포 clone, `node deploy/setup.mjs <웹도메인> <게이트웨이도메인>` 로 `.env` 생성
   (**`ENCRYPTION_KEY`는 기존 값으로 바꿔 넣을 것** — 게이트웨이 비밀번호 복호화에 필요. 현재 값은 PC 의 `.env`)
2. D1 내보내기 → 가져오기
   ```bash
   npx wrangler d1 export interview-sms --remote --output backup.sql
   node deploy/cloudflare/import-d1-export.mjs backup.sql data/app.db
   ```
3. `npm start` (또는 `deploy/windows`/systemd 로 상시 실행), 게이트웨이는 `deploy/gateway` docker compose
4. DNS 를 새 서버(터널)로 돌리고 Worker route 를 제거한다 (`wrangler.jsonc` 의 routes 삭제 후 `npm run deploy`, 또는 Worker 삭제).
5. 설정 화면에서 **답장 받기 다시 설정**(웹훅 재등록), **받기 시험**으로 확인한다.

---

# (참고) PC 에서 웹을 직접 돌리는 방식
아래 내용은 Node 로 웹을 직접 운영할 때의 절차이다. 현재는 웹을 Worker 로 옮겼으므로 PC 웹 작업(`interview-sms-web`)은 **비활성화** 상태다.

## 1. 최초 설치 (새 PC/서버에서)
```bash
npm install                                  # (wrangler 는 Cloudflare Workers 배포 시에만 필요)
node deploy/setup.mjs <웹도메인> <게이트웨이도메인>   # .env 와 deploy/gateway/.env 생성
cd deploy/gateway && docker compose --env-file .env up -d     # 게이트웨이 서버
cloudflared tunnel create interview-sms      # 터널 생성 후 deploy/tunnel/config.template.yml 참고해
cloudflared tunnel route dns --overwrite-dns <터널UUID> <도메인>   # 도메인 연결(UUID 로 지정할 것)
powershell -ExecutionPolicy Bypass -File deploy\windows\install-tasks.ps1   # 로그온 시 자동 시작
```
수동 실행: `npm start` (웹), `cloudflared tunnel --config <설정> run` (터널).
**코드를 바꾼 뒤에는 `powershell -ExecutionPolicy Bypass -File deploywindowsestart.ps1`** 로 재시작한다.
(`Stop-ScheduledTask`만 쓰면 자식 node 프로세스가 남아 옛 코드가 계속 서비스될 수 있다. 재시작 후 `curl https://interview.bigbears.me/login` 에 새 CSS 가 보이는지 확인한다.)
로그: `data/web.log`, `data/tunnel.log`, `docker compose logs`.

## 2. 폰 연결 (부서마다 1대)
1. 폰에 [SMS Gateway for Android](https://github.com/capcom6/android-sms-gateway) 설치 (패키지 `me.capcom.smsgateway`), SMS 권한 허용
2. 앱 **Settings → Cloud Server**
   - **API URL**: `https://sms.bigbears.me/api/mobile/v1` (끝의 `/api/mobile/v1` 필수)
   - **Private Token**: `.env` 의 `GATEWAY_PRIVATE_TOKEN` 값
3. **Home** 탭 → **Cloud server** 스위치 켜기 → **Offline** 버튼을 눌러 **Online** 이 될 때까지 대기
4. 첫 연결 시 자동 생성된 **Username/Password** 가 앱의 Cloud Server 화면에 표시된다
5. 배터리 최적화에서 앱 제외, 백그라운드 실행 허용
6. (QR 스캔 화면이 나오면 위 URL/토큰을 입력하는 다른 방법일 수 있다. 수동 입력이 가능하면 수동으로 한다)

## 3. 웹에서 설정 (전체 관리자)
(자세한 화면 안내는 [GUIDE.md](GUIDE.md). 웹의 **설정** 화면이 같은 순서로 안내한다.)
1. https://interview.bigbears.me 로그인 (`admin` / `.env` 의 `ADMIN_PASSWORD`) → **`/password`에서 변경**
2. 관리 → 부서 추가
3. 관리 → 게이트웨이 추가: 앱에 표시된 Username/Password 입력 (API 주소는 기본값 유지)
4. **웹훅 등록** 클릭 → 폰이 문자를 받으면 웹으로 알려준다
5. 관리자 계정 추가 (담당 부서 ID 지정)

## 4. 시험
1. 본인 번호 1건 CSV 로 캠페인 생성 → 즉시 발송
2. 문자 수신 후 "참석"/"불참" 답장 → 캠페인 상세 확인
3. 안 바뀌면: 웹훅 등록 여부, 서명 키(401), `inbound` 테이블, 폰 앱 Online 여부

## 5. 백업/복구
```bash
# 중지 후 복사 (개인정보 포함 — 안전한 곳에 보관, 보관기간 정책 준수)
data/app.db  data/app.db-wal  data/app.db-shm  .env
# 게이트웨이 DB 는 임시 큐라서 중요하지 않다 (문자 원문 3일 후 자동 삭제)
```

## 6. 장애 대응
| 증상 | 확인 |
|---|---|
| 웹 접속 안 됨 | PC 켜짐, `interview-sms-web`/`-tunnel` 작업 상태, `data/*.log`, 터널 `cloudflared tunnel info interview-sms` |
| 발송이 시작되지 않음 | 캠페인 상태/예약 시각(KST), 웹 로그 |
| 발송 실패(`failed`) | 폰 Online, 게이트웨이 계정, Docker 컨테이너 상태(`docker compose ps`) → "리마인드 발송"으로 재시도 |
| 답장 반영 안 됨 | 웹훅 등록/서명 키, `inbound` 테이블 |
| PC 재부팅 후 | Docker Desktop 이 자동 시작되어야 게이트웨이가 올라온다(설정에서 로그인 시 시작 켜기) |

## 7. 회사 서버로 이전
1. 새 서버에 Node 22.5+, Docker, cloudflared 설치 후 레포 clone
2. 기존 PC 의 `.env`, `data/app.db*` 를 복사 (도메인이 같으면 `deploy/setup.mjs` 는 실행하지 않는다)
3. `deploy/gateway` 컨테이너 실행. 게이트웨이 DB(`mariadb-data`)는 새로 시작해도 되지만, **폰 앱 등록이 풀리므로** 폰에서 다시 Online 해야 한다. (주소가 같으면 앱 설정 변경은 필요 없음)
4. 터널 자격 증명(`~/.cloudflared/<UUID>.json`)을 새 서버로 옮기고 같은 터널을 실행한다. 이전 PC 의 터널은 먼저 중지한다.
5. 이전 PC 의 작업(`interview-sms-*`)을 제거하고 데이터를 파기한다.

## 8. (참고) Cloudflare Workers 배포
같은 코드가 Workers+D1 에서도 동작한다(`wrangler.jsonc`, `npm run deploy`). 현재는 PC 운영이므로 사용하지 않는다.
