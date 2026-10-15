# 운영 가이드

현재 운영 형태: **이 PC(Windows)에서 직접 운영**, 외부 접속은 Cloudflare Tunnel.
나중에 회사 서버로 옮기는 방법은 마지막 절 참고.

| 구성요소 | 위치 | 공개 주소 |
|---|---|---|
| 면접 관리 웹 (Node, SQLite `data/app.db`) | PC `127.0.0.1:8787` | https://interview.bigbears.me |
| SMS 게이트웨이 서버 (Docker: backend/worker/MariaDB) | PC `127.0.0.1:3000` | https://sms.bigbears.me |
| Cloudflare Tunnel `interview-sms` | PC (`cloudflared`) | — |

비밀값은 모두 레포 루트의 `.env`(git 제외)에 있다. **`.env`와 `data/`는 반드시 백업**한다. (`ENCRYPTION_KEY`를 잃으면 저장된 게이트웨이 비밀번호를 복구할 수 없다)

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
