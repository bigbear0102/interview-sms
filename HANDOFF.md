# HANDOFF — 이어서 작업하기

다른 에이전트/개발자가 바로 이어받을 수 있도록 **현재 운영 상태와 진행 중인 작업**을 기록한다. 작업을 멈출 때(미완료 포함) 이 파일을 갱신하고 main 에 push 한다.

## 운영 상태 확인 (2026-10-17 점검)
- 운영 Worker `interview-sms` 의 실제 코드 = `main` `32ba903` 빌드와 **완전히 동일**(라이브 스크립트 내려받아 `wrangler deploy --dry-run` 결과와 diff 0줄). 마지막 배포 2026-10-16 17:12 KST.
- D1 `interview-sms`: 마이그레이션 0001~0022 모두 적용, 레포 밖 마이그레이션 없음.
- 설정(vars/시크릿/route `interview.bigbears.me/*`/Cron `* * * * *`) = `wrangler.jsonc` 와 일치. 시크릿: ADMIN_PASSWORD, ENCRYPTION_KEY, GATEWAY_PRIVATE_TOKEN, RESEND_API_KEY.
- `/healthz` → `{"ok":true,"db":true,"runtime":"workers"}`, `error_log` 비어 있음, `npm test` 151/151 통과.
- 확인하지 못한 것: 담당자 PC 의 크롬 확장 설치 버전(현재 레포 v1.6.0), 실제 폰·알바몬 화면 종단 시험.

## 진행 중인 작업
- 없음. 다음 후보는 `docs/DECISIONS.md` 로드맵 참고(실제 폰 종단 시험, 감사 로그 정책, 일정 변경 요청, 인력풀 등).

## 작업 방법 메모
- 배포는 `npm run deploy`(테스트→마이그레이션→배포→/healthz). 이 환경(Termux PRoot)에서도 wrangler 로그인·배포·D1 원격 조회가 된다.
- 라이브 코드 비교: `GET /accounts/{id}/workers/scripts/interview-sms/content/v2` 결과의 worker.js ↔ `npx wrangler deploy --dry-run --outdir <dir>`.
