# HANDOFF — 이어서 작업하기

다른 에이전트/개발자가 바로 이어받을 수 있도록 **현재 운영 상태와 진행 중인 작업**을 기록한다. 작업을 멈출 때(미완료 포함) 이 파일을 갱신하고 main 에 push 한다.

## 운영 상태 확인 (2026-10-17 점검)
- 운영 Worker `interview-sms` 의 실제 코드 = `main` `32ba903` 빌드와 **완전히 동일**(라이브 스크립트 내려받아 `wrangler deploy --dry-run` 결과와 diff 0줄). 마지막 배포 2026-10-16 17:12 KST.
- D1 `interview-sms`: 마이그레이션 0001~0022 모두 적용, 레포 밖 마이그레이션 없음.
- 설정(vars/시크릿/route `interview.bigbears.me/*`/Cron `* * * * *`) = `wrangler.jsonc` 와 일치. 시크릿: ADMIN_PASSWORD, ENCRYPTION_KEY, GATEWAY_PRIVATE_TOKEN, RESEND_API_KEY.
- `/healthz` → `{"ok":true,"db":true,"runtime":"workers"}`, `error_log` 비어 있음, `npm test` 151/151 통과.
- 확인하지 못한 것: 담당자 PC 의 크롬 확장 설치 버전(현재 레포 v1.6.0), 실제 폰·알바몬 화면 종단 시험.

## 채용 워크플로우 — 운영 배포·실제 시험 완료 (2026-10-17)
- 배포: main → `npm run deploy` (마이그레이션 0023). 이후 수정 2건도 배포: 되돌아온 문자(echo) 무시, 일정 변경 요청은 불참 대신 확인 필요.
- **운영 전체 시험(사용자 승인, 관리자 계정 2시간 시험 로그인 → 시험 후 삭제)**, 실제 문자는 관리자 번호로만:
  - 화면 19개 열림·스크립트 오류 없음 / 문자 시스템 연결 저장(연결·자동 등록·이력·노쇼 제안 3회·참고 표시 모두 켬)
  - 지원자 선택 → 면접 안내 만들기(명단 채움) → 일정 고르기(id=6) → 실제 발송·폰 발송 확인 → 되돌아온 문자 무시 → "2번이요" → 일정 확정 + 확정 문자 실제 발송
  - 일정 변경 요청 → 새 일정으로 다시 안내(실제 발송) → "참석" → 합격 기록 → 결과 문자 실제 발송(두 번째는 0명) → 진행 단계 "합격", 상세 면접 안내 이력
  - Cron 에서 리마인드·한 번 더 작업 실행 기록 확인, 오류 0건
  - 답장은 폰 웹훅 형식(`POST /hook/2/<token>`, sms:received)으로 넣음.
- 정리: 시험 로그인 삭제, 시험 지원 건(applicant_applications id=26) 삭제, 시험 안내 id=6 자동 문자 끔. 남은 시험 안내: id=3(0명), 4·5(사용자 시험, 자동 문자 켜짐 → 10/20 17시·10/21 8시, 10/30 17시·10/31 8시 관리자 폰으로 리마인드), 6.
- 미확인: 전날·당일 리마인드와 "한 번 더"의 **실제 시각 발송**(단위 시험만, 10/20 17시 안내 5 리마인드로 첫 확인 예정).
- 발견: 게이트웨이 2는 웹훅 서명 키가 없어 URL 토큰만으로 수신을 인증한다(토큰 유출 시 가짜 답장 가능). SMSGate 앱의 Signing Key 설정 권장.

## 작업 방법 메모
- 배포는 `npm run deploy`(테스트→마이그레이션→배포→/healthz). 이 환경(Termux PRoot)에서도 wrangler 로그인·배포·D1 원격 조회가 된다.
- 라이브 코드 비교: `GET /accounts/{id}/workers/scripts/interview-sms/content/v2` 결과의 worker.js ↔ `npx wrangler deploy --dry-run --outdir <dir>`.
