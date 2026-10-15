export const STATUS_LABEL = {
  pending: '발송대기', sending: '발송중', sent: '미응답', attending: '참석', absent: '불참', unclear: '확인필요', failed: '발송실패'
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
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,'Malgun Gothic',sans-serif}
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
@media (max-width:600px){main{padding:12px}}
`;

export function page(user, title, body) {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} - 면접 참석 확인</title>
<style>${CSS}</style></head><body>
${user ? `<header><a href="/"><b>면접 참석 확인</b></a><a href="/campaigns/new">새 캠페인</a>
${user.role === 'super' ? '<a href="/admin">관리</a><a href="/audit">감사로그</a>' : ''}<span class="sp"></span>
<span>${esc(user.username)}</span><a href="/password">비밀번호</a>
<form method="post" action="/logout" class="inline"><button>로그아웃</button></form></header>` : ''}
<main>${body}</main></body></html>`;
}
