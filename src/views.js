export const STATUS_LABEL = {
  pending: '보내는 중', sending: '보내는 중', sent: '답 없음', attending: '참석', absent: '불참', unclear: '확인 필요', failed: '못 보냄'
};

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 모든 시각은 한국시간(KST, UTC+9)으로 표시/입력한다
const KST = 9 * 3600 * 1000;
export function fmtTime(ms) {
  if (!ms) return '';
  const d = new Date(ms + KST);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

// <input type="datetime-local"> 값(예: 2026-10-20T14:00)을 KST 로 해석
export function parseKstLocal(s) {
  const t = String(s).trim();
  return new Date(`${t}${t.length === 16 ? ':00' : ''}+09:00`).getTime();
}

// 디자인: DESIGN.md (Apple 스타일) 기준. 단일 포인트 색(Action Blue), 흰색/연회색 캔버스,
// 그림자 없는 면 구분, 알약(pill) 버튼, 넉넉한 여백. 초보자용이라 글자는 일부러 크게 쓴다.
const CSS = `
:root{color-scheme:light dark;
  --canvas:#ffffff;--parchment:#f5f5f7;--pearl:#fafafc;--ink:#1d1d1f;--muted:#6e6e73;--hairline:#e0e0e0;
  --blue:#0066cc;--blue-hover:#0071e3;--on-blue:#ffffff;--chip:#e8e8ed;
  --green:#1d8a3a;--red:#d70015;--amber:#b36b00;--purple:#6b4fbb;
  --ok-bg:#eaf6ee;--ok-fg:#14532d;--warn-bg:#fff1f0;--warn-fg:#8a1c14;--help-bg:#fff7e0}
@media (prefers-color-scheme:dark){:root{
  --canvas:#000000;--parchment:#1d1d1f;--pearl:#272729;--ink:#f5f5f7;--muted:#a1a1a6;--hairline:#3a3a3c;
  --blue:#2997ff;--blue-hover:#4aa9ff;--on-blue:#ffffff;--chip:#3a3a3c;
  --green:#30d158;--red:#ff453a;--amber:#ffb340;--purple:#b39dff;
  --ok-bg:#12301d;--ok-fg:#bfe6c9;--warn-bg:#3a1816;--warn-fg:#f1c4bf;--help-bg:#33290f}}
*{box-sizing:border-box}
body{margin:0;background:var(--parchment);color:var(--ink);
  font:17px/1.55 "Pretendard Variable",Pretendard,-apple-system,BlinkMacSystemFont,system-ui,"Apple SD Gothic Neo","Malgun Gothic","Noto Sans KR",sans-serif;letter-spacing:-.012em;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
h1,h2,h3{font-family:"Pretendard Variable",Pretendard,-apple-system,BlinkMacSystemFont,system-ui,"Apple SD Gothic Neo","Malgun Gothic","Noto Sans KR",sans-serif;letter-spacing:-.022em;line-height:1.15;margin:0 0 .6em}
h2{font-size:34px;font-weight:700;margin-top:8px;letter-spacing:-.03em}h3{font-size:22px;font-weight:600;margin-top:1.4em;letter-spacing:-.02em}
.hero{text-align:center;padding:48px 8px 28px}
.hero h1{font-size:clamp(34px,6vw,56px);font-weight:700;letter-spacing:-.035em;line-height:1.1;margin:0 0 14px}
.hero p{font-size:clamp(18px,2.4vw,24px);font-weight:400;color:var(--muted);margin:0 auto 26px;max-width:640px;letter-spacing:-.02em}
.hero .cta{display:flex;gap:14px;justify-content:center;flex-wrap:wrap}
.btn.ghost{background:transparent;color:var(--blue);border:1.5px solid var(--blue)}
.btn.ghost:hover{background:var(--blue);color:#fff}
a{color:var(--blue);text-decoration:none}a:hover{text-decoration:underline}

/* 상단 글로벌 내비게이션: 검정 띠 */
header{display:flex;gap:6px;align-items:center;padding:0 16px;min-height:52px;background:#000;color:#fff;flex-wrap:wrap}
header a,header span{color:#f5f5f7;font-size:15px;padding:8px 10px;border-radius:8px}
header a:hover{background:#1d1d1f;text-decoration:none}header .sp{flex:1}
header form button{background:transparent;color:#f5f5f7;border:1px solid #444;border-radius:999px;padding:6px 14px;font-size:14px}
main{max-width:1040px;margin:0 auto;padding:28px 20px 64px}

/* 표 */
table{width:100%;border-collapse:collapse;background:var(--canvas);display:block;overflow-x:auto;border-radius:18px;border:1px solid var(--hairline)}
th{font-size:14px;color:var(--muted);font-weight:600;background:var(--pearl)}
th,td{padding:12px 14px;border-bottom:1px solid var(--hairline);text-align:left;white-space:nowrap}
tr:last-child td{border-bottom:0}
td.actions{white-space:normal}td.actions>*{margin:3px 8px 3px 0;vertical-align:top}
tr.off td{opacity:.5}

/* 버튼: 알약 모양, 포인트 색은 파랑 하나 */
.btn,button{background:var(--blue);color:var(--on-blue);border:0;border-radius:999px;padding:10px 20px;cursor:pointer;
  text-decoration:none;font:inherit;font-size:16px;display:inline-block;line-height:1.2}
.btn:hover,button:hover{background:var(--blue-hover);text-decoration:none}
td button,.inline button{background:var(--chip);color:var(--ink);padding:7px 14px;font-size:14px}
td button:hover,.inline button:hover{background:var(--hairline)}
.btn.danger{background:transparent;color:var(--red);border:1px solid var(--red)}
.btn.small,button.small{padding:6px 14px;font-size:14px}
.btn.big,button.big{font-size:20px;padding:16px 30px}
.btn.go{background:var(--green);width:100%;font-size:22px;padding:20px;border-radius:18px;text-align:center}
.btn.go:hover{filter:brightness(1.08)}

/* 입력 */
input,select,textarea{font:inherit;font-size:17px;padding:12px 16px;border:1px solid var(--hairline);border-radius:12px;
  background:var(--canvas);color:var(--ink);max-width:100%;letter-spacing:inherit}
input:focus,select:focus,textarea:focus{outline:2px solid var(--blue);outline-offset:1px;border-color:transparent}
label{display:flex;flex-direction:column;gap:6px;font-weight:500}
.stack{display:flex;flex-direction:column;gap:14px;max-width:620px}.narrow{margin:80px auto;padding:0 8px}
.row{display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin:12px 0}.inline{display:inline}
small{color:var(--muted);font-weight:400}
.err{color:var(--red)}
code{background:var(--chip);padding:2px 8px;border-radius:6px;word-break:break-all;font-size:.92em}

/* 면(타일) */
.card{background:var(--canvas);border:1px solid var(--hairline);border-radius:18px;padding:20px;margin:16px 0}
.chip{display:inline-block;background:var(--chip);border-radius:999px;padding:4px 14px}
fieldset{border:1px solid var(--hairline);border-radius:12px}.check{flex-direction:row;align-items:center;gap:8px;margin:6px 0}
details summary{cursor:pointer}details.inline{display:inline-block}.small-form{max-width:320px;margin-top:8px}
.kv{width:auto}

/* 안내 상자 */
.ok,.warn{border-radius:18px;padding:14px 18px;margin:14px 0}
.ok{background:var(--ok-bg);color:var(--ok-fg)}.warn{background:var(--warn-bg);color:var(--warn-fg)}
.ok.big,.warn.big{padding:20px 22px;font-size:19px;font-weight:600}
.lead{font-size:20px;color:var(--ink)}.big{font-size:19px}
.steps{padding-left:22px}.steps li{margin:10px 0}

/* 큰 버튼 3개 (처음 화면) */
.bigbtns{display:grid;gap:14px;margin:20px 0}
.bigbtn{display:block;background:var(--canvas);border:1px solid var(--hairline);border-radius:18px;padding:22px 22px 22px 84px;
  position:relative;color:var(--ink);font-size:22px;font-weight:600;letter-spacing:-.02em}
.bigbtn:hover{background:var(--pearl);text-decoration:none}
.bigbtn small{display:block;font-weight:400;font-size:16px;margin-top:4px}
.bigbtn .n{position:absolute;left:22px;top:50%;transform:translateY(-50%);width:44px;height:44px;border-radius:50%;
  background:var(--blue);color:#fff;text-align:center;line-height:44px;font-size:20px}

/* 단계 카드 (설정, 명단 올리기) */
.step{display:flex;gap:18px;background:var(--canvas);border:1px solid var(--hairline);border-radius:18px;padding:22px;margin:16px 0}
.step .num{flex:none;width:44px;height:44px;border-radius:50%;background:var(--blue);color:#fff;font-weight:600;font-size:20px;text-align:center;line-height:44px}
.step .body{flex:1;min-width:0}.step h3{margin:0 0 10px;font-size:24px}.step ol{padding-left:22px}.step li{margin:10px 0}
.copybox{background:var(--parchment);border-radius:14px;padding:16px;margin:12px 0}
.copylabel{font-weight:600;margin-bottom:8px}
.copyvalue{font-family:ui-monospace,Consolas,monospace;word-break:break-all;background:var(--canvas);border:1px solid var(--hairline);padding:10px 12px;border-radius:10px;margin-bottom:10px}
details.help{background:var(--help-bg);border-radius:14px;padding:14px 16px;margin-top:12px}

/* 결과 숫자 카드 */
.counts{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px;margin:18px 0}
.count{border-radius:18px;padding:18px;text-align:center;font-size:17px;background:var(--canvas);border:1px solid var(--hairline)}
.count b{display:block;font-size:44px;font-weight:700;letter-spacing:-.03em;line-height:1.1}
.count.yes b{color:var(--green)}.count.no b{color:var(--red)}.count.wait b{color:var(--amber)}.count.check b{color:var(--purple)}.count.bad b{color:var(--muted)}
.tabs{display:flex;gap:8px;margin:18px 0 6px;flex-wrap:wrap}
.tabs a{padding:8px 18px;border-radius:999px;background:var(--chip);color:var(--ink)}
.tabs a.on{background:var(--ink);color:var(--canvas)}
.bigfile{font-size:17px;padding:22px;width:100%;border:2px dashed var(--hairline);border-radius:18px;background:var(--parchment)}
@media (max-width:640px){main{padding:20px 14px 48px}.step{flex-direction:column;padding:18px}h2{font-size:28px}header a{padding:6px 8px}}
`;

export function page(user, title, body) {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} - 면접 참석 확인</title>
<link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css">
<style>${CSS}</style></head><body>
${user ? `<header><a href="/"><b>면접 문자</b></a><a href="/">처음 화면</a><a href="/campaigns/new">면접 안내 보내기</a><a href="/messages">문자함</a>
${user.role === 'super' ? '<a href="/admin">설정</a><a href="/audit">기록</a>' : ''}<span class="sp"></span>
<span>${esc(user.username)}</span><a href="/password">비밀번호 바꾸기</a>
<form method="post" action="/logout" class="inline"><button>로그아웃</button></form></header>` : ''}
<main>${body}</main></body></html>`;
}
