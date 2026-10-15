# 설계 결정 기록 / 로드맵

## 결정
| # | 결정 | 이유 |
|---|---|---|
| 1 | 웹은 **Cloudflare Workers + D1**, 게이트웨이는 자체 서버(현재 PC) → 둘 다 추후 회사 서버로 | PC 상시 가동 불가(2026-10-15). 같은 코드가 Node/Workers 양쪽에서 돌아 이전이 쉽다. 사내 정보는 본인 Cloudflare 계정과 자체 서버에만 둔다 |
| 2 | 게이트웨이는 **자체 호스팅 Private 서버**(Docker) | 지원자 번호/문자가 제3자 공개 서버(`api.sms-gate.app`)를 거치지 않게 함 |
| 11 | 같은 코드를 Node/SQLite 와 Workers/D1 에서 실행 (D1 API 어댑터) | 이전 유연성. 회사 서버/클라우드 어디로든 이동 가능 |
| 3 | 답장 방식은 **자유 문구 해석**(링크 클릭 아님) | 요구사항: "참석/불참/미참 등 다양한 문구" |
| 4 | 서버 렌더링 HTML, 프레임워크/런타임 의존성 없음 | 단순함, 인수인계 용이 |
| 5 | 사업장은 CSV 의 `사업장` 컬럼으로 자동 분리 | 수천 개 사업장을 사전 등록 없이 처리 |
| 6 | 보관기간은 캠페인별 설정, 만료 시 개인정보만 파기하고 통계 유지 | 법적 기간은 법무 확인 후 기본값(90일) 조정 |
| 7 | 인증은 아이디/비밀번호(PBKDF2) + 부서 단위 권한 | 요구사항. scrypt 는 Workers 미지원 |
| 8 | 발송은 Cron(매 분)이 `SEND_BATCH`건씩 처리, 건을 선점(`sending`) 후 발송 | Workers 서브리퀘스트 한도, 중복 발송 방지 |
| 9 | 시각은 KST 고정 | 사용자 환경이 한국. Worker 는 UTC 라 명시 변환 |
| 10 | 게이트웨이 비밀번호 AES-GCM 암호화 저장 | DB 유출 시 폰 계정 보호 |

## 미검증/주의
- **실제 폰 종단 시험 전**: 게이트웨이 API 경로/응답, 웹훅 payload, 앱 QR 연결 방식은 문서 기준.
- 법정 보관기간 기본값은 법무 확인 필요.
- 무료 플랜 처리량 ≈ 25건/분. 대량(수천 건) 발송이 잦으면 유료 플랜 + `SEND_BATCH` 상향.
- 현재 Cloudflare 계정은 로그인된 wrangler 계정(`workers.dev` 서브도메인 `bigbears`)이다. 회사 도메인/계정으로 옮길 때는 `wrangler.jsonc`의 D1 id 와 시크릿을 새로 만든다.

## 로드맵
- [ ] 실제 폰 연동 시험 및 API 경로/payload 보정
- [ ] 커스텀 도메인 연결, Cloudflare Access 로 `/hook/*` 외 경로 접근 제한(선택)
- [ ] 감사 로그에 지원자 목록 조회 기록, 감사 로그 보관기간 정책
- [ ] 면접 일정 변경 요청 처리, 전달 확인(`sms:delivered`) 반영
- [ ] 대량 발송 시 Cloudflare Queues 도입 (유료 플랜)
- [x] 질문형 답장을 `unclear`로 분류, CSRF/감사 로그/Secure 쿠키

## 운영 메모
- 기존 Cloudflare Worker `interview-sms`(workers.dev)와 D1 은 PC 이전 전 시험 배포본이다. 현재 운영 대상이 아니며 필요 없으면 삭제한다(`npx wrangler delete`, D1 삭제).
- Cloudflare 계정에는 다른 터널(`real-estate-dashboard`, `my-homelab-tunnel`, `oracle`)이 있다. `interview-sms` 터널만 사용하며 DNS 연결 시 반드시 **터널 UUID** 로 지정한다(이름 지정 시 기본 config 의 다른 터널로 연결될 수 있음).

## 2026-10-15 웹을 Cloudflare Workers 로 이전
- 도메인(`interview.bigbears.me`)은 DNS 를 바꾸지 않고 Worker route 로 가로챔. 웹훅 주소/토큰이 그대로라 폰 쪽 변경 없음.
- 데이터는 `deploy/cloudflare/export-to-d1.mjs` 로 SQLite → D1 이전, 시크릿은 `put-secrets.mjs`.
- **남은 PC 의존**: 게이트웨이 서버(Docker). 상시 서버(예: Cloudflare 계정에 터널이 있는 Oracle/홈서버, 또는 회사 서버)로 옮기면 PC 는 완전히 불필요.
- Workers 무료 플랜 발송 처리량 ≈ 25건/분(시간당 1,500건). 대량 발송이 잦으면 유료 플랜 + `SEND_BATCH` 상향.
- 회사 서버 이전 시 D1 → SQLite: `deploy/cloudflare/import-d1-export.mjs` (검증 완료).

## 2026-10-15 게이트웨이를 공개 클라우드(api.sms-gate.app)로 전환 + 종단간 암호화
- 사용자 결정: PC/서버 없이 운영. 대신 번호/내용이 제3자 서버를 거치므로 **앱의 passphrase 종단간 암호화**를 필수로 안내한다.
- 암호화 대상: 문자 내용(`textMessage.text`)과 받는 번호(`phoneNumbers`). 형식 `$aes-256-cbc/pbkdf2-sha1$i=<반복>$<salt>$<암호문>` (테스트로 앱 규격 복호화 검증).
- 한계: 폰이 서버로 올리는 **받은 문자(답장) 내용의 암호화 여부는 문서에 명시되지 않음**. 웹훅은 폰 → 우리 Worker 로 직접 가므로 공개 서버를 거치지 않는다.
- 기기 키 기반 E2E(RSA-OAEP, MGF1=SHA-1)는 WebCrypto 가 OAEP 와 MGF1 해시를 분리 지정할 수 없어 Workers 에서 구현 불가 → passphrase 방식 사용.
- 비용/성능: 필드당 PBKDF2 비용이 있어 Workers 무료 플랜(CPU 10ms)에서는 반복 횟수를 낮춰야 한다. 대량 발송은 유료 플랜 권장.

## 2026-10-15 PC 게이트웨이 중지
- 폰이 공개 서버로 이전되어 PC 의 게이트웨이/터널/웹 작업을 모두 중지(비활성화). 중지 후 연결 확인·받기 시험 통과.
- 컨테이너와 DB 볼륨은 롤백용으로 보존. 정리하려면 RUNBOOK 의 "PC 게이트웨이 중지 상태와 되돌리기" 참고.
