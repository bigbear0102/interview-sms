# AGENTS.md — AI/개발자 작업 가이드

이 파일을 먼저 읽고 작업을 시작한다. (`CLAUDE.md`도 이 파일을 가리킨다)

## 프로젝트 요약
면접 참석 확인 문자 시스템. 서버 렌더링 HTML, 외부 런타임 의존성 없음. **같은 코드가 두 런타임에서 동작**한다:
- **Cloudflare Workers + D1**(**현재 운영**): `src/worker.js`, `wrangler.jsonc`, 배포 `npm run deploy`
- **Node + SQLite**(회사 서버 이전용, 검증 완료): `src/node/server.js`, D1 API 어댑터 `src/node/d1-sqlite.js`
부서별 안드로이드 폰(android-sms-gateway)은 **자체 호스팅 Private 서버**(`deploy/gateway`, Docker)에 연결되고,
폰이 웹훅(`/hook/:gatewayId/:token`)으로 답장을 보낸다. 외부 접속은 Cloudflare Tunnel.

## 명령어
```bash
npm test                 # 반드시 통과 후 커밋
npm run db:migrate       # 원격 D1 마이그레이션 (스키마 변경 시)
npm run deploy           # 운영 배포 (Cloudflare Worker)
npm start                # Node 서버 (회사 서버 이전용, .env 필요)
# 게이트웨이(PC) 재시작: powershell -File deploywindowsestart.ps1  (웹 작업은 비활성화됨)
```

## 코드 지도
| 파일 | 역할 |
|---|---|
| `src/worker.js` | 요청 핸들러(화면/웹훅) + `runScheduled`(주기 작업). Workers/Node 공용 |
| `src/node/` | Node 진입점(`server.js`)과 SQLite→D1 어댑터 |
| `deploy/` | `setup.mjs`(비밀값 생성), `gateway/`(docker compose), `tunnel/`, `windows/`(자동 시작) |
| `src/core.js` | 캠페인 생성, 발송 큐, 답장 매칭, 파기, 통계 (**비즈니스 로직**) |
| `src/parser.js` | 답장 해석(`parseReply`), 전화번호 정규화 |
| `src/gateway.js` | 게이트웨이 API 호출, 웹훅 등록, HMAC 서명 검증 |
| `src/auth.js` / `src/crypto.js` | 세션/권한, PBKDF2·AES-GCM·HMAC (WebCrypto) |
| `src/csv.js` / `src/views.js` / `src/d1.js` | CSV, HTML·KST 시각, D1 헬퍼 |
| `src/admin.js` | 설정 화면(폰 연결 마법사, 부서, 관리자). 초보자용 문구는 `docs/GUIDE.md` 와 맞춘다 |
| `/messages` (worker.js) | 문자함: 임의 번호 직접 발송(`sendDirect`) + 송수신 내역(`messages`, `inbound`) |
| `migrations/*.sql` | D1 스키마 (번호 순서 적용) |
| `test/` | 단위 테스트. `src/node/d1-sqlite.js`(node:sqlite 기반 D1 어댑터)를 사용 |

## 규칙
1. **답장 해석 규칙을 바꾸면** `test/parser.test.js`에 케이스를 추가하고 `docs/PARSING_RULES.md`를 갱신한다. 부정 표현이 항상 먼저 검사된다는 원칙을 유지한다.
2. **스키마 변경은 새 마이그레이션 파일**(`migrations/0002_*.sql`)로 한다. 기존 파일은 수정하지 않는다. 적용: `npm run db:migrate`.
3. **개인정보**(이름, 전화번호, 문자 원문)는 로그/에러/감사 로그에 쓰지 않는다. 새 개인정보 컬럼을 추가하면 `purgeExpired`에 파기 처리를 넣는다.
4. **비밀값**(`.env`, `deploy/gateway/.env`, `ENCRYPTION_KEY`, 게이트웨이 비밀번호)은 코드/레포에 넣지 않는다. `.env`는 git 제외.
5. 권한: 캠페인/지원자 접근은 `canAccessDepartment`를 거친다. 새 화면에서 누락하지 않는다.
6. **두 런타임 호환**: `src/worker.js`/`core.js`는 Node 전용 API(`node:*`)를 쓰지 않는다(WebCrypto, fetch만). Workers 한도(호출당 서브리퀘스트)를 고려해 발송은 `SEND_BATCH`건씩 나누고, 건별 D1 호출 대신 `db.batch`를 쓴다.
7. 시각은 **KST 고정**(`views.js` `fmtTime`/`parseKstLocal`). Worker 는 UTC 이므로 직접 `new Date(문자열)` 하지 않는다.
8. **사용자 화면 문구는 초보자 기준**으로 쓴다(전문용어 대신 쉬운 말, 오류는 "무엇을 하면 되는지"까지). 화면을 바꾸면 `docs/GUIDE.md`도 함께 고친다.
9. **화면 디자인은 `DESIGN.md`(Apple 스타일)를 기준**으로 한다: 포인트 색은 파랑 하나, 흰색/연회색 면, 그림자 없음, 알약 버튼. 단 초보자용이라 글자 크기와 버튼은 일부러 크게 유지한다. 색은 `src/views.js` 의 CSS 변수로만 정의한다.
10. 변경 후 `docs/DECISIONS.md`의 결정/로드맵을 최신으로 유지한다.

## 알려진 사항
- 게이트웨이 API 경로(`/messages`, `/webhooks`)와 웹훅 payload 는 공식 문서 기준이며 **실제 폰으로 종단 시험 전**이다.
- `PBKDF2`는 Workers 상한인 100,000회를 쓴다. 로그인 지연/CPU 한도 문제가 생기면 `src/crypto.js`를 본다.
