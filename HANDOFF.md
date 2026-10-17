# HANDOFF — 이어서 작업하기

다른 에이전트/개발자가 바로 이어받을 수 있도록 **현재 운영 상태와 진행 중인 작업**을 기록한다. 작업을 멈출 때(미완료 포함) 이 파일을 갱신하고 main 에 push 한다.

## 운영 상태 확인 (2026-10-17 점검)
- 운영 Worker `interview-sms` 의 실제 코드 = `main` `32ba903` 빌드와 **완전히 동일**(라이브 스크립트 내려받아 `wrangler deploy --dry-run` 결과와 diff 0줄). 마지막 배포 2026-10-16 17:12 KST.
- D1 `interview-sms`: 마이그레이션 0001~0022 모두 적용, 레포 밖 마이그레이션 없음.
- 설정(vars/시크릿/route `interview.bigbears.me/*`/Cron `* * * * *`) = `wrangler.jsonc` 와 일치. 시크릿: ADMIN_PASSWORD, ENCRYPTION_KEY, GATEWAY_PRIVATE_TOKEN, RESEND_API_KEY.
- `/healthz` → `{"ok":true,"db":true,"runtime":"workers"}`, `error_log` 비어 있음, `npm test` 151/151 통과.
- 확인하지 못한 것: 담당자 PC 의 크롬 확장 설치 버전(현재 레포 v1.6.0), 실제 폰·알바몬 화면 종단 시험.

## 진행 중인 작업 — 채용 워크플로우 (2026-10-17)
- **운영 배포 완료**: main `1531fe5`(workflow-v1 병합) → `npm run deploy`, 버전 `a06155d6`, 마이그레이션 0023 적용, /healthz 정상, 운영 코드 = 레포 빌드(빈 줄 차이만). 배포 전 백업 `backups/interview-sms-202610171756.sql`(로컬).
- 기능: 지원자 선택 → 면접 안내 만들기, 일정 고르기(번호 답장 → 확정 문자), 일정 변경 요청 표시·다시 안내, 전날 17시 리마인드, 답 없으면 한 번 더, 결과 안내 문자, 지원자 진행 단계. 자세한 내용은 `docs/DECISIONS.md` "채용 워크플로우 연결".
- **남은 일: 실제 문자 시험(사용자 번호로만)**. DB에 직접 시험 데이터를 넣는 것은 권한 검사에서 막혀서, 사용자가 화면에서 직접 시험하기로 함. 순서: 지원자 1명(본인 번호) 등록 → 체크 → 면접 안내 만들기 → "면접 일정을 골라 달라고 해요" → 보내기 → 번호 답장 → 확정 문자 확인 → 결과 기록·결과 문자.
- 주의: 본인 번호 = 문자 보내는 폰(게이트웨이 2) 자기 번호. 보낸 문자가 스스로 답장으로 들어와 "확인 필요"로 잡힐 수 있음.
- 정리할 것: 시험 중 만들다 멈춘 빈 면접 안내 **id=3 "[시험] 일정 고르기 (관리자 번호)"**(대상자 0명, 문자 안 나감). 화면에서 지우거나 그대로 둬도 무해.
- "문자 시스템 연결"(link_enabled)은 운영 DB에 아직 저장되지 않음(10/17 18시 확인). 폰은 10/17 17:45 기준 정상.

## 작업 방법 메모
- 배포는 `npm run deploy`(테스트→마이그레이션→배포→/healthz). 이 환경(Termux PRoot)에서도 wrangler 로그인·배포·D1 원격 조회가 된다.
- 라이브 코드 비교: `GET /accounts/{id}/workers/scripts/interview-sms/content/v2` 결과의 worker.js ↔ `npx wrangler deploy --dry-run --outdir <dir>`.
