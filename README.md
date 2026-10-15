# interview-sms — 면접 참석 확인 문자 시스템

지원자에게 면접 안내 문자를 보내고, **답장("참석"/"불참" 등)을 자동 해석**해 사업장별로 집계하는 웹 시스템.
**Cloudflare Workers + D1**에서 동작하고, 문자는 부서별 안드로이드 폰의
[android-sms-gateway](https://github.com/capcom6/android-sms-gateway)(클라우드 서버 모드)로 송수신한다.

- 운영 주소: https://interview-sms.bigbears.workers.dev

```
관리자 브라우저 ─▶ Cloudflare Worker ─▶ D1(DB)
                        │  ▲ Cron(매 분) 발송 큐
        발송 API        ▼  │ 웹훅(sms:received)
              api.sms-gate.app ◀──▶ 부서 폰(SMS Gateway 앱) ──SMS──▶ 지원자
```

- 부서 1개 = 폰 1대 = 게이트웨이 1개. 관리자는 여러 명이며 담당 부서별로 권한이 나뉜다.
- 사업장은 명단 CSV의 `사업장` 컬럼으로 자동 분리된다. (수천 개 가능)
- 예약 발송, 미응답자 리마인드, 수동 확정, CSV 내보내기, 보관기간 경과 시 개인정보 자동 파기, 감사 로그.

## 개발/배포

필요: Node.js 22.5+, Cloudflare 계정 로그인(`npx wrangler login`)

```bash
npm install
npm test                  # 단위 테스트 (D1 은 node:sqlite 어댑터로 대체)
npm run dev               # 로컬 Worker + 로컬 D1 (먼저 npm run db:migrate:local)
npm run db:migrate        # 원격 D1 에 마이그레이션 적용
npm run deploy            # 배포
```

시크릿(최초 1회): `wrangler secret put ENCRYPTION_KEY`, `wrangler secret put ADMIN_PASSWORD`
(최초 로그인 시 `ADMIN_USER`/`ADMIN_PASSWORD`로 관리자 계정이 만들어진다. 이후 웹에서 비밀번호 변경.)

## 문서

| 문서 | 내용 |
|---|---|
| [AGENTS.md](AGENTS.md) | AI/개발자 작업 규칙 (먼저 읽을 것) |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 구조, 데이터 모델, 처리 흐름, 한도 |
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | 폰 연결, 최초 설정, 운영, 장애 대응 |
| [docs/PARSING_RULES.md](docs/PARSING_RULES.md) | 답장 해석 규칙과 한계 |
| [docs/DECISIONS.md](docs/DECISIONS.md) | 설계 결정 기록과 로드맵 |

## 명단 CSV 형식

| 사업장 | 이름 | 전화번호 | 면접일시 |
|---|---|---|---|
| 강남점 | 홍길동 | 010-1234-5678 | 10/20 14:00 |

컬럼명 별칭(지점, 성명, 휴대폰, 연락처 등)도 인식한다. UTF-8과 엑셀 CP949 CSV 모두 지원.
