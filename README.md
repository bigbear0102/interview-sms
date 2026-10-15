# interview-sms — 면접 참석 확인 문자 시스템

지원자에게 면접 안내 문자를 보내고, **답장("참석"/"불참" 등)을 자동 해석**해 사업장별로 집계하는 웹 시스템.
**직접 운영**(현재는 PC, 추후 회사 서버)하며, 문자는 부서별 안드로이드 폰의
[android-sms-gateway](https://github.com/capcom6/android-sms-gateway)를 **자체 호스팅한 Private 서버**로 송수신한다.
외부 접속은 Cloudflare Tunnel 을 쓰고, 지원자 정보는 외부 공개 SMS 서버를 거치지 않는다.

- 웹: https://interview.bigbears.me  /  게이트웨이: https://sms.bigbears.me

```
관리자 브라우저 ─▶ Cloudflare Tunnel ─▶ 면접 웹(Node + SQLite) ──발송 API──▶ 게이트웨이 서버(Docker)
                                                  ▲ 웹훅(sms:received)              │ 푸시/SSE
                                                  └──────────── 부서 폰(SMS Gateway 앱) ◀──┘ ──SMS──▶ 지원자
```

같은 코드는 Cloudflare Workers + D1 에서도 동작한다(`src/worker.js`, `wrangler.jsonc`).

- 부서 1개 = 폰 1대 = 게이트웨이 1개. 관리자는 여러 명이며 담당 부서별로 권한이 나뉜다.
- 사업장은 명단 CSV의 `사업장` 컬럼으로 자동 분리된다. (수천 개 가능)
- 문자함: 원하는 번호로 직접 발송하고 받은 문자(답장)를 확인, 바로 답장.
- 예약 발송, 미응답자 리마인드, 수동 확정, CSV 내보내기, 보관기간 경과 시 개인정보 자동 파기, 감사 로그.

## 실행

필요: Node.js 22.5+, Docker, cloudflared. 설치/이전 절차는 [docs/RUNBOOK.md](docs/RUNBOOK.md).

```bash
node deploy/setup.mjs <웹도메인> <게이트웨이도메인>   # .env 생성 (최초 1회)
cd deploy/gateway && docker compose --env-file .env up -d   # SMS 게이트웨이 서버
npm start                 # 면접 웹 (127.0.0.1:8787)
npm test                  # 단위 테스트
```

## 문서

| 문서 | 내용 |
|---|---|
| [AGENTS.md](AGENTS.md) | AI/개발자 작업 규칙 (먼저 읽을 것) |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 구조, 데이터 모델, 처리 흐름, 한도 |
| [docs/GUIDE.md](docs/GUIDE.md) | **처음 쓰는 분을 위한 사용 안내** (폰 연결, 발송, 결과 확인) |
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | 설치, 운영, 장애 대응 (관리자/개발자용) |
| [docs/PARSING_RULES.md](docs/PARSING_RULES.md) | 답장 해석 규칙과 한계 |
| [docs/DECISIONS.md](docs/DECISIONS.md) | 설계 결정 기록과 로드맵 |

## 명단 CSV 형식

| 사업장 | 이름 | 전화번호 | 면접일시 |
|---|---|---|---|
| 강남점 | 홍길동 | 010-1234-5678 | 10/20 14:00 |

컬럼명 별칭(지점, 성명, 휴대폰, 연락처 등)도 인식한다. UTF-8과 엑셀 CP949 CSV 모두 지원.
