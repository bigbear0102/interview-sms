// 메일 수신함: 알바몬 지원 알림 메일이 모이는 곳. 담당자가 이력서를 열어 연락처를 확인해 지원자로 등록한다.
import { first, run } from './d1.js';
import { makeZip } from './zip.js';
import { EXTENSION_FILES, EXTENSION_VERSION } from './extension-bundle.js';
import { esc, icon, fmtTime } from './views.js';
import { fmtPhone, pageHeader, tableWrap, emptyState } from './ui.js';
import { normalizePhone, isValidMobile } from './parser.js';
import {
  ensureIntakeToken, intakeAddress, intakeDomain, listInbox, pendingInboxCount,
  requestFetch, createAgentToken, hasAgentToken, getAutoRegister, setAutoRegister
} from './mail-intake.js';

// 지원자 관리 화면 위쪽 분류 탭
export function peopleTabs(active, pending = 0) {
  const t = (key, href, label, badge = '') =>
    `<a href="${href}"${active === key ? ' aria-current="page"' : ''}>${label}${badge}</a>`;
  return `<div class="tabs">${t('list', '/applicants', '지원자 목록')}${
    t('inbox', '/applicants/inbox', '메일 수신함', pending ? ` <span class="n">${pending}</span>` : '')}${
    t('history', '/people', '면접 안내 이력')}</div>`;
}

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

export async function renderInbox(db, env, { status = 'pending', isSuper = false, flash = '', err = '', origin = '', agentToken = '', fetched = 0 } = {}) {
  const pending = await pendingInboxCount(db);
  const rows = await listInbox(db, status === 'done' ? 'done' : 'pending');
  const doneCount = (await first(db, `SELECT COUNT(*) n FROM applicant_inbox WHERE status != 'pending'`)).n;
  const notices = [];
  const FLASH = { fetch: '연락처 가져오기를 요청했어요. 에이전트가 켜져 있으면 곧 채워져요.', fetchall: `대기 중인 ${Number(fetched) || 0}건의 연락처 가져오기를 요청했어요.`, auto: '자동 등록 설정을 저장했어요.', registered: '지원자로 등록했어요.', ignored: '무시로 처리했어요.', restored: '다시 대기로 돌렸어요.', token: '수신 주소를 새로 만들었어요. 메일 전달 설정도 새 주소로 바꿔 주세요.' };
  const ERR = { invalid: '이름과 휴대폰 번호를 확인해 주세요. (예: 010-1234-5678)', gone: '이미 처리되었거나 찾을 수 없는 건이에요.' };
  if (FLASH[flash]) notices.push(`<div class="notice ok">${icon('check')}<div>${esc(FLASH[flash])}</div></div>`);
  if (ERR[err]) notices.push(`<div class="notice warn" role="alert">${icon('alert')}<div>${esc(ERR[err])}</div></div>`);

  let addressCard = '';
  if (isSuper) {
    const token = await ensureIntakeToken(db);
    const addr = intakeAddress(token, env);
    addressCard = `<details class="card" style="margin-bottom:16px"><summary><b>메일 수신 주소·설정 방법</b> <span class="muted">관리자만 보여요</span></summary>
      <div style="margin-top:12px" class="stack">
        <div class="copybox"><div class="copylabel">알바몬 알림 메일을 이 주소로 전달해 주세요</div><div class="copyvalue">${esc(addr)}</div>
          <button type="button" class="btn secondary small" data-copy="${esc(addr)}">복사</button></div>
        <ol class="muted" style="margin:0;padding-left:20px;font-size:14px">
          <li>Cloudflare 대시보드 → <b>${esc(intakeDomain(env) || '도메인')}</b> → <b>Email → Email Routing</b>을 켜요.</li>
          <li><b>Routing rules → Create address</b>로 위 주소를 만들고, 동작을 <b>Send to a Worker</b> → <b>interview-sms</b>로 골라요.</li>
          <li>알바몬 알림을 받는 메일함에서 <b>이 주소로 자동 전달</b>(전달 규칙)을 걸어요. 알바몬에서 받는 메일 주소를 이 주소로 직접 바꿔도 돼요.</li>
          <li>알바몬에서 시험 지원을 하나 받아 보면 아래 대기 목록에 나타나요.</li>
        </ol>
        <form method="post" action="/applicants/inbox/token" class="inline" data-confirm="수신 주소를 새로 만들까요? 지금 주소로 오는 메일은 더 이상 받지 않아요.">
          <button class="btn secondary small">주소 다시 만들기</button></form>
      </div></details>`;
  }

  const tokenSet = isSuper ? await hasAgentToken(db) : false;
  const autoOn = isSuper ? await getAutoRegister(db) : false;
  const agentCard = isSuper ? `<details class="card" style="margin-bottom:16px"${agentToken ? ' open' : ''}><summary><b>연락처 자동 가져오기 에이전트</b> <span class="muted">${tokenSet ? '연결 키 있음' : '연결 키 없음'} · 담당자 PC에서 알바몬에 로그인해 연락처를 읽어 와요</span></summary>
    <div style="margin-top:12px" class="stack">
      <p class="muted" style="font-size:14px">알바몬 이력서의 연락처는 <b>"클릭해야 보여요"</b>. 그래서 담당자 PC의 크롬(이미 알바몬에 로그인된 상태)이 연락처 보기를 눌러 읽어 와요.
        <b>알바몬 아이디·비밀번호는 이 시스템이 받지도 저장하지도 않아요.</b> 여기서 <b>"연락처 가져오기"를 누른 건만</b> 처리해요.</p>
      <div class="notice warn" role="note">${icon('alert')}<div>알바몬은 연락처를 열람할 때 <b>이용권이 차감될 수 있어요</b>. 에이전트는 차감·결제 확인 창이 보이면 누르지 않고 멈춰요. 처음에는 한두 건으로 확인해 보세요.</div></div>
      ${agentToken ? `<div class="copybox"><div class="copylabel">에이전트 연결 키 (지금만 보여요. 에이전트 설정에 붙여넣으세요)</div><div class="copyvalue">${esc(agentToken)}</div>
        <button type="button" class="btn secondary small" data-copy="${esc(agentToken)}">복사</button></div>` : ''}
      <ol class="muted" style="margin:0;padding-left:20px;font-size:14px">
        <li>아래 <b>확장 프로그램 내려받기</b>를 눌러 파일을 받고, 압축을 풀어요.</li>
        <li>크롬 주소창에 <code>chrome://extensions</code> 를 입력 → 오른쪽 위 <b>개발자 모드</b> 켜기 → <b>압축해제된 확장 프로그램을 로드합니다</b> → 풀어 둔 <code>albamon-extension</code> 폴더 선택. (한 번만 하면 돼요)</li>
        <li>그 크롬에서 <b>알바몬 기업회원으로 로그인</b>해 두고, 확장 아이콘에 위의 <b>연결 키</b>를 한 번 넣어요.</li>
        <li>수신함에서 <b>연락처 가져오기</b>를 누르면 1분 안에 크롬이 알아서 연락처를 채워 줘요. 채워진 뒤 <b>등록</b>만 누르면 돼요.</li>
      </ol>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <a class="btn small" href="/applicants/inbox/extension.zip" download>확장 프로그램 내려받기 (v${esc(EXTENSION_VERSION)})</a>
        <form method="post" action="/applicants/inbox/agent-token" class="inline" data-confirm="${tokenSet ? '연결 키를 새로 만들까요? 이전 키로 실행 중인 에이전트는 멈춰요.' : '에이전트 연결 키를 만들까요?'}"><button class="btn secondary small">${tokenSet ? '연결 키 다시 만들기' : '연결 키 만들기'}</button></form>
        <form method="post" action="/applicants/inbox/auto" class="inline"><input type="hidden" name="on" value="${autoOn ? 0 : 1}">
          <button class="btn secondary small">연락처를 가져오면 바로 지원자로 등록: <b>${autoOn ? '켜짐 (끄기)' : '꺼짐 (켜기)'}</b></button></form>
      </div>
    </div></details>` : '';

  const tool = `<details class="card" style="margin-bottom:16px"><summary><b>이력서에서 연락처 가져오기 도구</b> <span class="muted">처음 한 번만 설치해요</span></summary>
    <div style="margin-top:12px" class="stack">
      <p class="muted" style="font-size:14px">알바몬 메일에는 연락처가 없어서, 이력서 페이지에서 확인해야 해요. 아래 버튼을 <b>브라우저 즐겨찾기 줄로 끌어다 놓으세요</b>.
        그 뒤 알바몬 이력서 페이지를 연 상태에서 이 즐겨찾기를 한 번 누르면, 페이지에 보이는 전화번호를 읽어 이 화면으로 가져와요.
        (담당자 본인이 로그인한 화면의 글만 읽고, 아이디와 비밀번호는 다루지 않아요.)</p>
      <p><a class="btn" href="${esc(bookmarklet(origin))}" onclick="alert('이 버튼은 즐겨찾기 줄로 끌어다 놓아 쓰는 도구예요. 알바몬 이력서 페이지에서 눌러 주세요.');return false;">${icon('download', 18)}이력서 연락처 가져오기</a></p>
    </div></details>`;

  const fetchUi = (r) => {
    if (r.phone) return '<span class="badge ok">연락처 채워짐</span>';
    if (r.fetch_state === 'requested') return '<span class="badge wait">에이전트 처리 대기</span>';
    const note = r.fetch_state === 'failed'
      ? `<span class="badge fail" title="${esc(r.fetch_note)}">가져오기 실패</span> <small class="muted">${esc(r.fetch_note)}</small>` : '';
    return `${note}<form method="post" action="/applicants/inbox/${r.id}/fetch" class="inline"><button class="small secondary">${r.fetch_state === 'failed' ? '다시 요청' : '연락처 가져오기'}</button></form>`;
  };

  const table = rows.length ? tableWrap(`<table class="cards sheet"><thead><tr><th>지원자</th><th>공고</th><th>정보</th><th>받은 시각</th><th>처리</th></tr></thead><tbody>
    ${rows.map((r) => `<tr>
      <td><b>${esc(r.name)}</b>${r.gender || r.age ? ` <small class="muted">${esc([r.gender, r.age ? r.age + '세' : ''].filter(Boolean).join(', '))}</small>` : ''}</td>
      <td data-label="공고">${esc(r.company || '-')}<br><small class="muted">${esc(r.job_title)}</small></td>
      <td data-label="정보"><small>${esc([r.address, r.education, r.career].filter(Boolean).join(' · ') || '-')}</small></td>
      <td data-label="받은 시각" class="nowrap">${esc(fmtTime(r.received_at))}</td>
      <td data-label="처리" class="acts">${r.status === 'pending'
    ? `<div style="display:grid;gap:8px;min-width:240px">
          ${r.resume_url ? `<a class="btn secondary small" href="${esc(r.resume_url)}" target="_blank" rel="noopener noreferrer">${icon('clipboard', 16)}이력서 열기</a>` : ''}
          <div>${fetchUi(r)}</div>
          <form method="post" action="/applicants/inbox/${r.id}/register" style="display:flex;gap:6px">
            <input type="hidden" name="name" value="${esc(r.name)}">
            <input name="phone" type="tel" inputmode="tel" value="${esc(r.phone ? fmtPhone(r.phone) : '')}" placeholder="연락처 010-0000-0000" required aria-label="${esc(r.name)} 연락처">
            <button class="btn small" style="flex:none">등록</button></form>
          <form method="post" action="/applicants/inbox/${r.id}/ignore" class="inline"><button class="small secondary">무시</button></form>
        </div>`
    : `${STATUS_BADGE[r.status] || ''}${r.applicant_id ? ` <a href="/applicants/${r.applicant_id}">지원자 보기</a>` : ''}
        <form method="post" action="/applicants/inbox/${r.id}/restore" class="inline"><button class="small secondary">다시 대기로</button></form>`}</td>
      </tr>`).join('')}
    </tbody></table>`)
    : emptyState({ title: status === 'done' ? '처리된 건이 없어요' : '대기 중인 지원 메일이 없어요',
      desc: '알바몬 지원 알림 메일이 도착하면 여기에 모여요. 메일 전달 설정은 위 "메일 수신 주소·설정 방법"을 보세요.' });

  const filterTab = (key, label, n) =>
    `<a href="/applicants/inbox${key === 'done' ? '?status=done' : ''}"${status === key ? ' aria-current="page"' : ''}>${label} <span class="n">${n}</span></a>`;

  return `${pageHeader({ title: '지원자 관리', desc: '알바몬 지원 알림 메일을 모아서, 이력서를 확인하고 지원자로 등록해요.' })}
    ${peopleTabs('inbox', pending)}
    ${notices.join('')}
    ${addressCard}${agentCard}${tool}
    <div class="tabs">${filterTab('pending', '대기', pending)}${filterTab('done', '처리됨', doneCount)}</div>
    ${status === 'pending' && pending ? `<form method="post" action="/applicants/inbox/fetch-all" class="inline" style="margin-bottom:12px" data-confirm="대기 중인 ${pending}건의 연락처를 한꺼번에 가져오도록 요청할까요? 알바몬 이용권이 차감될 수 있어요."><button class="btn secondary small">대기 ${pending}건 모두 연락처 가져오기 요청</button></form>` : ''}
    <div class="card" style="padding:0">${table}</div>
    <script>document.addEventListener('click',function(e){var b=e.target.closest('[data-copy]');if(!b)return;navigator.clipboard.writeText(b.getAttribute('data-copy')).then(function(){var t=b.textContent;b.textContent='복사됐어요 ✓';setTimeout(function(){b.textContent=t;},1800);});});</script>`;
}

// 이력서 페이지에서 가져온 내용을 받아 어느 지원 건인지 고르고 등록하는 화면
export async function renderCapture(db) {
  const items = await listInbox(db, 'pending', 300);
  const data = items.map((r) => ({ id: r.id, name: r.name, apply_no: r.apply_no, company: r.company, job: r.job_title }));
  return `${pageHeader({ title: '이력서에서 가져온 연락처', back: { href: '/applicants/inbox', label: '메일 수신함' } })}
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
  if (!items.length) { msg.textContent = '대기 중인 지원 메일이 없어요. 메일 수신함을 확인해 주세요.'; return; }
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

  if (path === '/applicants/inbox' && method === 'GET') {
    const sp = url.searchParams;
    return page('메일 수신함', await renderInbox(db, env, {
      status: sp.get('status') === 'done' ? 'done' : 'pending', isSuper: user.role === 'super',
      flash: sp.get('ok') || '', err: sp.get('err') || '', origin: new URL(request.url).origin, fetched: sp.get('n') || 0
    }));
  }
  if (path === '/applicants/inbox/extension.zip' && method === 'GET') {
    const zip = makeZip(Object.fromEntries(Object.entries(EXTENSION_FILES).map(([n, b]) => ['albamon-extension/' + n, b])));
    return new Response(zip, { headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="albamon-extension-${EXTENSION_VERSION}.zip"`,
      'cache-control': 'no-store'
    } });
  }
  if (path === '/applicants/inbox/capture' && method === 'GET') {
    return page('이력서에서 가져온 연락처', await renderCapture(db));
  }
  if (path === '/applicants/inbox/token' && method === 'POST') {
    if (user.role !== 'super') return html(pg('접근 불가', '<p>관리자만 할 수 있어요.</p>', 'applicants'), 403);
    await ensureIntakeToken(db, { rotate: true });
    await audit(db, user, 'applicant.inbox_token', '');
    return redirect('/applicants/inbox?ok=token');
  }

  if (path === '/applicants/inbox/fetch-all' && method === 'POST') {
    const n = await requestFetch(db, null);
    await audit(db, user, 'applicant.inbox_fetch_all', `n=${n}`);
    return redirect(`/applicants/inbox?ok=fetchall&n=${n}`);
  }
  if (path === '/applicants/inbox/auto' && method === 'POST') {
    if (user.role !== 'super') return html(pg('접근 불가', '<p>관리자만 할 수 있어요.</p>', 'applicants'), 403);
    const f = await readForm(request);
    await setAutoRegister(db, f.on === '1');
    await audit(db, user, 'applicant.inbox_auto', `on=${f.on === '1' ? 1 : 0}`);
    return redirect('/applicants/inbox?ok=auto');
  }
  if (path === '/applicants/inbox/agent-token' && method === 'POST') {
    if (user.role !== 'super') return html(pg('접근 불가', '<p>관리자만 할 수 있어요.</p>', 'applicants'), 403);
    const token = await createAgentToken(db);
    await audit(db, user, 'applicant.agent_token', '');
    return page('메일 수신함', await renderInbox(db, env, { isSuper: true, origin: new URL(request.url).origin, agentToken: token }));
  }

  const m = path.match(/^\/applicants\/inbox\/(\d+)\/(register|ignore|restore|fetch)$/);
  if (!m || method !== 'POST') return null;
  const id = Number(m[1]);
  const action = m[2];
  const item = await first(db, `SELECT * FROM applicant_inbox WHERE id=?`, id);
  if (!item) return redirect('/applicants/inbox?err=gone');
  if (action === 'fetch') {
    await requestFetch(db, [id]);
    await audit(db, user, 'applicant.inbox_fetch', `inbox=${id}`);
    return redirect('/applicants/inbox?ok=fetch');
  }
  const f = await readForm(request);
  const now = Date.now();

  if (action === 'register') {
    if (item.status !== 'pending') return redirect('/applicants/inbox?err=gone');
    const phone = normalizePhone(f.phone);
    const name = String(f.name || item.name).trim().slice(0, 50);
    if (!name || !isValidMobile(phone)) return redirect('/applicants/inbox?err=invalid');
    const r = await deps.saveApplicant(db, { name, phone, applied_to: item.company, job: item.job_title }, user.id, 'mail');
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
  // restore: 무시한 건만 다시 대기로 (이미 지원자로 등록한 건은 되돌리지 않는다)
  if (item.status === 'ignored') {
    await run(db, `UPDATE applicant_inbox SET status='pending', handled_by=NULL, handled_at=NULL WHERE id=?`, id);
  }
  return redirect('/applicants/inbox?ok=restored');
}
