// 새 지원(메일 수신함): 알바몬 지원 알림 메일이 모이는 곳. 담당자가 이력서를 열어 연락처를 확인해 지원자로 등록한다.
import { first, run, all } from './d1.js';
import { makeZip } from './zip.js';
import { EXTENSION_FILES, EXTENSION_VERSION } from './extension-bundle.js';
import { EXT_BRIDGE_JS } from './ext-bridge-page.js';
import { esc, icon, fmtTime } from './views.js';
import { fmtPhone, fmtWhen, pageHeader, tableWrap, emptyState } from './ui.js';
import { peopleTabs, connState, unclassifiedPostings, suggestForTitles, agentIdle, stalledText } from './workspace.js';
import { normalizePhone, isValidMobile } from './parser.js';
import {
  getUserMailName, setUserMailName, inboxScope, ensureIntakeToken, intakeAddress, intakeDomain, listInbox, pendingInboxCount,
  requestFetch, requestFetchByPosting, createAgentToken, hasAgentToken, getAutoRegister, setAutoRegister, agentStatus
} from './mail-intake.js';

// 수신함은 열어 둔 채로 두면 1분마다 새로 고친다(새 지원 메일이 저절로 보이게).
// 입력 중이거나 입력칸에 커서가 있거나 안내 창이 떠 있거나 보이지 않는 탭이면 새로 고치지 않는다.
const AUTO_REFRESH_JS = String.raw`
(function () {
  var dirtyAt = 0, loaded = Date.now();
  document.addEventListener('input', function () { dirtyAt = Date.now(); }, true);
  function typing() {
    var a = document.activeElement;
    return (Date.now() - dirtyAt < 180000) || document.querySelector('dialog[open]') || (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));
  }
  function tick() {
    if (document.hidden || typing()) return;
    if (Date.now() - loaded >= 60000) window.location.reload();
  }
  setInterval(tick, 15000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) tick(); });
})();
`;

export { peopleTabs };

// 이력서 페이지에서 쓰는 "가져오기 도구"(북마크). 로그인한 담당자의 화면에서 눈에 보이는 글만 읽어 우리 화면으로 넘긴다.
export function bookmarklet(origin) {
  const code = "(function(){try{var t=(document.body&&document.body.innerText)||'';" +
    "var m=t.match(/01[016789][-\\s.]?\\d{3,4}[-\\s.]?\\d{4}/g)||[];var p=[];" +
    "m.forEach(function(x){x=x.replace(/\\D/g,'');if(p.indexOf(x)<0)p.push(x);});" +
    "var d={u:location.href,p:p.slice(0,5),t:t.slice(0,5000)};" +
    "window.open('" + origin.replace(/'/g, '') + "/applicants/inbox/capture#'+encodeURIComponent(JSON.stringify(d)),'_blank');" +
    "}catch(e){alert('가져오지 못했어요: '+e.message);}})();";
  return 'javascript:' + code;
}

const JSON_IN_SCRIPT = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');

const STATUS_BADGE = {
  pending: '<span class="badge wait">대기</span>',
  registered: '<span class="badge ok">등록됨</span>',
  ignored: '<span class="badge mute">무시</span>'
};

const SUBLINE = (r) => [r.gender, r.age ? r.age + '세' : '', r.address, r.career ? '경력 ' + r.career : ''].filter(Boolean).join(' · ');

export async function renderInbox(db, env, { status = 'pending', isSuper = false, flash = '', err = '', origin = '', fetched = 0, viewer = null, filter = '', n = 0, skipped = 0, fr = 0 } = {}) {
  const pending = await pendingInboxCount(db, viewer);
  const todo = await unclassifiedPostings(db).catch(() => 0);
  const all_ = await listInbox(db, status === 'done' ? 'done' : 'pending', 200, viewer);
  const dsc = inboxScope(viewer);
  const doneCount = (await first(db, `SELECT COUNT(*) n FROM applicant_inbox WHERE status != 'pending' AND ${dsc.sql}`, ...dsc.args)).n;
  const agent = await agentStatus(db, viewer ? viewer.id : null);
  const cs = connState(agent);
  const idle = agentIdle(agent);

  const FLASH = {
    fetch: '연락처 가져오기를 요청했어요. 확장 프로그램이 켜져 있으면 1분 안에 채워져요.',
    fetchall: `${Number(fetched) || 0}건의 연락처 가져오기를 요청했어요. 확장 프로그램이 켜져 있으면 1분 안에 채워져요.`,
    registered: '지원자로 등록했어요.', cost: `원가중심점을 저장했어요.${Number(fr) ? ` 연락처 ${Number(fr)}건의 가져오기도 요청했어요. 확장 프로그램이 켜져 있으면 1분 안에 채워져요.` : ''}`, ignored: '무시로 처리했어요.', restored: '다시 대기로 돌렸어요.',
    restored2: '다시 대기로 돌렸어요. 이미 등록된 지원자는 지원자 목록에 그대로 있고, 다시 등록해도 중복으로 생기지 않아요.',
    bulkreg: `${Number(n) || 0}명을 지원자로 등록했어요.${Number(skipped) ? ` 연락처가 없는 ${Number(skipped)}건은 건너뛰었어요.` : ''}`,
    bulkign: `${Number(n) || 0}건을 무시로 처리했어요.`
  };
  const ERR = { invalid: '이름과 휴대폰 번호를 확인해 주세요. (예: 010-1234-5678)', gone: '이미 처리되었거나 찾을 수 없는 건이에요.', nopick: '먼저 지원자를 골라 주세요.', cclist: '원가중심점 목록에 없는 이름이에요. 입력하면 나오는 목록에서 골라 주세요.' };
  const notices = [];
  if (FLASH[flash]) notices.push(`<div class="notice ok">${icon('check')}<div>${esc(FLASH[flash])}</div></div>`);
  if (ERR[err]) notices.push(`<div class="notice warn" role="alert">${icon('alert')}<div>${esc(ERR[err])}</div></div>`);

  const needPhone = all_.filter((r) => !r.phone).length;
  const stalledN = idle ? all_.filter((r) => !r.phone && r.fetch_state === 'requested').length : 0;
  const needClass = all_.filter((r) => !r.cost_center).length;
  const ready = all_.filter((r) => r.phone).length;
  const same = {};
  for (const r of all_) if (r.recruit_no) same[r.recruit_no] = (same[r.recruit_no] || 0) + 1;
  const sugg = status === 'done' ? new Map() : await suggestForTitles(db, all_.filter((r) => !r.cost_center && r.recruit_no).map((r) => r.job_title));
  const f = ['phone', 'class', 'ready'].includes(filter) ? filter : '';
  const rows = status === 'done' ? all_ : all_.filter((r) => (f === 'phone' ? !r.phone : f === 'class' ? !r.cost_center : f === 'ready' ? !!r.phone : true));

  const stat = (key, value, label, tone = '') =>
    `<a class="stat ${tone}${f === key ? ' on' : ''}" href="/applicants/inbox${key ? '?f=' + key : ''}"${f === key ? ' aria-current="true"' : ''}><b>${value}</b><span>${label}</span></a>`;

  const contactState = (r) => {
    if (r.phone) return '<span class="badge ok">연락처 있음</span>';
    if (r.fetch_state === 'requested') return idle ? '<span class="badge wait" title="확장 프로그램이 깔린 PC 크롬이 켜지면 채워져요">PC 크롬을 기다려요</span>' : '<span class="badge wait">가져오는 중…</span>';
    if (r.fetch_state === 'failed') return `<span class="badge fail" title="${esc(r.fetch_note)}">가져오기 실패</span>`;
    return '<span class="badge">연락처 없음</span>';
  };
  const classState = (r) => r.cost_center
    ? `<span class="badge info">${esc(r.cost_center)}${r.job ? ' · ' + esc(r.job) : ''}</span>` : '<span class="badge wait">분류 필요</span>';

  const card = (r) => {
    const open = status !== 'done';
    const who = [r.mail_account ? `메일함 ${esc(r.mail_account)}` : '', isSuper && r.owner_name ? `${esc(r.owner_name)} 담당` : ''].filter(Boolean).join(' · ');
    const fetchBtn = !r.phone && r.fetch_state !== 'requested'
      ? `<form method="post" action="/applicants/inbox/${r.id}/fetch" class="inline"><button class="lk">${r.fetch_state === 'failed' ? '다시 가져오기' : '연락처 가져오기'}</button></form>` : '';
    return `<article class="appcard${open && r.phone ? ' ready' : ''}" id="a${r.id}">
      <div class="sel">${open ? `<input type="checkbox" name="ids" value="${r.id}" form="bulkform" class="rowchk" aria-label="${esc(r.name)} 선택">` : ''}</div>
      <div class="body">
        <div class="head"><b class="name">${esc(r.name)}</b><span class="meta">${esc(SUBLINE(r))}</span><span class="when" title="${esc(fmtTime(r.received_at))}">${esc(fmtWhen(r.received_at))}</span></div>
        <div class="post" title="${esc(r.job_title)}"><b>${esc(r.company || '-')}</b> · ${esc(r.job_title)}</div>
        <div class="states">${open ? `${contactState(r)}${classState(r)}` : (STATUS_BADGE[r.status] || '')}${who ? `<span class="badge">${who}</span>` : ''}${r.fetch_state === 'failed' && !r.phone ? `<small class="muted">${esc(r.fetch_note)}</small>` : ''}</div>
        ${open && !r.cost_center && (sugg.get(r.job_title) || []).length ? `<div class="sugg"><span>제안</span>${sugg.get(r.job_title).map((nm) => `<form method="post" action="/applicants/inbox/${r.id}/cost" class="inline"><input type="hidden" name="cost_center" value="${esc(nm)}"><input type="hidden" name="apply_all" value="1"><button class="chipbtn" title="누르면 같은 공고${same[r.recruit_no] > 1 ? ` 대기 ${same[r.recruit_no]}명` : ''}에 한 번에 적용돼요">${esc(nm)}</button></form>`).join('')}<small class="muted">누르면 같은 공고에 한 번에 적용돼요</small></div>` : ''}
        ${open ? `<details class="cl"><summary>${r.cost_center ? '분류 바꾸기' : '원가중심점·직무 정하기'}</summary>
        <form method="post" action="/applicants/inbox/${r.id}/cost" class="classify">
          <label class="fl">원가중심점<input name="cost_center" data-cc-search value="${esc(r.cost_center)}" placeholder="글자를 입력하면 목록이 나와요" maxlength="80" autocomplete="off" aria-label="${esc(r.name)} 원가중심점"></label>
          <label class="fl">직무 (선택)<input name="job" value="${esc(r.job || '')}" placeholder="예: 주차관리" maxlength="100" autocomplete="off" aria-label="${esc(r.name)} 직무"></label>
          <button class="secondary small sv">분류 저장</button>
          ${r.recruit_no ? `<label class="hint"><input type="checkbox" name="apply_all" value="1" checked><span>같은 공고${same[r.recruit_no] > 1 ? ` 대기 ${same[r.recruit_no]}명` : ''}에 모두 적용하고 기억해요</span></label>` : ''}
        </form></details>
        <div class="foot">
          ${r.resume_url ? `<a class="lk" href="${esc(r.resume_url)}" target="_blank" rel="noopener noreferrer">이력서 열기</a>` : ''}
          ${fetchBtn}
          <form method="post" action="/applicants/inbox/${r.id}/ignore" class="inline"><button class="lk quiet">무시</button></form>
          <span class="grow"></span>
          <form method="post" action="/applicants/inbox/${r.id}/register" class="reg">
            <input type="hidden" name="name" value="${esc(r.name)}">
            <input name="phone" type="tel" inputmode="tel" value="${esc(r.phone ? fmtPhone(r.phone) : '')}" placeholder="연락처 010-0000-0000" required aria-label="${esc(r.name)} 연락처">
            <button class="btn small" style="flex:none">등록</button></form>
        </div>`
    : `<div class="foot"><span class="grow"></span>${r.applicant_id ? `<a class="lk" href="/applicants/${r.applicant_id}">지원자 보기</a>` : ''}
          <form method="post" action="/applicants/inbox/${r.id}/restore" class="inline"><button class="lk quiet">다시 대기로</button></form></div>`}
      </div></article>`;
  };

  const switchView = status === 'done'
    ? `<a href="/applicants/inbox">← 대기 중인 지원 ${pending}건 보기</a>`
    : `<a href="/applicants/inbox?status=done">처리된 지원 ${doneCount}건 보기 →</a>`;
  const list = rows.length
    ? `<div class="listbar">${status === 'pending' ? `<label class="selall"><input type="checkbox" id="chkall" aria-label="전체 선택"> 이 화면 ${rows.length}건 전체 선택</label>` : `<b>처리된 지원</b>`}<span>${switchView}</span></div><div class="applist">${rows.map(card).join('')}</div>`
    : emptyState({ title: status === 'done' ? '처리된 건이 없어요' : (f ? '조건에 맞는 건이 없어요' : '새 지원이 없어요'),
      desc: status === 'done' ? '' : (f ? '다른 조건을 눌러 보세요.' : '알바몬 지원 알림이 도착하면 여기에 모여요. 아직 자동 수집을 설정하지 않았다면 오른쪽 위 "연결 설정"에서 한 번만 설정해 주세요.') });

  const dock = status === 'pending' ? `<form id="bulkform" method="post" action="/applicants/inbox/bulk" class="bulkdock" aria-live="polite">
      <b id="selcount">0건 선택</b>
      <button name="op" value="fetch">연락처 가져오기</button>
      <button name="op" value="register">연락처 있는 건 등록</button>
      <button name="op" value="ignore" class="ghost" data-confirm="선택한 건을 무시로 처리할까요?">무시</button></form>` : '';


  return `${pageHeader({ title: '새 지원', desc: '알바몬 지원 알림이 모여요. 연락처를 확인하고 원가중심점을 정한 뒤 지원자로 등록해요.',
    actions: `<a class="conn ${cs.cls}" href="/applicants/inbox/connect" title="${esc(cs.hint)}"><i></i>${esc(cs.text)} · ${esc(cs.hint)}</a>` })}
    ${peopleTabs('inbox', pending, todo)}
    ${notices.join('')}
    ${stalledN && status === 'pending' ? `<div class="notice warn" role="status">${icon('alert')}<div><b>연락처 요청 ${stalledN}건이 기다리고 있어요.</b><br>${esc(stalledText(agent))} <a href="/applicants/inbox/connect">연결 설정 →</a></div></div>` : ''}
    ${todo ? `<div class="notice info">${icon('info')}<div>원가중심점이 정해지지 않은 공고가 <b>${todo}개</b> 있어요. <a href="/applicants/postings"><b>공고 정리에서 한 번에 정하기 →</b></a></div></div>` : ''}
    ${status === 'pending' ? `<div class="stats tight">${stat('', pending, '대기 중')}${stat('phone', needPhone, '연락처 필요', 'wait')}${stat('class', needClass, '분류 필요', 'review')}${stat('ready', ready, '등록할 수 있어요', 'yes')}</div>` : ''}
    ${dock}${list}
    <script>${AUTO_REFRESH_JS}</script>
    <script>${INBOX_JS}</script>`;
}

// 선택한 건 수에 따라 아래쪽 처리 막대를 보여 준다
const INBOX_JS = String.raw`
(function () {
  var dock = document.getElementById('bulkform'), cnt = document.getElementById('selcount'), all = document.getElementById('chkall');
  if (!dock) return;
  function rows() { return [].slice.call(document.querySelectorAll('.rowchk')); }
  function sync() {
    var n = rows().filter(function (c) { return c.checked; }).length;
    dock.classList.toggle('on', n > 0);
    cnt.textContent = n + '건 선택';
    if (all) all.checked = n > 0 && n === rows().length;
  }
  document.addEventListener('change', function (e) {
    if (e.target === all) rows().forEach(function (c) { c.checked = all.checked; });
    if (e.target === all || (e.target.classList && e.target.classList.contains('rowchk'))) sync();
  });
  sync();
})();
`;

// 연결 설정: 자동 수집을 켜는 곳(처음 한 번). 매일 쓰는 화면에서 치웠다.
export async function renderConnect(db, env, { isSuper = false, flash = '', err = '', origin = '', agentToken = '', viewer = null } = {}) {
  const agent = await agentStatus(db, viewer ? viewer.id : null);
  const cs = connState(agent);
  const tokenSet = agent.hasKey;
  const autoOn = isSuper ? await getAutoRegister(db) : false;
  const pending = await pendingInboxCount(db, viewer);
  const todo = await unclassifiedPostings(db).catch(() => 0);
  const FLASH = { auto: '자동 등록 설정을 저장했어요.', addr: '내 수신 주소를 바꿨어요. 메일 전달 규칙을 걸어 두셨다면 새 주소로 바꿔 주세요.', token: '공용 수신 주소를 새로 만들었어요. 메일 전달 설정도 새 주소로 바꿔 주세요.' };
  const ERR = { addr_invalid: '주소 이름은 영문 소문자·숫자·-만 쓸 수 있고 3~30자예요.', addr_taken: '이미 다른 사람이 쓰고 있는 이름이에요. 다른 이름을 써 주세요.' };
  const notices = [];
  if (FLASH[flash]) notices.push(`<div class="notice ok">${icon('check')}<div>${esc(FLASH[flash])}</div></div>`);
  if (ERR[err]) notices.push(`<div class="notice warn" role="alert">${icon('alert')}<div>${esc(ERR[err])}</div></div>`);

  const myName = viewer ? await getUserMailName(db, viewer.id) : '';
  const myAddr = myName ? intakeAddress(myName, env) : '';
  let sharedCard = '';
  if (isSuper) {
    const token = await ensureIntakeToken(db);
    const addr = intakeAddress(token, env);
    sharedCard = `<div class="card"><b>공용 메일 수신 주소</b> <small class="muted">관리자만 보여요</small>
      <div class="stack" style="margin-top:10px">
        <div class="copybox"><div class="copylabel">담당자가 정해지지 않은 건이 들어오는 주소</div><div class="copyvalue">${esc(addr)}</div>
          <button type="button" class="btn secondary small" data-copy="${esc(addr)}">복사</button></div>
        <ol class="muted" style="margin:0;padding-left:20px;font-size:14px">
          <li>Cloudflare 대시보드 → <b>${esc(intakeDomain(env) || '도메인')}</b> → <b>Email → Email Routing</b>을 켜요.</li>
          <li><b>Routing rules → Catch-all address</b>를 켜고 동작을 <b>Send to a Worker</b> → <b>interview-sms</b>로 골라요. (사람마다 바꾸는 주소를 모두 받으려면 catch-all이 필요해요. 알 수 없는 주소는 시스템이 거절해요.)</li>
          <li>알바몬 알림을 받는 메일함에서 <b>이 주소로 자동 전달</b>(전달 규칙)을 걸어요.</li>
        </ol>
        <form method="post" action="/applicants/inbox/token" class="inline" data-confirm="수신 주소를 새로 만들까요? 지금 주소로 오는 메일은 더 이상 받지 않아요.">
          <button class="btn secondary small">공용 주소 다시 만들기</button></form>
        <form method="post" action="/applicants/inbox/auto" class="inline"><input type="hidden" name="on" value="${autoOn ? 0 : 1}">
          <button class="btn secondary small">연락처를 가져오면 바로 지원자로 등록: <b>${autoOn ? '켜짐 (끄기)' : '꺼짐 (켜기)'}</b></button></form>
      </div></div>`;
  }

  const myAddrCard = myAddr ? `<div class="card"><b>메일 자동 전달용 주소</b> <small class="muted">내 메일 주소가 아니에요 · 확장 프로그램을 쓰면 필요 없어요</small>
      <div class="stack" style="margin-top:10px">
        <p class="muted" style="font-size:14px">내 그룹웨어 메일에서 알바몬 메일을 이 주소로 <b>자동 전달</b>하도록 규칙을 걸 때만 써요. 이 주소로 온 알바몬 지원 메일은 <b>내 수신함</b>에 들어와요.</p>
        <div class="copybox"><div class="copylabel">자동 전달할 주소</div><div class="copyvalue">${esc(myAddr)}</div>
          <button type="button" class="btn secondary small" data-copy="${esc(myAddr)}">복사</button></div>
        <form method="post" action="/applicants/inbox/my-address" style="display:grid;gap:8px;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));align-items:end">
          <label style="display:grid;gap:4px"><span style="font-size:13px">주소 이름 바꾸기 <small class="muted">(영문 소문자·숫자·- , 3~30자)</small></span>
            <input name="name" value="${esc(myName)}" maxlength="30" autocomplete="off" pattern="[a-z0-9][a-z0-9\\-]{2,29}" aria-label="주소 이름"></label>
          <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn small">바꾸기</button>
            <button class="btn secondary small" name="random" value="1" formnovalidate>무작위로 다시 만들기</button></div>
        </form>
      </div></div>` : '';

  const keyCard = `<div class="card"><b>연결 키</b> <small class="muted">${tokenSet ? '있음' : '없음'} · 보통은 자동으로 연결돼서 만질 일이 없어요</small>
      <div class="stack" style="margin-top:10px">
        ${agentToken ? `<div class="copybox"><div class="copylabel">내 연결 키 (지금만 보여요)</div><div class="copyvalue">${esc(agentToken)}</div>
          <button type="button" class="btn secondary small" data-copy="${esc(agentToken)}">복사</button></div>` : ''}
        <form method="post" action="/applicants/inbox/agent-token" class="inline" data-confirm="${tokenSet ? '내 연결 키를 새로 만들까요? 이전 키로 연결된 내 확장 프로그램은 멈춰요.' : '내 연결 키를 만들까요?'}"><button class="btn secondary small">${tokenSet ? '연결 키 직접 다시 만들기' : '연결 키 직접 만들기'}</button></form>
      </div></div>`;

  const tool = `<div class="card"><b>예전 방식: 이력서 연락처 가져오기 북마크</b> <small class="muted">확장 프로그램을 쓰지 않을 때만</small>
    <div class="stack" style="margin-top:10px">
      <p class="muted" style="font-size:14px">알바몬 이력서 페이지를 연 상태에서 이 즐겨찾기를 한 번 누르면, 페이지에 보이는 전화번호를 읽어 이 시스템으로 가져와요. 아래 버튼을 <b>브라우저 즐겨찾기 줄로 끌어다 놓으세요</b>.</p>
      <p><a class="btn secondary small" href="${esc(bookmarklet(origin))}" onclick="alert('이 버튼은 즐겨찾기 줄로 끌어다 놓아 쓰는 도구예요. 알바몬 이력서 페이지에서 눌러 주세요.');return false;">${icon('download', 18)}이력서 연락처 가져오기</a></p>
    </div></div>`;

  return `${pageHeader({ title: '연결 설정', desc: '알바몬 지원 메일과 연락처를 자동으로 모으는 설정이에요. 처음 한 번만 하면 돼요.', back: { href: '/applicants/inbox', label: '새 지원' } })}
    ${peopleTabs('connect', pending, todo)}
    ${notices.join('')}
    <div class="hero"><span class="conn ${cs.cls}"><i></i>${esc(cs.text)}</span><span class="muted" style="font-size:14px">${esc(cs.hint)}</span></div>
    <div class="csteps">
      <section class="cstep${agent.lastUsedAt ? ' done' : ''}"><h2>크롬 확장 프로그램 설치</h2>
        <p class="muted" style="font-size:15px">내 PC 크롬이 그룹웨어에서 알바몬 메일을 읽어 오고, 이력서의 연락처를 확인해 줘요. 한 번만 설치하면 돼요.</p>
        <div class="stack">
          <ol class="muted" style="margin:0;padding-left:20px;font-size:14px">
            <li>아래 <b>확장 프로그램 내려받기</b>로 파일을 받고 압축을 풀어요.</li>
            <li>크롬 주소창에 <code>chrome://extensions</code> 입력 → 오른쪽 위 <b>개발자 모드</b> 켜기 → <b>압축해제된 확장 프로그램을 로드합니다</b> → 풀어 둔 <code>albamon-extension</code> 폴더 선택.</li>
            <li>이 화면을 새로고침하면 아래 상태 줄이 <b>"확장 프로그램: 연결됨"</b>으로 바뀌고 연결 키도 자동으로 연결돼요.</li>
          </ol>
          <div><a class="btn small" href="/applicants/inbox/extension.zip" download>${icon('download', 18)}확장 프로그램 내려받기 (v${esc(EXTENSION_VERSION)})</a></div>
          <div id="extstate" class="notice" role="status" data-latest="${esc(EXTENSION_VERSION)}">확장 프로그램 확인 중…</div>
          <div id="extlast" class="notice" role="status" hidden></div>
        </div></section>
      <section class="cstep"><h2>그룹웨어 계정 등록</h2>
        <p class="muted" style="font-size:15px">메일 주소(또는 아이디)와 비밀번호를 넣으면 그 메일함에서 알바몬 지원 메일을 5분마다 가져와요. 비밀번호는 <b>이 PC 크롬의 확장에만</b> 저장되고 시스템(서버)으로는 보내지 않아요. 계정은 <b>최대 5개</b>까지 등록할 수 있어요.</p>
        <div class="stack">
          <ul id="gwlist" style="list-style:none;margin:0;padding:0"></ul>
          <div id="gwprog" class="notice" role="status" hidden>확인하는 중… 그룹웨어에 로그인할 수 있는지 확인하고 있어요. (몇 초 걸려요)</div>
          <div id="gwerr" class="notice warn" role="alert" hidden></div>
          <div id="gwok" class="notice ok" hidden>${icon('check')}<div><b>그룹웨어 로그인을 확인했고</b> 내 확장에 저장했어요. 이제 5분마다 등록한 메일함에서 알바몬 지원 메일을 가져와요.</div></div>
          <label style="display:grid;gap:4px;max-width:360px"><span style="font-size:13px">가져올 양 <small class="muted">(알바몬 지원 메일 기준, 최신 순)</small></span>
            <select id="gwlimit" aria-label="가져올 양"><option value="0">전부 (기본)</option><option value="30">최근 30통</option><option value="100">최근 100통</option><option value="300">최근 300통</option><option value="1000">최근 1000통</option></select>
            <small class="muted">이미 가져온 메일은 다시 가져오지 않아요(중복 제외). 양을 늘리면 다음 확인 때 더 오래된 메일까지 이어서 가져와요.</small></label>
          <form id="gwform" data-nolock autocomplete="off" style="display:grid;gap:8px;grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr));align-items:end">
            <label style="display:grid;gap:4px"><span style="font-size:13px">그룹웨어 메일 주소 (또는 아이디)</span><input id="gwid" autocomplete="off" maxlength="80" placeholder="예: bigbear@willvi.co.kr" aria-label="그룹웨어 메일 주소 또는 아이디"></label>
            <label style="display:grid;gap:4px"><span style="font-size:13px">그룹웨어 비밀번호</span><input id="gwpw" type="password" autocomplete="new-password" maxlength="100" aria-label="그룹웨어 비밀번호"></label>
            <button class="btn small" type="submit">계정 추가·확인</button>
            <label class="check" style="grid-column:1/-1;font-size:13px;min-height:28px;font-weight:400;color:var(--muted)"><input type="checkbox" id="gwshow"> 비밀번호 보기</label>
          </form>
          ${agentToken ? `<span id="newkey" hidden>${esc(agentToken)}</span>` : ''}
          <div class="notice warn" role="note">${icon('alert')}<div><b>계정이 2개 이상이면</b> 5분마다 이 PC 크롬의 그룹웨어 로그인이 계정을 바꿔 가며 잠깐 바뀌었다가 <b>원래대로 돌아와요.</b> 이 크롬에서 그룹웨어를 직접 쓰는 중이면 잠깐 로그아웃된 것처럼 보일 수 있어요. 그룹웨어를 쓰지 않는 크롬(또는 별도 프로필)에서 쓰는 걸 권해요. 또 <b>다른 사람의 아이디·비밀번호를 이 PC에 저장</b>하게 되니, 회사 규정과 본인의 동의를 확인해 주세요.</div></div>
        </div></section>
      <section class="cstep"><h2>알바몬 로그인 유지</h2>
        <p class="muted" style="font-size:15px">같은 크롬에서 <b>알바몬 기업회원으로 로그인</b>해 두세요. 새 지원 화면에서 <b>연락처 가져오기</b>를 누르면 1분 안에 크롬이 이력서를 열어 연락처를 채워 줘요.</p></section>
    </div>
    <details class="advanced"><summary>고급 설정 · 다른 방법</summary>
      ${keyCard}${myAddrCard}${sharedCard}${tool}
    </details>
    <script>${EXT_BRIDGE_JS}</script>
    <script>document.addEventListener('click',function(e){var b=e.target.closest('[data-copy]');if(!b)return;navigator.clipboard.writeText(b.getAttribute('data-copy')).then(function(){var t=b.textContent;b.textContent='복사됐어요 ✓';setTimeout(function(){b.textContent=t;},1800);});});</script>`;
}

// 이력서 페이지에서 가져온 내용을 받아 어느 지원 건인지 고르고 등록하는 화면
export async function renderCostCenters(db, q, isSuper, ok) {
  const total = (await first(db, `SELECT COUNT(*) n FROM cost_centers`)).n;
  const like = '%' + String(q).trim().replace(/[%_]/g, '') + '%';
  const rows = await all(db, `SELECT name FROM cost_centers WHERE name LIKE ? ORDER BY name LIMIT 100`, like);
  const MSG = { ccadd: '목록에 추가했어요. (이미 있는 이름은 건너뛰어요)', ccdel: '목록에서 지웠어요.' };
  return `${pageHeader({ title: '원가중심점 목록', desc: '수신함에서 고를 수 있는 원가중심점이에요. 목록이 있으면 여기 있는 이름만 고를 수 있어요.', back: '/applicants/inbox' })}
    ${MSG[ok] ? `<div class="notice ok">${icon('check')}<div>${esc(MSG[ok])}</div></div>` : ''}
    <form method="get" style="display:flex;gap:8px;margin-bottom:12px"><input name="q" value="${esc(q)}" placeholder="이름으로 찾기 (예: 아마노)" aria-label="원가중심점 찾기" style="flex:1"><button class="btn secondary">찾기</button></form>
    <p class="muted">전체 ${total}개${q ? ` · "${esc(q)}" 검색 결과 ${rows.length}${rows.length === 100 ? '개 이상(앞 100개만 보여요)' : '개'}` : ''}</p>
    ${rows.length ? tableWrap(`<table class="cards sheet"><thead><tr><th scope="col">이름</th>${isSuper ? '<th scope="col">관리</th>' : ''}</tr></thead><tbody>
      ${rows.map((r) => `<tr><td>${esc(r.name)}</td>${isSuper ? `<td class="acts"><form method="post" action="/applicants/inbox/cost-centers/delete" class="inline" data-confirm="${esc(r.name)} 을(를) 목록에서 지울까요?"><input type="hidden" name="name" value="${esc(r.name)}"><button class="small secondary">지우기</button></form></td>` : ''}</tr>`).join('')}
    </tbody></table>`) : emptyState({ title: total ? '찾는 이름이 없어요' : '아직 목록이 없어요', desc: total ? '다른 글자로 찾아 보세요.' : '관리자가 아래에서 엑셀의 원가중심점 열을 복사해 붙여 넣으면 한 번에 등록돼요.' })}
    <form method="post" action="/applicants/inbox/cost-centers/add" class="card stack" style="margin-top:16px">
      <label for="ccnames"><b>목록에 추가하기</b> <span class="muted">한 줄에 하나씩. 엑셀에서 열을 복사해서 붙여 넣어도 돼요. (한 번에 2,000개까지)</span></label>
      <textarea id="ccnames" name="names" rows="8" placeholder="아마노코리아(현장HR)"></textarea>
      <div><button class="btn">추가</button></div></form>
    ${isSuper ? '' : '<p class="muted">이름 삭제는 관리자만 할 수 있어요.</p>'}`;
}

export async function renderCapture(db, viewer = null) {
  const items = await listInbox(db, 'pending', 300, viewer);
  const data = items.map((r) => ({ id: r.id, name: r.name, apply_no: r.apply_no, company: r.company, job: r.job_title }));
  return `${pageHeader({ title: '이력서에서 가져온 연락처', back: { href: '/applicants/inbox', label: '새 지원' } })}
    <div class="card stack" style="max-width:640px" id="capture">
      <p class="muted" id="cap-msg">불러오는 중…</p>
      <form method="post" id="cap-form" class="stack" hidden>
        <label>어느 지원자의 이력서인가요?<select id="cap-item" required></select></label>
        <fieldset><legend>찾은 전화번호</legend><div id="cap-phones" class="stack"></div></fieldset>
        <label>이름 <small>(필요하면 고쳐 주세요)</small><input name="name" id="cap-name" required></label>
        <input type="hidden" name="phone" id="cap-phone">
        <div class="form-actions"><button class="btn">이 사람을 지원자로 등록</button></div>
      </form>
    </div>
    <script type="application/json" id="pending-data">${JSON_IN_SCRIPT(data)}</script>
    <script>${CAPTURE_JS}</script>`;
}

const CAPTURE_JS = String.raw`
(function () {
  var items = JSON.parse(document.getElementById('pending-data').textContent);
  var msg = document.getElementById('cap-msg'), form = document.getElementById('cap-form');
  var raw = '';
  try { raw = decodeURIComponent((location.hash || '').slice(1)); } catch (e) { raw = ''; }
  var d = null;
  try { d = JSON.parse(raw); } catch (e) { d = null; }
  // 주소에서 개인정보가 남지 않도록 조각을 바로 지운다
  history.replaceState(null, '', location.pathname);
  if (!d) { msg.textContent = '이력서 페이지에서 "이력서 연락처 가져오기" 즐겨찾기를 눌러 이 화면을 열어 주세요.'; return; }
  if (!items.length) { msg.textContent = '대기 중인 지원이 없어요. 새 지원 화면을 확인해 주세요.'; return; }
  var text = String(d.t || ''), url = String(d.u || '');
  var phones = (d.p || []).filter(function (p) { return /^01[016789]\d{7,8}$/.test(p); });
  // 후보: 주소에 지원 번호가 있거나, 페이지 글에 이름이 나오는 사람
  var cands = items.filter(function (it) {
    return (it.apply_no && url.indexOf(it.apply_no) >= 0) || (it.name && text.indexOf(it.name) >= 0);
  });
  var list = cands.length ? cands : items;
  var sel = document.getElementById('cap-item'), nameEl = document.getElementById('cap-name');
  list.forEach(function (it) {
    var o = document.createElement('option');
    o.value = String(it.id);
    o.textContent = it.name + ' — ' + (it.company || '') + ' ' + (it.job || '');
    sel.appendChild(o);
  });
  function sync() {
    var it = items.filter(function (x) { return String(x.id) === sel.value; })[0];
    if (it) nameEl.value = it.name;
    form.action = '/applicants/inbox/' + sel.value + '/register';
  }
  sel.addEventListener('change', sync); sync();
  var box = document.getElementById('cap-phones'), hidden = document.getElementById('cap-phone');
  function addRadio(value, label, checked) {
    var l = document.createElement('label'); l.className = 'check';
    var i = document.createElement('input'); i.type = 'radio'; i.name = 'pick'; i.value = value; i.checked = !!checked;
    i.addEventListener('change', function () { hidden.value = value; });
    var s = document.createElement('span'); s.textContent = label;
    l.appendChild(i); l.appendChild(s); box.appendChild(l);
    if (checked) hidden.value = value;
  }
  phones.forEach(function (p, idx) {
    addRadio(p, p.replace(/^(\d{3})(\d{3,4})(\d{4})$/, '$1-$2-$3'), idx === 0);
  });
  if (!phones.length) {
    var note = document.createElement('p'); note.className = 'muted';
    note.textContent = '이 페이지에서 전화번호를 찾지 못했어요. 연락처가 보이지 않는 페이지일 수 있어요. 아래에 직접 적어 주세요.';
    box.appendChild(note);
    var m = document.createElement('input'); m.type = 'tel'; m.placeholder = '010-0000-0000'; m.setAttribute('aria-label', '연락처');
    m.addEventListener('input', function () { hidden.value = m.value; });
    box.appendChild(m);
  }
  msg.textContent = (cands.length ? '이력서 내용과 맞는 지원자를 골라 두었어요. ' : '어느 지원자인지 직접 골라 주세요. ') + '맞는지 확인하고 등록해 주세요.';
  form.hidden = false;
})();
`;

// 라우팅. 해당하지 않으면 null.
// deps: { saveApplicant, addEvent, safeBack, withParam }
export async function handleInbox(c, deps) {
  const { url, path, method, db, user, env, readForm, html, redirect, pg, audit, request } = c;
  if (!path.startsWith('/applicants/inbox')) return null;
  const page = (title, body, status = 200) => html(pg(title, body, 'applicants'), status);
  const viewer = { id: user.id, isSuper: user.role === 'super' };

  if (path === '/applicants/inbox' && method === 'GET') {
    const sp = url.searchParams;
    return page('새 지원', await renderInbox(db, env, {
      status: sp.get('status') === 'done' ? 'done' : 'pending', isSuper: user.role === 'super', viewer, filter: sp.get('f') || '',
      flash: sp.get('ok') || '', err: sp.get('err') || '', origin: new URL(request.url).origin, fetched: sp.get('n') || 0, n: sp.get('n') || 0, skipped: sp.get('s') || 0, fr: sp.get('fr') || 0
    }));
  }
  if (path === '/applicants/inbox/connect' && method === 'GET') {
    const sp = url.searchParams;
    return page('연결 설정', await renderConnect(db, env, { isSuper: viewer.isSuper, viewer, flash: sp.get('ok') || '', err: sp.get('err') || '', origin: new URL(request.url).origin }));
  }
  if (path === '/applicants/inbox/extension.zip' && method === 'GET') {
    const zip = makeZip(Object.fromEntries(Object.entries(EXTENSION_FILES).map(([n, b]) => ['albamon-extension/' + n, b])));
    return new Response(zip, { headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="albamon-extension-${EXTENSION_VERSION}.zip"`,
      'cache-control': 'no-store'
    } });
  }
  if (path === '/applicants/inbox/cost-centers/search' && method === 'GET') {
    const terms = String(url.searchParams.get('q') || '').trim().split(/\s+/).filter(Boolean).slice(0, 5).map((t) => '%' + t.replace(/[%_]/g, '') + '%');
    const where = terms.length ? terms.map(() => 'name LIKE ?').join(' AND ') : '1=1';
    const rows = await all(db, `SELECT name FROM cost_centers WHERE ${where} ORDER BY name LIMIT 30`, ...terms);
    return new Response(JSON.stringify({ items: rows.map((r) => r.name) }), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
  }
  if (path === '/applicants/inbox/cost-centers' && method === 'GET') {
    return page('원가중심점 목록', await renderCostCenters(db, url.searchParams.get('q') || '', user.role === 'super', url.searchParams.get('ok') || ''));
  }
  if (path === '/applicants/inbox/cost-centers/add' && method === 'POST') {
    const f = await readForm(request);
    const names = [...new Set(String(f.names || '').split(/\r?\n/).map((x) => x.trim().slice(0, 80)).filter(Boolean))].slice(0, 2000);
    const now = Date.now();
    for (let i = 0; i < names.length; i += 50) {
      await db.batch(names.slice(i, i + 50).map((n) => db.prepare(`INSERT OR IGNORE INTO cost_centers (name, created_by, created_at) VALUES (?,?,?)`).bind(n, user.id, now)));
    }
    await audit(db, user, 'applicant.cost_center_add', `n=${names.length}`);
    return redirect('/applicants/inbox/cost-centers?ok=ccadd');
  }
  if (path === '/applicants/inbox/cost-centers/delete' && method === 'POST') {
    if (user.role !== 'super') return html(pg('접근 불가', '<p>관리자만 할 수 있어요.</p>', 'applicants'), 403);
    const f = await readForm(request);
    await run(db, `DELETE FROM cost_centers WHERE name=?`, String(f.name || ''));
    await audit(db, user, 'applicant.cost_center_del', '');
    return redirect('/applicants/inbox/cost-centers?ok=ccdel');
  }
  if (path === '/applicants/inbox/capture' && method === 'GET') {
    return page('이력서에서 가져온 연락처', await renderCapture(db, viewer));
  }
  if (path === '/applicants/inbox/my-address' && method === 'POST') {
    const f = await readForm(request);
    const r = await setUserMailName(db, user.id, f.random === '1' ? '' : f.name);
    if (!r.ok) return redirect(`/applicants/inbox/connect?err=addr_${r.error}`);
    await audit(db, user, 'applicant.inbox_my_address', '');
    return redirect('/applicants/inbox/connect?ok=addr');
  }
  if (path === '/applicants/inbox/token' && method === 'POST') {
    if (user.role !== 'super') return html(pg('접근 불가', '<p>관리자만 할 수 있어요.</p>', 'applicants'), 403);
    await ensureIntakeToken(db, { rotate: true });
    await audit(db, user, 'applicant.inbox_token', '');
    return redirect('/applicants/inbox/connect?ok=token');
  }

  if (path === '/applicants/inbox/bulk' && method === 'POST') {
    const sp = new URLSearchParams(await request.text());
    const ids = [...new Set(sp.getAll('ids').map((x) => parseInt(x, 10)).filter((x) => Number.isInteger(x) && x > 0))].slice(0, 200);
    if (!ids.length) return redirect('/applicants/inbox?err=nopick');
    const op = sp.get('op');
    const ph = ids.map(() => '?').join(',');
    const sc = inboxScope(viewer);
    const rows = await all(db, `SELECT * FROM applicant_inbox WHERE id IN (${ph}) AND status='pending' AND ${sc.sql}`, ...ids, ...sc.args);
    const now = Date.now();
    if (op === 'fetch') {
      const n = await requestFetch(db, rows.map((r) => r.id), viewer);
      await audit(db, user, 'applicant.inbox_fetch_bulk', `n=${n}`);
      return redirect(`/applicants/inbox?ok=fetchall&n=${n}`);
    }
    if (op === 'ignore') {
      for (const r of rows) await run(db, `UPDATE applicant_inbox SET status='ignored', handled_by=?, handled_at=? WHERE id=? AND status='pending'`, user.id, now, r.id);
      await audit(db, user, 'applicant.inbox_ignore_bulk', `n=${rows.length}`);
      return redirect(`/applicants/inbox?ok=bulkign&n=${rows.length}`);
    }
    if (op === 'register') {
      let done = 0, skip = 0;
      for (const r of rows) {
        if (!r.phone || !isValidMobile(r.phone)) { skip++; continue; }
        const x = await deps.saveApplicant(db, { name: r.name, phone: r.phone, applied_to: r.cost_center, job: r.job, recruit_no: r.recruit_no, posting_title: r.job_title, company_raw: r.company }, user.id, 'mail');
        if (!x.ok) { skip++; continue; }
        await run(db, `UPDATE applicant_inbox SET status='registered', applicant_id=?, handled_by=?, handled_at=? WHERE id=?`, x.id, user.id, now, r.id);
        await deps.addEvent(db, x.id, 'apply', `${r.source === 'albamon' ? '알바몬' : '메일'} 지원 메일에서 등록(일괄)`, user.id, now);
        done++;
      }
      await audit(db, user, 'applicant.inbox_register_bulk', `n=${done}`);
      return redirect(`/applicants/inbox?ok=bulkreg&n=${done}&s=${skip + (ids.length - rows.length)}`);
    }
    return redirect('/applicants/inbox');
  }

  if (path === '/applicants/inbox/fetch-all' && method === 'POST') {
    const n = await requestFetch(db, null, viewer);
    await audit(db, user, 'applicant.inbox_fetch_all', `n=${n}`);
    return redirect(`/applicants/inbox?ok=fetchall&n=${n}`);
  }
  if (path === '/applicants/inbox/auto' && method === 'POST') {
    if (user.role !== 'super') return html(pg('접근 불가', '<p>관리자만 할 수 있어요.</p>', 'applicants'), 403);
    const f = await readForm(request);
    await setAutoRegister(db, f.on === '1');
    await audit(db, user, 'applicant.inbox_auto', `on=${f.on === '1' ? 1 : 0}`);
    return redirect('/applicants/inbox/connect?ok=auto');
  }
  if (path === '/applicants/inbox/agent-token.json' && method === 'POST') {
    // 화면이 확장에 연결 키를 자동으로 넣어 줄 때 쓰는 경로(내 키를 새로 만든다)
    const token = await createAgentToken(db, user.id);
    await audit(db, user, 'applicant.agent_token', 'auto');
    return new Response(JSON.stringify({ token }), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
  }
  if (path === '/applicants/inbox/agent-token' && method === 'POST') {
    const token = await createAgentToken(db, user.id);
    await audit(db, user, 'applicant.agent_token', '');
    return page('연결 설정', await renderConnect(db, env, { isSuper: viewer.isSuper, viewer, origin: new URL(request.url).origin, agentToken: token }));
  }

  const m = path.match(/^\/applicants\/inbox\/(\d+)\/(register|ignore|restore|fetch|cost)$/);
  if (!m || method !== 'POST') return null;
  const id = Number(m[1]);
  const action = m[2];
  const item = await first(db, `SELECT * FROM applicant_inbox WHERE id=?`, id);
  if (!item || (!viewer.isSuper && item.owner_user_id != null && item.owner_user_id !== user.id)) return redirect('/applicants/inbox?err=gone');
  if (action === 'fetch') {
    await requestFetch(db, [id], viewer);
    await audit(db, user, 'applicant.inbox_fetch', `inbox=${id}`);
    return redirect('/applicants/inbox?ok=fetch');
  }
  const f = await readForm(request);
  const now = Date.now();

  if (action === 'cost') {
    const cc = String(f.cost_center || '').trim().slice(0, 80);
    const jb = String(f.job || '').trim().slice(0, 100);
    if (cc && (await first(db, `SELECT COUNT(*) n FROM cost_centers`)).n && !(await first(db, `SELECT 1 x FROM cost_centers WHERE name=?`, cc))) return redirect('/applicants/inbox?err=cclist');
    if (f.apply_all === '1' && item.recruit_no) {
      if (cc) await run(db, `INSERT INTO inbox_cost_rules (recruit_no, cost_center, job, updated_by, updated_at) VALUES (?,?,?,?,?) ON CONFLICT(recruit_no) DO UPDATE SET cost_center=excluded.cost_center, job=excluded.job, updated_by=excluded.updated_by, updated_at=excluded.updated_at`, item.recruit_no, cc, jb, user.id, now);
      else await run(db, `DELETE FROM inbox_cost_rules WHERE recruit_no=?`, item.recruit_no);
      await run(db, `UPDATE applicant_inbox SET cost_center=?, job=? WHERE recruit_no=? AND status='pending'`, cc, jb, item.recruit_no);
    } else {
      await run(db, `UPDATE applicant_inbox SET cost_center=?, job=? WHERE id=?`, cc, jb, id);
    }
    // 분류가 끝났으니 연락처 가져오기도 이어서 요청한다(원가중심점을 비운 경우는 제외)
    let fr = 0;
    if (cc) fr = f.apply_all === '1' && item.recruit_no ? await requestFetchByPosting(db, item.recruit_no) : await requestFetch(db, [id], viewer);
    await audit(db, user, 'applicant.inbox_cost', `inbox=${id} all=${f.apply_all === '1' ? 1 : 0} fetch=${fr}`);
    return redirect(`/applicants/inbox?ok=cost${fr ? `&fr=${fr}` : ''}`);
  }
  if (action === 'register') {
    if (item.status !== 'pending') return redirect('/applicants/inbox?err=gone');
    const phone = normalizePhone(f.phone);
    const name = String(f.name || item.name).trim().slice(0, 50);
    if (!name || !isValidMobile(phone)) return redirect('/applicants/inbox?err=invalid');
    const r = await deps.saveApplicant(db, { name, phone, applied_to: item.cost_center, job: item.job, recruit_no: item.recruit_no, posting_title: item.job_title, company_raw: item.company }, user.id, 'mail');
    if (!r.ok) return redirect('/applicants/inbox?err=invalid');
    await run(db, `UPDATE applicant_inbox SET status='registered', applicant_id=?, handled_by=?, handled_at=? WHERE id=?`, r.id, user.id, now, id);
    await deps.addEvent(db, r.id, 'apply', `${item.source === 'albamon' ? '알바몬' : '메일'} 지원 메일에서 등록`, user.id, now);
    await audit(db, user, 'applicant.inbox_register', `inbox=${id} id=${r.id}`);
    return redirect('/applicants/inbox?ok=registered');
  }
  if (action === 'ignore') {
    await run(db, `UPDATE applicant_inbox SET status='ignored', handled_by=?, handled_at=? WHERE id=? AND status='pending'`, user.id, now, id);
    await audit(db, user, 'applicant.inbox_ignore', `inbox=${id}`);
    return redirect('/applicants/inbox?ok=ignored');
  }
  // restore: 무시한 건·등록한 건 모두 다시 대기로 돌린다. 이미 등록된 지원자는 그대로 두고, 다시 등록해도 같은 번호·같은 공고는 중복으로 만들지 않는다.
  if (item.status === 'ignored' || item.status === 'registered') {
    await run(db, `UPDATE applicant_inbox SET status='pending', applicant_id=NULL, handled_by=NULL, handled_at=NULL WHERE id=?`, id);
    await audit(db, user, 'applicant.inbox_restore', `inbox=${id}`);
    return redirect(item.status === 'registered' ? '/applicants/inbox?ok=restored2' : '/applicants/inbox?ok=restored');
  }
  return redirect('/applicants/inbox?ok=restored');
}
