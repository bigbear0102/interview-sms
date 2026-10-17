# HANDOFF — 이어서 작업하기

다른 에이전트/개발자가 바로 이어받을 수 있도록 **현재 운영 상태와 진행 중인 작업**을 기록한다. 작업을 멈출 때(미완료 포함) 이 파일을 갱신하고 main 에 push 한다.

## 운영 상태 확인 (2026-10-17 점검)
- 운영 Worker `interview-sms` 의 실제 코드 = `main` `32ba903` 빌드와 **완전히 동일**(라이브 스크립트 내려받아 `wrangler deploy --dry-run` 결과와 diff 0줄). 마지막 배포 2026-10-16 17:12 KST.
- D1 `interview-sms`: 마이그레이션 0001~0022 모두 적용, 레포 밖 마이그레이션 없음.
- 설정(vars/시크릿/route `interview.bigbears.me/*`/Cron `* * * * *`) = `wrangler.jsonc` 와 일치. 시크릿: ADMIN_PASSWORD, ENCRYPTION_KEY, GATEWAY_PRIVATE_TOKEN, RESEND_API_KEY.
- `/healthz` → `{"ok":true,"db":true,"runtime":"workers"}`, `error_log` 비어 있음, `npm test` 151/151 통과.
- 확인하지 못한 것: 담당자 PC 의 크롬 확장 설치 버전(현재 레포 v1.6.0), 실제 폰·알바몬 화면 종단 시험.

## 진행 중인 작업 — 채용 워크플로우 (브랜치 `workflow-v1`, 2026-10-17)
- **완료(브랜치에 push됨, 운영 미배포)**: 지원자 선택 → 면접 안내 만들기(명단 채움), 일정 고르기(번호 답장 → 확정 문자), 일정 변경 요청 표시·다시 안내, 전날 17시 리마인드, 답 없으면 한 번 더, 결과 안내 문자, 지원자 진행 단계. 마이그레이션 `0023_workflow.sql`(새 자동 발송은 기존 안내에 기본 꺼짐). 테스트 164/164, UI는 CI `UI shots`(ui-shots 묶음)로 PC·모바일 확인. 문서: GUIDE·PARSING_RULES·OPERATIONS·DECISIONS 갱신.
- **멈춘 곳**: main 병합 + `npm run deploy` 가 Claude Code 권한 검사(운영 배포)에서 거절됨. 사용자 승인 필요.
- **남은 단계**: ① `workflow-v1` → main 병합 ② `npm run deploy`(0023 마이그레이션 포함) ③ /healthz·live diff 확인 ④ 사용자 번호(관리자 계정 번호, 문자 보내는 폰 자기 번호와 같음)로만 실제 시험: 지원자 1명 등록 → 면접 안내(일정 고르기) → 번호 답장 → 확정 문자 → 결과 문자.
- 배포 전 백업: `backups/interview-sms-202610171756.sql`(로컬, git 제외).
- 참고: 운영 DB에 "문자 시스템 연결"(link_enabled) 설정이 저장돼 있지 않았다(10/17 확인). 문자 보내는 폰(게이트웨이 2)은 10/15 16:08 이후 응답 없음 상태였다.

## 작업 방법 메모
- 배포는 `npm run deploy`(테스트→마이그레이션→배포→/healthz). 이 환경(Termux PRoot)에서도 wrangler 로그인·배포·D1 원격 조회가 된다.
- 라이브 코드 비교: `GET /accounts/{id}/workers/scripts/interview-sms/content/v2` 결과의 worker.js ↔ `npx wrangler deploy --dry-run --outdir <dir>`.
