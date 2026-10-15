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

const CSS = `
:root{color-scheme:light dark;--bg:#fafafa;--fg:#1b1b1f;--card:#fff;--line:#d8d8de;--accent:#2457d6}
@media (prefers-color-scheme:dark){:root{--bg:#16161a;--fg:#e8e8ee;--card:#1f1f25;--line:#3a3a44;--accent:#7aa2ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.6 system-ui,'Malgun Gothic',sans-serif}
header{display:flex;gap:16px;align-items:center;padding:10px 16px;border-bottom:1px solid var(--line);background:var(--card);flex-wrap:wrap}
header a{color:var(--fg);text-decoration:none}header .sp{flex:1}
main{max-width:1100px;margin:0 auto;padding:16px}
table{width:100%;border-collapse:collapse;background:var(--card);display:block;overflow-x:auto}
th,td{padding:6px 10px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}
a{color:var(--accent)}.btn,button{background:var(--accent);color:#fff;border:0;border-radius:6px;padding:7px 12px;cursor:pointer;text-decoration:none;font:inherit;display:inline-block}
.btn.danger{background:#c0392b}td button{padding:3px 8px;margin-right:4px}
input,select,textarea{font:inherit;padding:7px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--fg);max-width:100%}
.stack{display:flex;flex-direction:column;gap:10px;max-width:560px}.narrow{margin:60px auto}
.row{display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin:10px 0}.inline{display:inline}
.err{color:#c0392b}small{opacity:.7;font-weight:normal}label{display:flex;flex-direction:column;gap:4px}
.ok{background:#e6f4ea;color:#14532d;border:1px solid #86c99a;border-radius:8px;padding:10px 12px;margin:10px 0}
.warn{background:#fdecea;color:#7a1c14;border:1px solid #e3a39c;border-radius:8px;padding:10px 12px;margin:10px 0}
@media (prefers-color-scheme:dark){.ok{background:#12301d;color:#bfe6c9;border-color:#2f6b45}.warn{background:#3a1816;color:#f1c4bf;border-color:#7a3a35}}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;margin:12px 0}
.steps{padding-left:20px}.steps li{margin:10px 0}
.kv{width:auto;margin-top:6px}.kv th{white-space:nowrap}
code{background:rgba(127,127,127,.15);padding:2px 6px;border-radius:4px;word-break:break-all}
.btn.small,button.small{padding:3px 10px}
.chip{display:inline-block;background:rgba(127,127,127,.15);border-radius:12px;padding:2px 10px}
tr.off td{opacity:.5}
td.actions{white-space:normal}td.actions>*{margin:2px 6px 2px 0;vertical-align:top}
details.inline{display:inline-block}details summary{cursor:pointer}
.small-form{max-width:300px;margin-top:6px}
fieldset{border:1px solid var(--line);border-radius:8px}.check{flex-direction:row;align-items:center;gap:6px;margin:4px 0}
.big{font-size:19px}.lead{font-size:18px}
.btn.big,button.big{font-size:20px;padding:14px 22px;border-radius:10px}
.btn.go{background:#1a8f3c;width:100%;font-size:22px;padding:18px}
.ok.big,.warn.big{padding:16px;font-size:19px}
.bigbtns{display:grid;gap:12px;margin:16px 0}
.bigbtn{display:block;background:var(--card);border:2px solid var(--accent);border-radius:14px;padding:18px 18px 18px 64px;position:relative;text-decoration:none;color:var(--fg);font-size:21px;font-weight:700}
.bigbtn small{display:block;font-weight:400;font-size:15px;margin-top:2px}
.bigbtn .n{position:absolute;left:16px;top:50%;transform:translateY(-50%);width:36px;height:36px;border-radius:50%;background:var(--accent);color:#fff;text-align:center;line-height:36px}
.step{display:flex;gap:14px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;margin:14px 0}
.step .num{flex:none;width:40px;height:40px;border-radius:50%;background:var(--accent);color:#fff;font-weight:700;font-size:20px;text-align:center;line-height:40px}
.step .body{flex:1;min-width:0}.step h3{margin:0 0 8px}.step ol{padding-left:22px}.step li{margin:8px 0}
.copybox{border:2px dashed var(--accent);border-radius:12px;padding:12px;margin:10px 0}
.copylabel{font-weight:700;margin-bottom:6px}.copyvalue{font-family:monospace;word-break:break-all;background:rgba(127,127,127,.12);padding:8px;border-radius:8px;margin-bottom:8px}
details.help{background:rgba(255,180,0,.12);border-radius:10px;padding:10px 12px;margin-top:8px}
.counts{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:10px;margin:14px 0}
.count{border-radius:14px;padding:14px;text-align:center;font-size:17px;background:var(--card);border:2px solid var(--line)}
.count b{display:block;font-size:36px}
.count.yes{border-color:#1a8f3c}.count.no{border-color:#c0392b}.count.wait{border-color:#d19a00}.count.check{border-color:#6b4fbb}.count.bad{border-color:#7a7a7a}
.bigfile{font-size:17px;padding:14px;width:100%;border:2px dashed var(--accent);border-radius:12px}
@media (max-width:600px){main{padding:12px}.step{flex-direction:column}}
`;

export function page(user, title, body) {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} - 면접 참석 확인</title>
<style>${CSS}</style></head><body>
${user ? `<header><a href="/"><b>면접 문자</b></a><a href="/">처음 화면</a><a href="/campaigns/new">면접 안내 보내기</a><a href="/messages">문자함</a>
${user.role === 'super' ? '<a href="/admin">설정</a><a href="/audit">기록</a>' : ''}<span class="sp"></span>
<span>${esc(user.username)}</span><a href="/password">비밀번호 바꾸기</a>
<form method="post" action="/logout" class="inline"><button>로그아웃</button></form></header>` : ''}
<main>${body}</main></body></html>`;
}
