# 설계 결정 기록 / 로드맵

## 결정
| # | 결정 | 이유 |
|---|---|---|
| 1 | 호스팅은 **PC 직접 운영** → 추후 회사 서버. 외부 접속은 Cloudflare Tunnel | 요구사항: 사내 정보 유출 대비, 직접 통제. (Workers 배포도 가능하나 보류) |
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
