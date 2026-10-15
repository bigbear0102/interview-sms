# AGENTS.md — AI/개발자 작업 가이드

이 파일을 먼저 읽고 작업을 시작한다. (`CLAUDE.md`도 동일 내용을 가리킨다)

## 프로젝트 요약
면접 참석 확인 문자 시스템. Node.js(내장 `node:sqlite`, **외부 의존성 없음**) + 서버 렌더링 HTML.
부서별 안드로이드 폰(android-sms-gateway, **로컬 서버 모드**)으로 발송하고 웹훅으로 답장을 받는다.

## 명령어
```bash
npm test     # 반드시 통과 후 커밋
npm start    # 개발 서버 (.env 자동 로드)
```

## 코드 지도
| 파일 | 역할 |
|---|---|
| `src/parser.js` | 답장 해석(`parseReply`), 전화번호 정규화 |
| `src/core.js` | 캠페인 생성, 발송 큐, 답장 매칭, 파기, 통계 (**비즈니스 로직은 여기**) |
| `src/gateway.js` | 폰 앱 API 호출, 웹훅 등록, HMAC 서명 검증 |
| `src/db.js` | SQLite 스키마 |
| `src/auth.js` | 비밀번호(scrypt), 세션, 권한 |
| `src/csv.js` | CSV 파서, 컬럼 별칭 |
| `src/server.js` | HTTP 라우팅, 화면 |
| `src/views.js` | HTML 레이아웃/CSS |

## 규칙
1. **답장 해석 규칙을 바꾸면** `test/parser.test.js`에 케이스를 추가하고 `docs/PARSING_RULES.md`를 갱신한다. 부정 표현이 항상 먼저 검사된다는 원칙을 유지한다.
2. **스키마를 바꾸면** `src/db.js`에 `CREATE TABLE IF NOT EXISTS` 변경만으로 끝내지 말고, 기존 DB용 `ALTER` 마이그레이션을 추가하고 `docs/ARCHITECTURE.md`를 갱신한다.
3. **개인정보**(이름, 전화번호, 문자 원문)는 로그/콘솔/에러 메시지에 출력하지 않는다. 보관기간 파기(`purgeExpired`)가 새 개인정보 컬럼도 지우는지 확인한다.
4. **비밀값**(`.env`, `data/`, 게이트웨이 비밀번호)은 커밋 금지. `.gitignore`를 확인한다.
5. 권한: 모든 캠페인/지원자 접근은 `canAccessDepartment`를 거친다. 새 화면을 만들 때 누락하지 않는다.
6. 의존성은 정말 필요할 때만 추가한다. 추가하면 `docs/DECISIONS.md`에 이유를 적는다.
7. 변경 후 `docs/DECISIONS.md`의 로드맵/결정 기록을 최신으로 유지한다.

## 알려진 사항
- 폰 → 서버 웹훅은 **HTTPS 필수**(127.0.0.1 제외). 로컬 PC 운영 시 Cloudflare Tunnel 등으로 HTTPS 주소를 만든다. 자세한 내용은 `docs/RUNBOOK.md`.
- 게이트웨이 앱의 정확한 API 경로/응답은 버전마다 다를 수 있다. `gateways.send_path`로 조정 가능하며 실제 폰으로 검증이 필요하다. (현재 코드는 실제 폰 연동 미검증)
