# interview-sms — 면접 참석 확인 문자 시스템

지원자에게 면접 안내 문자를 보내고, **답장("참석"/"불참" 등)을 자동 해석**해 사업장별로 집계하는 웹 시스템.
문자는 부서별 안드로이드 폰에 설치한 [android-sms-gateway](https://github.com/capcom6/android-sms-gateway)로 송수신한다.

## 한눈에 보기

```
관리자 웹(이 앱) ──발송 API──▶ 부서 폰(SMS Gateway 앱) ──SMS──▶ 지원자
      ▲                                                            │
      └──── 웹훅(sms:received) ◀── 부서 폰 ◀────── 답장 SMS ◀──────┘
```

- 부서 1개 = 폰 1대 = 게이트웨이 1개. 관리자는 여러 명이고 담당 부서별로 권한이 나뉜다.
- 사업장은 명단 CSV의 `사업장` 컬럼으로 자동 분리된다. (수천 개 사업장 가능)
- 발송 예약, 미응답자 리마인드, 수동 확정, CSV 내보내기, 보관기간 경과 시 개인정보 자동 파기.

## 빠른 시작 (Windows/Linux/Mac)

필요: **Node.js 22.5 이상** (외부 npm 패키지 없음, 내장 SQLite 사용)

```bash
cp .env.example .env     # 값 수정
npm test                 # 테스트
npm start                # http://localhost:3000
```

최초 실행 시 콘솔에 초기 관리자 계정이 출력된다(`ADMIN_PASSWORD` 미지정 시 랜덤). 로그인 후 `/password`에서 변경.

그다음 웹의 **관리** 메뉴에서: 부서 추가 → 게이트웨이(폰) 추가 → 웹훅 등록 → 관리자 계정 추가.
폰 설정과 웹훅 HTTPS 요건은 [docs/RUNBOOK.md](docs/RUNBOOK.md) 참고.

## 문서

| 문서 | 내용 |
|---|---|
| [AGENTS.md](AGENTS.md) | AI/개발자 작업 규칙 (먼저 읽을 것) |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 구조, 데이터 모델, 처리 흐름 |
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | 폰 설정, 운영, 장애 대응, 클라우드 이전 |
| [docs/PARSING_RULES.md](docs/PARSING_RULES.md) | 답장 해석 규칙과 한계 |
| [docs/DECISIONS.md](docs/DECISIONS.md) | 설계 결정 기록과 로드맵 |

## 명단 CSV 형식

| 사업장 | 이름 | 전화번호 | 면접일시 |
|---|---|---|---|
| 강남점 | 홍길동 | 010-1234-5678 | 10/20 14:00 |

컬럼명 별칭(지점, 성명, 휴대폰, 연락처 등)도 인식한다. UTF-8과 엑셀 CP949 CSV 모두 지원.
