import { APP_JS } from './appjs.js';
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

// ---- 아이콘 (24x24 선 아이콘, currentColor) ----
const ICONS = {
  home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>',
  send: '<path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4z"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5.1L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.5-6.9A2 2 0 0016.8 4H7.2a2 2 0 00-1.7 1.1z"/>',
  clipboard: '<path d="M9 3h6v3H9z"/><path d="M8 5H6a2 2 0 00-2 2v13a2 2 0 002 2h12a2 2 0 002-2V7a2 2 0 00-2-2h-2"/><path d="M8 12h8M8 16h5"/>',
  settings: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0116 0"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="M5 13l4 4L19 7"/>',
  alert: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18h0"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h0"/>',
  phone: '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>',
  download: '<path d="M12 4v11"/><path d="M7 11l5 5 5-5"/><path d="M5 20h14"/>',
  reply: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 016 6v3"/>',
  more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>'
};
export const icon = (name, size = 20) =>
  `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;

// ============================================================================
// 디자인 시스템 (DESIGN.md = Apple 스타일 기준 + Pretendard)
//  - 간격 8pt 격자: 4 8 12 16 24 32 48
//  - 글자 크기: 13 14 16 18 22 28 / 제목은 Pretendard 700, 자간 -0.02em
//  - 색: 파랑 하나(--blue), 의미색(초록/빨강/호박/보라)은 뱃지·숫자에만 사용
//  - 면: 흰 카드 + 1px 선, 그림자 없음. 모서리 8/12/18/pill
//  - 터치 대상 최소 44px, 입력 48px
//  - 좁은 화면(<=720px): 하단 탭 바, 표는 카드 목록으로 변환
// ============================================================================
const CSS = `
:root{color-scheme:light dark;
  --bg:#f5f5f7;--surface:#ffffff;--surface-2:#fafafc;--ink:#1d1d1f;--muted:#6e6e73;--line:#e0e0e0;--line-soft:#ececf0;
  --blue:#0066cc;--blue-hover:#0071e3;--on-blue:#fff;--blue-bg:#e8f1fb;
  --green:#1d8a3a;--green-bg:#eaf6ee;--red:#d70015;--red-bg:#fdecee;--amber:#9a5b00;--amber-bg:#fff4dc;--purple:#6b4fbb;--purple-bg:#f0ecfb;
  --chip:#ececf0;--focus:#0071e3;--amber-bar:#e3a008;
  --green-t:#17692b;--red-t:#b3001a;--amber-t:#8a5200;--purple-t:#5a3fb0;--blue-t:#0057b3;
  --r-s:8px;--r-m:12px;--r-l:18px;--nav-h:56px;--tab-h:64px}
@media (prefers-color-scheme:dark){:root{
  --bg:#000;--surface:#1c1c1e;--surface-2:#242426;--ink:#f5f5f7;--muted:#a1a1a6;--line:#3a3a3c;--line-soft:#2c2c2e;
  --blue:#2997ff;--blue-hover:#4aa9ff;--blue-bg:#0c2a45;
  --green:#30d158;--green-bg:#102a18;--red:#ff453a;--red-bg:#3a1618;--amber:#ffb340;--amber-bg:#332508;--purple:#b39dff;--purple-bg:#241d3d;
  --chip:#2c2c2e;--focus:#4aa9ff;--amber-bar:#ffb340;
  --green-t:#30d158;--red-t:#ff6961;--amber-t:#ffb340;--purple-t:#b39dff;--blue-t:#4aa9ff}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);
  font:16px/1.6 "Pretendard Variable",Pretendard,-apple-system,BlinkMacSystemFont,system-ui,"Apple SD Gothic Neo","Malgun Gothic","Noto Sans KR",sans-serif;
  letter-spacing:-.01em;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
h1,h2,h3,h4{letter-spacing:-.02em;line-height:1.25;margin:0}
h1{font-size:28px;font-weight:700}h2{font-size:22px;font-weight:700}h3{font-size:18px;font-weight:600}
p{margin:0}
a{color:var(--blue);text-decoration:none}a:hover{text-decoration:underline}
:focus-visible{outline:3px solid var(--focus);outline-offset:2px;border-radius:6px}
.muted,small{color:var(--muted)}small{font-size:14px}
.skip{position:absolute;left:-999px;top:8px;background:var(--surface);color:var(--ink);padding:10px 16px;border-radius:var(--r-s);z-index:100}
.skip:focus{left:8px}
.ico{flex:none;vertical-align:-4px}

/* ---------- 레이아웃 ---------- */
.topbar{position:sticky;top:0;z-index:20;background:#000;color:#f5f5f7;height:var(--nav-h);display:flex;align-items:center;gap:8px;padding:0 20px}
.brand{display:flex;align-items:center;gap:8px;color:#fff;font-weight:700;font-size:17px;letter-spacing:-.02em;margin-right:12px}
.brand:hover{text-decoration:none}
.brand .logo{width:28px;height:28px;border-radius:8px;background:var(--blue);display:grid;place-items:center;color:#fff}
.topnav{display:flex;gap:2px;flex:1}
.topnav a{color:#d2d2d7;padding:8px 14px;border-radius:999px;font-size:15px;display:flex;align-items:center;gap:6px}
.topnav a:hover{color:#fff;background:#1d1d1f;text-decoration:none}
.topnav a[aria-current=page]{color:#fff;background:#2c2c2e}
.usermenu{position:relative}
.usermenu summary{list-style:none;cursor:pointer;color:#f5f5f7;display:flex;align-items:center;gap:8px;padding:6px 12px;border-radius:999px;font-size:15px;min-height:44px}
.usermenu summary::-webkit-details-marker{display:none}
.usermenu summary:hover{background:#1d1d1f}
.usermenu .menu{position:absolute;right:0;top:calc(100% + 8px);min-width:220px;background:var(--surface);color:var(--ink);border:1px solid var(--line);border-radius:var(--r-m);padding:6px;display:flex;flex-direction:column}
.usermenu .menu a,.usermenu .menu button{display:block;width:100%;text-align:left;padding:10px 12px;border-radius:var(--r-s);color:var(--ink);background:none;border:0;font:inherit;font-size:15px;cursor:pointer;min-height:44px}
.usermenu .menu a:hover,.usermenu .menu button:hover{background:var(--chip);text-decoration:none}
.usermenu .who{padding:8px 12px;color:var(--muted);font-size:13px}
.page{max-width:1080px;margin:0 auto;padding:32px 20px 64px}
.col{max-width:720px}
.tabbar{display:none}
.dot{font-style:normal;background:var(--red);color:#fff;border-radius:999px;font-size:11px;font-weight:700;min-width:18px;height:18px;line-height:18px;text-align:center;padding:0 5px;margin-left:2px}
.topnav a .dot{margin-left:4px}
.tabbar a{position:relative}

.phead{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:24px;flex-wrap:wrap}
.phead>*{min-width:0;max-width:100%}
.phead .desc{color:var(--muted);margin-top:6px;font-size:16px}
.phead .back{display:inline-block;font-size:14px;margin-bottom:6px}
.pactions{display:flex;gap:8px;flex-wrap:wrap}
.section{margin-top:32px}
.shead{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:12px}
.stack{display:flex;flex-direction:column;gap:16px}
.row{display:flex;gap:12px;flex-wrap:wrap;align-items:center}
.grow{flex:1}

/* ---------- 면/카드 ---------- */
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--r-l);padding:20px}
.card+.card{margin-top:16px}
[hidden]{display:none!important}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.notice{display:flex;gap:12px;align-items:flex-start;border-radius:var(--r-m);padding:14px 16px;margin:0 0 20px;font-size:16px;color:var(--ink)}
.notice.ok{background:var(--green-bg)}.notice.warn{background:var(--red-bg)}.notice.info{background:var(--blue-bg)}
.notice .ico{margin-top:2px}
.notice.ok .ico{color:var(--green)}.notice.warn .ico{color:var(--red)}.notice.info .ico{color:var(--blue)}

/* ---------- 숫자 카드 ---------- */
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.stat{display:flex;flex-direction:column;gap:2px;background:var(--surface);border:1px solid var(--line);border-radius:var(--r-l);padding:16px 18px;color:var(--ink)}
a.stat:hover{background:var(--surface-2);text-decoration:none}
.stat b{font-size:32px;line-height:1.15;font-weight:700;letter-spacing:-.03em}
.stat span{color:var(--muted);font-size:14px}
.stat.yes b{color:var(--green)}.stat.no b{color:var(--red)}.stat.wait b{color:var(--amber)}.stat.review b{color:var(--purple)}

/* ---------- 버튼 ---------- */
.btn,button{font:inherit;font-size:16px;line-height:1.2;cursor:pointer;border:1px solid transparent;border-radius:999px;
  padding:12px 22px;min-height:44px;display:inline-flex;align-items:center;justify-content:center;gap:8px;
  background:var(--blue);color:var(--on-blue);text-decoration:none;font-weight:500;letter-spacing:-.01em}
.btn:hover,button:hover{background:var(--blue-hover);text-decoration:none}
.btn.secondary,button.secondary{background:var(--surface);color:var(--blue);border-color:var(--line)}
.btn.secondary:hover,button.secondary:hover{background:var(--surface-2)}
.btn.tertiary,button.tertiary{background:transparent;color:var(--blue);padding-left:10px;padding-right:10px}
.btn.tertiary:hover{background:var(--blue-bg)}
.btn.danger,button.danger{background:transparent;color:var(--red);border-color:var(--red)}
.btn.danger:hover{background:var(--red-bg)}
.btn.small,button.small{min-height:36px;padding:7px 14px;font-size:14px}
@media (max-width:640px){.btn.small,button.small{min-height:44px;padding:9px 16px}}
.mrow{position:relative}
.todo{list-style:none;margin:0;padding:0}
.todo li{border-top:1px solid var(--line-soft)}
.todo li:first-child{border-top:0}
.todo a{display:flex;align-items:center;gap:14px;padding:14px 18px;color:var(--ink);text-decoration:none}
.todo a:hover{background:var(--surface-2)}
.todo .n{flex:none;min-width:38px;height:38px;padding:0 8px;border-radius:12px;display:grid;place-items:center;font-weight:800;font-size:17px;font-variant-numeric:tabular-nums}
.todo .n.review{background:var(--purple-bg);color:var(--purple-t)}
.todo .n.info{background:var(--blue-bg);color:var(--blue-t)}
.todo .n.wait{background:var(--amber-bg);color:var(--amber-t)}
.todo .n.mute{background:var(--chip);color:var(--muted)}
.todo .n.ok{background:var(--green-bg);color:var(--green-t)}
.todo .t{flex:1;min-width:0;font-weight:600}
.todo .t small{display:block;font-weight:400;color:var(--muted)}
.todo .go{flex:none;color:var(--muted)}
.todo-done{display:flex;gap:10px;align-items:center;padding:18px;color:var(--green-t);font-weight:600}
.subnav{position:sticky;top:var(--nav-h);z-index:15;display:flex;gap:8px;overflow-x:auto;padding:10px 0;margin:-6px 0 8px;background:var(--bg);scrollbar-width:none}
.subnav::-webkit-scrollbar{display:none}
.subnav a{flex:none;padding:7px 14px;border-radius:999px;background:var(--chip);color:var(--ink);font-size:14px;font-weight:600;text-decoration:none}
.subnav a:hover{background:var(--line)}
[id^=sec-]{scroll-margin-top:calc(var(--nav-h) + 56px)}
.moresheet{display:none}
dialog.cdlg{border:0;border-radius:20px;padding:0;max-width:min(420px,calc(100vw - 32px));width:100%;background:var(--surface);color:var(--ink);box-shadow:0 24px 64px rgba(0,0,0,.35)}
dialog.cdlg::backdrop{background:rgba(0,0,0,.45)}
dialog.cdlg form{padding:22px}
dialog.cdlg p{margin:0 0 20px;font-size:17px;font-weight:600;line-height:1.5;word-break:keep-all}
.cdlg-actions{display:flex;gap:10px;justify-content:flex-end}
.cdlg-actions .btn{min-height:44px}
.rbtn{position:absolute;right:10px;bottom:8px;display:inline-grid;place-items:center;width:40px;height:40px;border-radius:999px;color:var(--blue)}
.mrow .mtext{padding-right:44px}
.rbtn:hover{background:var(--blue-bg)}
table.cand td.actions{width:168px}
table.cand td.actions select{width:100%;max-width:168px;min-height:38px}
table.cand td.c-outcome select{width:auto;min-width:96px}
@media (min-width:721px){table.cand td.c-reply{max-width:170px}table.cand td.c-site{white-space:nowrap}}
.resch>summary{cursor:pointer;color:var(--blue);font-size:14px;margin-top:4px;min-height:36px;display:flex;align-items:center}
.resch form{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
.resch input{width:150px;min-width:0;min-height:36px;padding:6px 10px}
.aidraft>summary{cursor:pointer;color:var(--blue);font-size:13px;margin-top:6px}
.aidraft form{display:grid;gap:6px;margin-top:6px}
.aidraft textarea{width:100%;min-height:0;font-size:14px;padding:8px 10px}
.aidraft button{justify-self:start}
.slotsum{display:grid;gap:8px;margin:0;padding:0;list-style:none}
.slotsum li{display:flex;justify-content:space-between;gap:12px;padding:10px 14px;background:var(--surface-2);border-radius:var(--r-s)}
.tgl-row{display:flex;gap:12px;align-items:flex-start;margin-top:14px}
.tgl-row>span{min-width:0;flex:1;line-height:1.45}
.tgl-row .tgl{margin-top:1px}
.tgl{position:relative;flex:none;width:48px;height:28px;min-height:0;border-radius:999px;border:0;padding:0;background:var(--line);cursor:pointer}
.tgl::after{content:"";position:absolute;top:3px;left:3px;width:22px;height:22px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.3);transition:left .15s}
.tgl.on{background:var(--green)}
.tgl.on::after{left:23px}
.btn.big{min-height:52px;padding:14px 28px;font-size:17px}
.btn.go{background:var(--green);width:100%;min-height:56px;font-size:18px;border-radius:var(--r-l)}
.btn.go:hover{filter:brightness(1.08)}
.btn.block{width:100%}
.inline{display:inline}
td button{background:var(--chip);color:var(--ink);min-height:36px;padding:6px 14px;font-size:14px;font-weight:500}
td button:hover{background:var(--line)}
.pactions form{display:inline-flex}
.pactions .btn,.pactions button{min-height:40px;padding:9px 18px;font-size:15px}

/* ---------- 폼 ---------- */
label{display:flex;flex-direction:column;gap:6px;font-weight:600;font-size:15px}
label small{font-weight:400}
input,select,textarea{font:inherit;font-size:16px;width:100%;min-width:0;max-width:100%;padding:12px 14px;min-height:48px;
  border:1px solid var(--line);border-radius:var(--r-m);background:var(--surface);color:var(--ink);letter-spacing:inherit}
textarea{min-height:120px;resize:vertical;line-height:1.55}
input::placeholder,textarea::placeholder{color:var(--muted);opacity:.8}
input:focus,select:focus,textarea:focus{outline:2px solid var(--focus);outline-offset:0;border-color:transparent}
input[type=radio],input[type=checkbox]{width:20px;height:20px;min-height:0;padding:0;accent-color:var(--blue);flex:none}
input[type=file]{padding:10px}
fieldset{border:1px solid var(--line);border-radius:var(--r-m);padding:14px 16px;min-width:0;margin:0}
legend{font-weight:600;padding:0 6px;font-size:15px}
.check{flex-direction:row;align-items:center;gap:10px;font-weight:500;min-height:44px}
.counter{display:flex;justify-content:space-between;color:var(--muted);font-size:13px}
.form-actions{display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-top:8px}
details summary{cursor:pointer;min-height:32px}
.small-form{max-width:320px;margin-top:8px}
.schedule{display:flex;flex-direction:column;gap:10px}
.quick{display:flex;gap:8px;flex-wrap:wrap}
.quick button{background:var(--chip);color:var(--ink);min-height:36px;padding:6px 14px;font-size:14px}
.quick button:hover{background:var(--line)}
.preview{white-space:pre-wrap;background:var(--surface-2);border:1px solid var(--line);border-radius:var(--r-m);padding:14px 16px;line-height:1.6;font-size:15px}

/* ---------- 뱃지/막대 ---------- */
.badge{display:inline-flex;align-items:center;white-space:nowrap;border-radius:999px;padding:3px 10px;font-size:13px;font-weight:600;line-height:1.4;background:var(--chip);color:var(--muted)}
.badge.ok{background:var(--green-bg);color:var(--green-t)}.badge.no{background:var(--red-bg);color:var(--red-t)}
.badge.wait{background:var(--amber-bg);color:var(--amber-t)}.badge.review{background:var(--purple-bg);color:var(--purple-t)}
.badge.info{background:var(--blue-bg);color:var(--blue-t)}.badge.fail{background:transparent;color:var(--red-t);box-shadow:inset 0 0 0 1px var(--red)}
.rbar{display:flex;height:10px;border-radius:999px;overflow:hidden;background:var(--chip);min-width:80px}
.rbar span{display:block;height:100%}.rbar .yes{background:var(--green)}.rbar .no{background:var(--red)}
.rbar .review{background:var(--purple)}.rbar .wait{background:var(--amber-bar)}
.legend{display:flex;gap:16px;flex-wrap:wrap;font-size:13px;color:var(--muted);margin-top:8px}
.legend i{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px}

/* ---------- 표 ---------- */
@media (max-width:640px){.table-wrap.hint::after{content:"옆으로 밀면 더 보여요 →";display:block;padding:8px 14px;font-size:13px;color:var(--muted);border-top:1px solid var(--line-soft);position:sticky;left:0}.table-wrap.hint th,.table-wrap.hint td{white-space:nowrap}}
.table-wrap{background:var(--surface);border:1px solid var(--line);border-radius:var(--r-l);overflow-x:auto}
table{width:100%;border-collapse:collapse}
th{font-size:13px;color:var(--muted);font-weight:600;text-align:left;background:var(--surface-2);padding:12px 16px;white-space:nowrap}
td{padding:14px 16px;border-top:1px solid var(--line-soft);vertical-align:middle}
tbody tr:first-child td{border-top:0}
tr.total td,tr.total th{background:var(--surface-2);font-weight:700;border-top:1px solid var(--line);color:var(--ink)}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
td.nowrap{white-space:nowrap}
td.msg{white-space:pre-wrap;word-break:break-word;min-width:220px}
tr.off td{opacity:.55}
td.actions{white-space:normal}td.actions>*{margin:3px 8px 3px 0;vertical-align:top}
table.sample th,table.sample td{white-space:nowrap}

/* ---------- 칩/탭 ---------- */
.tabs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px}
@media (max-width:720px){.tabs{flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none;margin-left:-16px;margin-right:-16px;padding:0 16px}.tabs::-webkit-scrollbar{display:none}.tabs a{flex:none;white-space:nowrap}}
.tabs a{padding:8px 16px;border-radius:999px;background:var(--chip);color:var(--ink);font-size:15px;font-weight:500;display:inline-flex;gap:6px;min-height:40px;align-items:center}
.tabs a:hover{text-decoration:none;background:var(--line)}
.tabs a.on,.tabs a[aria-current=page]{background:var(--ink);color:var(--bg)}
.tabs .n{opacity:.7;font-weight:400}
.chip{display:inline-block;background:var(--chip);border-radius:999px;padding:4px 14px}

/* ---------- 지원자 작업 공간: 상단 탭 · 새 지원 카드 · 연결 설정 ---------- */
.wstabs{display:flex;align-items:center;gap:2px;margin:-6px 0 22px;border-bottom:1px solid var(--line);overflow-x:auto;scrollbar-width:none}
.wstabs::-webkit-scrollbar{display:none}
.wstabs a{position:relative;flex:none;display:inline-flex;align-items:center;gap:7px;padding:12px 14px;margin-bottom:-1px;border-bottom:3px solid transparent;color:var(--muted);font-size:16px;font-weight:600;white-space:nowrap}
.wstabs a:hover{color:var(--ink);text-decoration:none}
.wstabs a[aria-current=page]{color:var(--ink);border-bottom-color:var(--ink)}
.wstabs .cnt{min-width:22px;height:22px;padding:0 7px;border-radius:999px;font-size:12px;line-height:22px;text-align:center;font-weight:700;background:var(--blue-bg);color:var(--blue-t)}
.wstabs .cnt.warn{background:var(--amber-bg);color:var(--amber-t)}
.wstabs .push{margin-left:auto;font-weight:500;font-size:14px}
.conn{display:inline-flex;align-items:center;gap:8px;padding:7px 14px;border-radius:999px;font-size:14px;font-weight:600;background:var(--chip);color:var(--muted);max-width:100%;white-space:normal;line-height:1.4}
.conn i{flex:none;width:9px;height:9px;border-radius:50%;background:var(--muted)}
.conn.on{background:var(--green-bg);color:var(--green-t)}.conn.on i{background:var(--green)}
.conn.idle{background:var(--amber-bg);color:var(--amber-t)}.conn.idle i{background:var(--amber-bar)}
a.conn:hover{text-decoration:none;filter:brightness(.96)}
.stats.tight{grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-bottom:16px}
.stats.tight .stat{padding:12px 16px}.stats.tight .stat b{font-size:26px}
.stat.on{outline:2px solid var(--ink);outline-offset:-2px}
.applist{display:flex;flex-direction:column;gap:12px}
.appcard{display:grid;grid-template-columns:auto minmax(0,1fr);gap:0 14px;background:var(--surface);border:1px solid var(--line);border-radius:var(--r-l);padding:16px 18px 14px}
.appcard.ready{box-shadow:inset 4px 0 0 var(--green)}
.appcard .sel{padding-top:4px}
.appcard .head{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 10px}
.appcard .name{font-size:18px;font-weight:700;letter-spacing:-.02em}
.appcard .meta{color:var(--muted);font-size:14px}
.appcard .when{margin-left:auto;color:var(--muted);font-size:13px;white-space:nowrap}
.appcard .post{margin-top:2px;font-size:14px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.appcard .post b{color:var(--ink);font-weight:600}
.appcard .states{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.appcard .sugg{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:8px;font-size:13px;color:var(--muted);font-weight:600}
.chipbtn{min-height:32px;padding:4px 12px;font-size:14px;background:var(--blue-bg);color:var(--blue-t);border:0;font-weight:600}
.chipbtn:hover{background:var(--blue-bg);filter:brightness(.95)}
.appcard .cl{margin-top:4px}
.appcard .cl>summary{display:inline-flex;align-items:center;min-height:32px;color:var(--blue);font-size:14px;font-weight:500;cursor:pointer}
.appcard .classify{margin-top:8px;display:grid;grid-template-columns:minmax(0,3fr) minmax(0,2fr) auto;gap:8px;align-items:end}
.appcard .fl{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--muted);font-weight:600}
.appcard .classify input,.appcard .reg input{min-height:42px;padding:9px 12px;font-size:15px}
.appcard .hint{grid-column:1/-1;flex-direction:row;align-items:center;gap:8px;color:var(--muted);font-size:13px;font-weight:400}
.appcard .hint input{width:16px;height:16px}
.appcard .foot{margin-top:8px;padding-top:10px;border-top:1px solid var(--line-soft);display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center}
.appcard .foot .grow{flex:1}
.appcard .reg{display:flex;gap:8px;align-items:center}
.appcard .reg input{width:180px}
.appcard .lk{background:none;border:0;color:var(--blue);padding:6px 8px;min-height:36px;font-size:14px;font-weight:500;border-radius:999px}
.appcard .lk:hover{background:var(--blue-bg)}
.appcard .lk.quiet{color:var(--muted)}
@media(max-width:720px){.appcard{padding:14px}.appcard .classify{grid-template-columns:1fr 1fr}.appcard .classify .sv{grid-column:1/-1}.appcard .reg{width:100%}.appcard .reg input{flex:1;width:auto}.appcard .when{margin-left:0;width:100%}}
.bulkdock{position:sticky;top:calc(var(--nav-h) + 8px);z-index:12;display:none;gap:8px 12px;align-items:center;flex-wrap:wrap;background:var(--ink);color:var(--bg);border-radius:var(--r-l);padding:10px 14px;margin-bottom:12px;box-shadow:0 8px 24px rgba(0,0,0,.18)}
.bulkdock.on{display:flex}
.bulkdock b{font-size:15px;margin-right:auto}
.bulkdock button{min-height:38px;padding:7px 16px;font-size:14px;background:var(--bg);color:var(--ink)}
.bulkdock button:hover{filter:brightness(.95);background:var(--bg)}
.bulkdock button.ghost{background:transparent;color:var(--bg);border-color:rgba(255,255,255,.45)}
.listbar{display:flex;justify-content:space-between;align-items:center;gap:12px;margin:0 0 10px 4px;font-size:14px}
.selall{flex-direction:row;align-items:center;gap:8px;font-weight:500;color:var(--muted);font-size:14px;margin:0}
.hero{display:flex;gap:14px;align-items:center;justify-content:space-between;flex-wrap:wrap;background:var(--surface);border:1px solid var(--line);border-radius:var(--r-l);padding:16px 20px;margin-bottom:16px}
.hero b{font-size:17px}
.csteps{counter-reset:cs;display:flex;flex-direction:column;gap:14px;margin-bottom:16px}
.cstep{position:relative;display:block;background:var(--surface);border:1px solid var(--line);border-radius:var(--r-l);padding:20px 20px 20px 66px}
.cstep::before{counter-increment:cs;content:counter(cs);position:absolute;left:18px;top:18px;width:34px;height:34px;border-radius:50%;background:var(--ink);color:var(--bg);display:grid;place-items:center;font-weight:700}
.cstep.done::before{content:"✓";background:var(--green);color:#fff}
.cstep h2{font-size:18px;margin-bottom:4px}
.cstep .stack{margin-top:12px}
@media(max-width:640px){.cstep{padding:16px}.cstep::before{position:static;margin-bottom:10px}}
.advanced{margin-top:8px}
.advanced>summary{font-weight:600;padding:10px 4px;color:var(--muted)}
.advanced .card{margin-top:12px}

/* ---------- 대화 창(시트) · 지원자 상세 ---------- */
dialog.sheet{border:0;border-radius:22px;padding:0;max-width:min(640px,calc(100vw - 24px));width:100%;background:var(--surface);color:var(--ink);box-shadow:0 24px 64px rgba(0,0,0,.35)}
dialog.sheet::backdrop{background:rgba(0,0,0,.45)}
dialog.sheet>form,dialog.sheet>.dlgbox{padding:24px;display:flex;flex-direction:column;gap:14px}
dialog.sheet>.dlgbox>form{display:flex;flex-direction:column;gap:14px}
dialog.sheet h2{margin:0}
.dlg-actions{display:flex;gap:10px;justify-content:flex-end;margin-top:4px}
@media (max-width:640px){dialog.sheet{margin:auto 0 0;max-width:100vw;border-radius:22px 22px 0 0}dialog.sheet>form,dialog.sheet>.dlgbox{padding:20px 16px 24px}}
.pd{display:grid;grid-template-columns:minmax(0,1fr) 320px;grid-template-areas:"main side" "main manage";grid-template-rows:auto 1fr;gap:20px;align-items:start}
.pd-main{grid-area:main;min-width:0}.pd-side{grid-area:side}.pd-manage{grid-area:manage}
@media (max-width:900px){.pd{grid-template-columns:1fr;grid-template-areas:"side" "main" "manage";grid-template-rows:auto}}
.pd-hero{display:flex;gap:16px;align-items:center;flex-wrap:wrap;background:var(--surface);border:1px solid var(--line);border-radius:var(--r-l);padding:20px;margin-bottom:20px}
.pd-hero .nm{font-size:26px;font-weight:700;letter-spacing:-.02em;margin:0}
.pd-hero .ph{display:flex;gap:8px;align-items:center;flex-wrap:wrap;color:var(--muted);font-variant-numeric:tabular-nums}
.pd-hero .acts{margin-left:auto;display:flex;gap:8px;flex-wrap:wrap}
@media (max-width:640px){.pd-hero .acts{margin-left:0;width:100%;display:grid;grid-template-columns:1fr 1fr}.pd-hero .acts>*{white-space:nowrap;justify-content:center}.pd-hero .acts>:first-child{grid-column:1/-1}}
.avatar{width:64px;height:64px;border-radius:50%;background:var(--blue-bg);color:var(--blue-t);display:grid;place-items:center;font-size:24px;font-weight:700;flex:none}
.panel{background:var(--surface);border:1px solid var(--line);border-radius:var(--r-l);padding:18px 20px;margin-bottom:14px;overflow:hidden}
.panel h2{font-size:17px;margin-bottom:10px;display:flex;align-items:center;gap:6px}
.panel.bad{background:var(--red-bg);border-color:transparent}
.panel.bad h2{color:var(--red-t)}
.panel.good{background:var(--green-bg);border-color:transparent}
.panel.good h2{color:var(--green-t)}
.aitem{padding:14px 0;border-top:1px solid var(--line-soft)}
.aitem:first-of-type{border-top:0;padding-top:4px}
.aitem .t{font-weight:600}
.aitem .chips{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0}
.aitem small{display:block}

/* ---------- 홈 ---------- */
.actions-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}
.action{display:flex;gap:14px;align-items:center;background:var(--surface);border:1px solid var(--line);border-radius:var(--r-l);padding:18px;color:var(--ink)}
.action:hover{background:var(--surface-2);text-decoration:none}
.action .bubble{width:44px;height:44px;border-radius:12px;background:var(--blue-bg);color:var(--blue);display:grid;place-items:center;flex:none}
.action b{display:block;font-size:17px}.action span{color:var(--muted);font-size:14px}
.feed{list-style:none;margin:0;padding:0}
.feed li{display:grid;grid-template-columns:1fr auto auto;gap:2px 12px;align-items:center;padding:14px 16px;border-top:1px solid var(--line-soft)}
.feed li:first-child{border-top:0}
.feed .who{font-weight:600;white-space:nowrap}
.feed .what{grid-column:1/-1;grid-row:2;min-width:0;white-space:pre-wrap;word-break:break-word}
.feed .when{color:var(--muted);font-size:13px;white-space:nowrap}
.camp{display:block;color:var(--ink);padding:16px 18px;border-top:1px solid var(--line-soft)}
.camp:first-child{border-top:0}.camp:hover{background:var(--surface-2);text-decoration:none}
.camp .top{display:flex;justify-content:space-between;gap:12px;align-items:center;margin-bottom:10px}
.camp .meta{color:var(--muted);font-size:14px;margin-top:8px}

/* ---------- 단계(마법사) ---------- */
.step{display:flex;gap:16px;align-items:flex-start;background:var(--surface);border:1px solid var(--line);border-radius:var(--r-l);padding:20px;margin-bottom:16px}
.step>.num{flex:none;width:32px;height:32px;border-radius:50%;background:var(--blue);color:#fff;font-weight:700;display:grid;place-items:center;font-size:15px}
.step>.body{flex:1;min-width:0}.step h3{margin:0 0 10px}
.step ol{padding-left:22px;margin:8px 0}.step li{margin:8px 0}
.copybox{background:var(--surface-2);border:1px solid var(--line);border-radius:var(--r-m);padding:14px;margin:12px 0}
.copylabel{font-weight:600;margin-bottom:8px}
.copyvalue{font-family:ui-monospace,Consolas,monospace;word-break:break-all;background:var(--surface);border:1px solid var(--line);padding:10px 12px;border-radius:var(--r-s);margin-bottom:10px}
details.help{background:var(--amber-bg);border-radius:var(--r-m);padding:12px 14px;margin-top:12px}
.dropzone{border:2px dashed var(--line);border-radius:var(--r-l);padding:20px;background:var(--surface-2)}
code{background:var(--chip);padding:2px 8px;border-radius:6px;word-break:break-all;font-size:.92em}
.empty{text-align:center;padding:40px 20px;color:var(--muted)}
.empty-title{font-size:17px;font-weight:600;color:var(--ink);margin-bottom:6px}
.chip-list{display:flex;gap:8px;flex-wrap:wrap}

/* ---------- 목록(문자함/설정) ---------- */
.mlist{list-style:none;margin:0;padding:0}
.mrow{padding:14px 18px;border-top:1px solid var(--line-soft)}
.mrow:first-child{border-top:0}
.mtop{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.mtop .when{margin-left:auto;color:var(--muted);font-size:13px;white-space:nowrap}
.mtext{white-space:pre-wrap;word-break:break-word;margin-top:6px}
.mact{margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.pcard{padding:16px 18px}.pcard+.pcard{margin-top:12px}
.pcard.off{opacity:.7}
.prow{display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap}
.ptitle{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:17px}
.pmore{margin-top:12px;border-top:1px solid var(--line-soft);padding-top:10px}
.pgrid{display:flex;flex-direction:column;gap:16px;margin-top:12px}
.pbtns{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.urow{display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap;padding:12px 0;border-top:1px solid var(--line-soft)}
.urow:first-of-type{border-top:0}.urow.off{opacity:.6}
details.pop summary{list-style:none}details.pop summary::-webkit-details-marker{display:none}

/* ---------- 로그인 ---------- */
.auth{min-height:100vh;display:grid;place-items:center;padding:24px}
.auth-wrap{width:100%;max-width:400px}
.auth-brand{font-weight:700;font-size:15px;color:var(--muted);margin:0 0 18px;letter-spacing:-.01em}
@media (max-width:640px){.auth{place-items:start center;padding-top:36px}}
.auth-card{width:100%;max-width:400px}
.auth-card .logo{width:48px;height:48px;border-radius:14px;background:var(--blue);display:grid;place-items:center;color:#fff;margin-bottom:20px}
.auth-card h1{font-size:28px;margin-bottom:6px}

/* ---------- 좁은 화면 ---------- */
@media (max-width:720px){
  .topnav,.usermenu .label{display:none}
  .topbar{padding:0 16px}
  .usermenu{margin-left:auto}
  .page{padding:20px 16px calc(var(--tab-h) + 32px)}
  h1{font-size:24px}
  .phead{margin-bottom:16px}
  .tabbar{display:grid;grid-template-columns:repeat(5,1fr);position:fixed;left:0;right:0;bottom:0;z-index:30;height:var(--tab-h);
    background:var(--surface);border-top:1px solid var(--line);padding-bottom:env(safe-area-inset-bottom)}
  .tabbar a{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;color:var(--muted);font-size:11px;font-weight:500}
  .tabbar a:hover{text-decoration:none}
  .tabbar a .dot{position:absolute;top:6px;left:calc(50% + 6px);margin:0}
  .tabbar a[aria-current=page]{color:var(--blue)}
  .tabbar .tabmore{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;color:var(--muted);font-size:11px;font-weight:500;background:none;border:0;min-height:0;padding:0;border-radius:0;cursor:pointer}
  .tabbar .tabmore.cur{color:var(--blue)}
  .moresheet{display:block;position:fixed;left:0;right:0;bottom:var(--tab-h);z-index:29;background:var(--surface);border-top:1px solid var(--line);border-radius:18px 18px 0 0;padding:8px 8px 14px;box-shadow:0 -14px 36px rgba(0,0,0,.2)}
  .moresheet[hidden]{display:none}
  .moresheet ul{list-style:none;margin:0;padding:0}
  .moresheet a,.moresheet button{display:flex;justify-content:flex-start;gap:14px;align-items:center;width:100%;padding:14px 16px;font-size:16px;font-weight:500;color:var(--ink);background:none;border:0;border-radius:12px;text-align:left;text-decoration:none;min-height:0;cursor:pointer}
  .moresheet a:hover,.moresheet button:hover{background:var(--chip)}
  .moresheet .cur{color:var(--blue)}
  .stats{grid-template-columns:repeat(2,1fr)}
  .actions-grid{grid-template-columns:1fr}
  table.cards thead{display:none}
  table.cards,table.cards tbody,table.cards tr,table.cards td{display:block;width:100%}
  table.cards tr{padding:12px 16px;border-top:1px solid var(--line-soft)}
  table.cards tbody tr:first-child{border-top:0}
  table.cards td{border:0;padding:3px 0;text-align:left;display:flex;gap:10px;justify-content:space-between;white-space:normal}
  table.cards td[data-label]::before{content:attr(data-label);color:var(--muted);font-size:13px;flex:none;min-width:64px}
  table.cards td.msg{min-width:0}
  table.cards.cand td::before{content:none}
  table.cards.cand tr{display:grid;grid-template-columns:1fr auto;gap:4px 12px;align-items:center}
  table.cards.cand td{display:block;padding:0}
  table.cards.cand td.c-name{grid-column:1;font-weight:600;font-size:16px}
  table.cards.cand td.c-status{grid-column:2;justify-self:end}
  table.cards.cand td.c-site,table.cards.cand td.c-phone,table.cards.cand td.c-when{grid-column:1/-1;color:var(--muted);font-size:14px}
  table.cards.cand td.c-when:empty{display:none}
  table.cards.cand td.c-outcome{grid-column:1/-1}
  table.cards.cand td.c-reply{grid-column:1/-1;background:var(--surface-2);border-radius:var(--r-s);padding:8px 10px}
  table.cards.cand td.c-reply:empty{display:none}
  table.cards.cand td.actions{grid-column:1/-1}
  table.cards td.actions{justify-content:flex-start}
  .step{padding:16px}
}
.fetchwhen{margin-left:6px;font-size:12px;white-space:nowrap}
/* 진행 카드(오래 걸리는 작업): 아래에 작게, 걸린 시간과 서버 단계 */
.opdock{position:fixed;right:24px;bottom:24px;z-index:60;width:min(380px,calc(100vw - 32px));background:var(--surface);color:var(--ink);
  border:1px solid var(--line);border-radius:16px;box-shadow:0 12px 32px rgba(0,0,0,.16);padding:14px 16px;animation:opin .18s ease-out}
.opdock.bad{border-color:var(--red-t)}
.op-head{display:flex;align-items:center;gap:10px}
.op-title{flex:1;min-width:0;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.op-time{font-variant-numeric:tabular-nums;color:var(--muted);font-size:14px}
.op-spin{width:16px;height:16px;border-radius:50%;border:2px solid var(--line);border-top-color:var(--blue);animation:opspin .8s linear infinite;flex:none}
.op-spin.done{animation:none;border-color:var(--blue)}
.op-log{list-style:none;margin:10px 0 0;padding:0;display:grid;gap:3px;font-size:13px;color:var(--muted)}
.op-log li{display:flex;gap:10px}
.op-log li:last-child{color:var(--ink)}
.op-log .t{flex:none;width:52px;text-align:right;font-variant-numeric:tabular-nums;opacity:.8}
.op-log .m{min-width:0;overflow-wrap:anywhere}
.op-hint{margin:10px 0 0;font-size:13px;color:var(--ink);background:var(--surface-2);border-radius:10px;padding:8px 10px}
@keyframes opspin{to{transform:rotate(360deg)}}
@keyframes opin{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@media (max-width:720px){.opdock{left:16px;right:16px;width:auto;bottom:calc(var(--tab-h) + 12px + env(safe-area-inset-bottom))}}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
`;

const HEAD_ASSETS = `<meta name="color-scheme" content="light dark">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%230066cc'/%3E%3Cg transform='translate(6 6) scale(.833)' fill='none' stroke='white' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M22 2L11 13'/%3E%3Cpath d='M22 2l-7 20-4-9-9-4z'/%3E%3C/g%3E%3C/svg%3E">
<link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css">`;

// nav 항목 (표시 이름은 한곳에서 관리)
// 일의 순서대로: 홈 → 지원자(새 지원·등록) → 면접(안내·오늘 면접) → 문자함(답장·직접 문자). 문자 보내기는 문자함의 "새 문자"
export const NAV = [
  { key: 'home', href: '/', label: '홈', icon: 'home' },
  { key: 'applicants', href: '/applicants/inbox', label: '지원자', icon: 'user' },
  { key: 'interview', href: '/campaigns', label: '면접', icon: 'clipboard' },
  { key: 'inbox', href: '/messages', label: '문자함', icon: 'inbox' },
  { key: 'settings', href: '/admin', label: '설정', icon: 'settings', superOnly: true }
];

// nav: 현재 위치(home|send|inbox|interview|settings|account)
export function page(user, title, body, nav = '', badges = {}) {
  const head = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} - 문자 관리 시스템</title>${HEAD_ASSETS}<style>${CSS}</style>`;
  if (!user) return `<!doctype html><html lang="ko"><head>${head}</head><body><main id="main" class="auth"><div class="auth-wrap"><p class="auth-brand">문자 관리 시스템</p>${body}</div></main></body></html>`;

  const items = NAV.filter((n) => !n.superOnly || user.role === 'super');
  // 일반 관리자는 설정 대신 "내 계정" 탭
  // 하단 탭은 5칸: 홈 · 지원자 · 면접 · 문자함 + 더보기(문자 보내기, 설정, 내 계정 ...)
  const tabItems = items.filter((n) => !n.noTab && n.key !== 'settings');
  const moreCurrent = ['settings', 'account', 'send'].includes(nav);
  const moreLinks = [
    { key: 'send', href: '/send', label: '문자 보내기', icon: 'send' },
    ...(user.role === 'super' ? [{ key: 'settings', href: '/admin', label: '설정', icon: 'settings' }] : []),
    { key: 'account', href: '/password', label: '내 계정', icon: 'user' },
    { key: 'help', href: '/help/phone', label: '폰 설치 안내', icon: 'phone' },
    ...(user.role === 'super' ? [{ key: 'audit', href: '/audit', label: '기록 보기', icon: 'clipboard' }] : [])
  ];
  const link = (n, tab) => `<a href="${n.href}"${nav === n.key ? ' aria-current="page"' : ''}>${icon(n.icon, tab ? 22 : 18)}<span>${esc(tab ? n.short || n.label : n.label)}</span>${badges[n.key] ? `<i class="dot" aria-label="안 읽은 문자 ${badges[n.key]}건">${badges[n.key] > 99 ? '99+' : badges[n.key]}</i>` : ''}</a>`;
  return `<!doctype html><html lang="ko"><head>${head}</head><body>
<a class="skip" href="#main">본문 바로가기</a>
<div class="topbar">
  <a class="brand" href="/"><span class="logo">${icon('send', 16)}</span>문자 관리</a>
  <nav class="topnav" aria-label="주 메뉴">${items.map((n) => link(n, false)).join('')}</nav>
  <details class="usermenu">
    <summary>${icon('user', 18)}<span class="label">${esc(user.name || user.username)}</span></summary>
    <div class="menu">
      <div class="who">${esc(user.name || user.username)}${user.email ? `<br>${esc(user.email)}` : ''}<br>${user.role === 'super' ? '관리자' : '일반 사용자'}</div>
      <a href="/password">내 계정</a>
      <a href="/help/phone">폰 설치 안내</a>
      ${user.role === 'super' ? '<a href="/audit">기록 보기</a>' : ''}
      <form method="post" action="/logout"><button type="submit">로그아웃</button></form>
    </div>
  </details>
</div>
<main id="main" class="page">${body.replace(/<thead>[\s\S]*?<\/thead>/g, (m) => m.replace(/<th(?=[\s>])(?![^>]*\bscope=)/g, '<th scope="col"'))}</main>
<nav class="tabbar" aria-label="하단 메뉴">${tabItems.map((n) => link(n, true)).join('')}<button type="button" class="tabmore${moreCurrent ? ' cur' : ''}" aria-expanded="false" aria-controls="moresheet">${icon('more', 22)}<span>더보기</span></button></nav>
<div class="moresheet" id="moresheet" hidden><ul>${moreLinks.map((m) => `<li><a href="${m.href}"${nav === m.key ? ' class="cur" aria-current="page"' : ''}>${icon(m.icon, 20)}<span>${esc(m.label)}</span></a></li>`).join('')}
  <li><form method="post" action="/logout"><button type="submit">${icon('send', 20)}<span>로그아웃</span></button></form></li></ul></div>
<script>${APP_JS}</script>
</body></html>`;
}
