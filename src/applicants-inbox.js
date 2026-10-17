// 새 지원(메일 수신함): 알바몬 지원 알림 메일이 모이는 곳. 담당자가 이력서를 열어 연락처를 확인해 지원자로 등록한다.
import { first, run, all, stmt, chunks } from './d1.js';
import { makeZip } from './zip.js';
import { EXTENSION_FILES, EXTENSION_VERSION } from './extension-bundle.js';
import { EXT_BRIDGE_JS } from './ext-bridge-page.js';
import { esc, icon, fmtTime } from './views.js';
import { fmtPhone, fmtWhen, pageHeader, tableWrap, emptyState } from './ui.js';
import { getLinkSettings, linkSettingsPanel } from './applicants-link.js';
import { listAccounts, saveAccount, setAccountActive, deleteAccount, MULTI_ACCOUNT_ENABLED } from './albamon-accounts.js';
import { listGwAccounts, saveGwAccount, deleteGwAccount, scanGwAccount } from './groupware.js';
import { opFor } from './oplog.js';
import { resumeOfInbox, resumePanel, RESUME_CSS } from './resume.js';
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

export async function renderInbox(db, env, { status = 'pending', isSuper = false, flash = '', err = '', origin = '', fetched = 0, viewer = null, filter = '', n = 0, skipped = 0, fr = 0, later = 0 } = {}) {
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
    bulkreg: `${Number(n) || 0}명을 지원자로 등록했어요.${Number(skipped) ? ` 연락처가 없는 ${Number(skipped)}건은 건너뛰었어요.` : ''}${Number(later) ? ` 한 번에 ${BULK_REGISTER_MAX}명까지 등록해요. 남은 ${Number(later)}명은 한 번 더 눌러 주세요.` : ''}`,
    bulkign: `${Number(n) || 0}건을 무시로 처리했어요.`,
    resumeall: `${Number(n) || 0}명의 이력서·연락처 가져오기를 요청했어요. 회사 PC 크롬(확장 v1.9.1, 알바몬 로그인)이 켜져 있으면 차례로 채워져요.`
  };
  const ERR = { invalid: '이름과 휴대폰 번호를 확인해 주세요. (예: 010-1234-5678)', gone: '이미 처리되었거나 찾을 수 없는 건이에요.', nopick: '먼저 지원자를 골라 주세요.', cclist: '원가중심점 목록에 없는 이름이에요. 입력하면 나오는 목록에서 골라 주세요.' };
  const notices = [];
  if (FLASH[flash]) notices.push(`<div class="notice ok">${icon('check')}<div>${esc(FLASH[flash])}</div></div>`);
  if (ERR[err]) notices.push(`<div class="notice warn" role="alert">${icon('alert')}<div>${esc(ERR[err])}</div></div>`);
  // 연락처는 가져왔지만 이력서 내용은 없는 사람(확장 v1.9 전에 가져온 사람): 이력서만 다시 읽기
  const noResume = (await first(db, `SELECT COUNT(*) n FROM applicant_inbox i WHERE i.resume_url != '' AND i.fetch_state != 'requested'
      AND NOT EXISTS (SELECT 1 FROM applicant_resumes r WHERE r.inbox_id=i.id) AND ${inboxScope(viewer, 'i').sql}`, ...inboxScope(viewer, 'i').args).catch(() => ({ n: 0 }))).n;
  if (noResume) notices.push(`<div class="notice info">${icon('info')}<div>이력서가 없는 지원자 <b>${noResume}명</b>
    <form method="post" action="/applicants/inbox/resume-all" class="inline" data-busy="이력서 다시 읽기 요청 중" style="margin-left:6px"><button class="small secondary">가져오기</button></form></div></div>`);

  const needPhone = all_.filter((r) => !r.phone).length;
  const stalledN = idle ? all_.filter((r) => !r.phone && r.fetch_state === 'requested' && !r.resume_only).length : 0;
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
    if (r.fetch_state === 'requested' && r.resume_only) return `<span class="badge">연락처 없음</span><small class="muted fetchwhen">이력서 읽는 중</small>`;
    if (r.fetch_state === 'requested') {
      // 기다리는 동안 멈춘 건지 알 수 있게: 요청한 지 얼마나 됐는지, 확장이 가져갔는지
      const ago = (t) => { const m = Math.max(0, Math.round((Date.now() - t) / 60000)); return m < 1 ? '방금' : m < 60 ? `${m}분 전` : `${Math.round(m / 60)}시간 전`; };
      const when = [r.fetch_req_at ? `요청 ${ago(r.fetch_req_at)}` : '', r.fetch_at ? `확장이 여는 중(${ago(r.fetch_at)})` : '확장 차례 기다림'].filter(Boolean).join(' · ');
      return (idle ? '<span class="badge wait" title="확장 프로그램이 깔린 PC 크롬이 켜지면 채워져요">PC 크롬을 기다려요</span>' : '<span class="badge wait">가져오는 중…</span>') + `<small class="muted fetchwhen">${esc(when)}</small>`;
    }
    if (r.fetch_state === 'failed') return `<span class="badge fail" title="${esc(r.fetch_note)}">가져오기 실패</span>`;
    return '<span class="badge">연락처 없음</span>';
  };
  const classState = (r) => r.cost_center
    ? `<span class="badge info">${esc(r.cost_center)}${r.job ? ' · ' + esc(r.job) : ''}</span>` : '<span class="badge wait">분류 필요</span>';

  const card = (r) => {
    const open = status !== 'done';
    const who = [r.mail_account ? `메일함 ${esc(r.mail_account)}` : '', isSuper && r.owner_name ? `${esc(r.owner_name)} 담당` : ''].filter(Boolean).join(' · ');
    const fetchBtn = !r.phone && (r.fetch_state !== 'requested' || r.resume_only)
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
          ${r.has_resume ? `<a class="lk" href="/applicants/inbox/${r.id}/resume">저장된 이력서</a>` : ''}
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

export const BULK_REGISTER_MAX = 100;

// 알바몬 계정 여러 개(관리자): 등록하면 관리자 PC 의 확장이 계정을 바꿔 가며 모든 담당자의 연락처 요청을 처리한다
async function albamonAccountsCard(db) {
  const list = await listAccounts(db);
  const row = (a) => `<li class="amrow">
      <div><b>${esc(a.label)}</b> <span class="muted">${esc(a.login_id)}</span>${a.active ? '' : ' <span class="badge mute">꺼짐</span>'}
        <div class="muted" style="font-size:13px">${a.last_error ? `<span style="color:var(--red-t)">${esc(a.last_error)}</span> · ` : ''}${a.last_ok_at ? `마지막 성공 ${esc(fmtWhen(a.last_ok_at))}` : '아직 쓰지 않았어요'} · 연결된 공고 ${a.postings}개</div></div>
      <div class="amacts">
        <details><summary class="lk">수정</summary>
          <form method="post" action="/applicants/inbox/albamon-account" class="amform"><input type="hidden" name="id" value="${a.id}">
            <input name="label" value="${esc(a.label)}" maxlength="40" required aria-label="계정 이름">
            <input name="login_id" value="${esc(a.login_id)}" maxlength="60" required autocomplete="off" aria-label="아이디">
            <input name="pw" type="password" autocomplete="new-password" placeholder="새 비밀번호(바꿀 때만)" aria-label="새 비밀번호">
            <button class="small">저장</button></form></details>
        <form method="post" action="/applicants/inbox/albamon-account/${a.id}/toggle" class="inline"><input type="hidden" name="on" value="${a.active ? 0 : 1}"><button class="lk">${a.active ? '끄기' : '켜기'}</button></form>
        <form method="post" action="/applicants/inbox/albamon-account/${a.id}/delete" class="inline" data-confirm="이 알바몬 계정을 지울까요? 이 계정 공고의 연락처는 더 가져오지 못해요."><button class="lk" style="color:var(--red-t)">지우기</button></form>
      </div></li>`;
  return `<style>.amlist{list-style:none;margin:8px 0 12px;padding:0}.amrow{display:flex;gap:12px;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;padding:12px 0;border-top:1px solid var(--line-soft)}.amrow:first-child{border-top:0}.amacts{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.amform{display:grid;gap:8px;grid-template-columns:repeat(auto-fit,minmax(min(100%,160px),1fr));margin-top:8px}</style>
    <section class="card" style="margin-top:12px"><h2 style="font-size:18px;margin:0">알바몬 계정 <small class="muted" style="font-weight:400">관리자 · ${list.length}개</small></h2>
      <p class="muted" style="font-size:14px;margin:6px 0 0">공고가 여러 알바몬 기업회원 계정에 나뉘어 있으면 모두 등록하세요. <b>관리자 PC의 확장</b>이 계정을 바꿔 가며 <b>모든 담당자의 연락처 요청</b>을 처리해요. 처음 보는 공고는 계정을 차례로 시도해 열리는 계정을 기억하고, 다음부터는 그 계정으로 바로 열어요. 처리하는 동안 그 크롬의 알바몬 로그인이 잠깐 바뀌었다가 원래대로 돌아와요.</p>
      <p class="muted" style="font-size:13px;margin:6px 0 0">비밀번호는 암호화해 저장하고 화면에 다시 보여 주지 않아요. 관리자에게 연결된 확장 프로그램만 받아요.</p>
      ${list.length ? `<ul class="amlist">${list.map(row).join('')}</ul>` : '<p class="muted" style="margin:12px 0">아직 등록한 계정이 없어요. 없으면 각 PC 크롬에 로그인된 알바몬 계정으로 가져와요.</p>'}
      <form method="post" action="/applicants/inbox/albamon-account" class="amform" autocomplete="off">
        <input name="label" maxlength="40" required placeholder="계정 이름 (예: 아마노 현장HR)" aria-label="새 계정 이름">
        <input name="login_id" maxlength="60" required placeholder="알바몬 아이디" autocomplete="off" aria-label="새 계정 아이디">
        <input name="pw" type="password" required placeholder="비밀번호" autocomplete="new-password" aria-label="새 계정 비밀번호">
        <button class="btn small">계정 추가</button></form>
    </section>`;
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
  const FLASH = { gw_saved: '그룹웨어를 연결했어요. 아래 결과를 확인해 주세요.', gw_checked: '그룹웨어를 확인했어요.', gw_deleted: '그룹웨어 연결을 지웠어요.', am_saved: '알바몬 계정을 저장했어요. 관리자 PC의 확장이 다음 확인 때(1분 안) 새 계정을 받아요.', am_deleted: '알바몬 계정을 지웠어요.', am_toggled: '알바몬 계정 사용 여부를 바꿨어요.', auto: '자동 등록 설정을 저장했어요.', addr: '내 수신 주소를 바꿨어요. 메일 전달 규칙을 걸어 두셨다면 새 주소로 바꿔 주세요.', token: '공용 수신 주소를 새로 만들었어요. 메일 전달 설정도 새 주소로 바꿔 주세요.' };
  const ERR = { gw_need: '그룹웨어 아이디와 비밀번호를 적어 주세요.', am_need: '알바몬 계정 이름과 아이디를 적어 주세요.', am_pw: '알바몬 비밀번호를 적어 주세요.', am_gone: '알바몬 계정을 찾을 수 없어요.', am_dup: '이미 등록된 알바몬 아이디예요.', addr_invalid: '주소 이름은 영문 소문자·숫자·-만 쓸 수 있고 3~30자예요.', addr_taken: '이미 다른 사람이 쓰고 있는 이름이에요. 다른 이름을 써 주세요.' };
  const notices = [];
  if (FLASH[flash]) notices.push(`<div class="notice ok">${icon('check')}<div>${esc(FLASH[flash])}</div></div>`);
  if (ERR[err]) notices.push(`<div class="notice warn" role="alert">${icon('alert')}<div>${esc(ERR[err])}</div></div>`);

  // 1단계: 서버가 그룹웨어에 직접 접속해 1분마다 알바몬 지원 메일을 가져온다(PC 불필요)
  const gwList = viewer ? await listGwAccounts(db, isSuper ? null : viewer.id) : [];
  const gwRow = (g) => `<li class="amrow"><div><b>${esc(g.login_id)}</b>${isSuper && g.owner ? ` <span class="muted">· ${esc(g.owner)} 담당</span>` : ''}
      ${g.blocked ? ' <span class="badge no">쉬는 중</span>' : g.last_ok_at ? ' <span class="badge ok">연결됨</span>' : ' <span class="badge wait">확인 전</span>'}
      <div class="muted" style="font-size:13px">${g.last_error ? `<span style="color:var(--red-t)">${esc(g.last_error)}</span>` : g.last_ok_at ? `마지막 확인 ${esc(fmtWhen(g.last_check_at))} · 방금 새 지원 ${g.last_added}건` : '아직 확인하지 않았어요. [지금 확인]을 눌러 보세요.'}</div>
      ${isSuper && g.diag ? `<details style="margin-top:4px"><summary class="lk" style="font-size:13px">진단 기록</summary><pre style="white-space:pre-wrap;font-size:12px;margin:6px 0 0">${esc(g.diag)}</pre></details>` : ''}</div>
    <div class="amacts"><form method="post" action="/applicants/inbox/gw/${g.id}/check" class="inline" data-busy="그룹웨어 메일 확인 중"><button class="small">지금 확인</button></form>
      <form method="post" action="/applicants/inbox/gw/${g.id}/delete" class="inline" data-confirm="이 그룹웨어 연결을 지울까요? 저장한 비밀번호도 지워져요."><button class="lk" style="color:var(--red-t)">지우기</button></form></div></li>`;
  const gwCard = `<style>.amlist{list-style:none;margin:8px 0 12px;padding:0}.amrow{display:flex;gap:12px;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;padding:12px 0;border-top:1px solid var(--line-soft)}.amrow:first-child{border-top:0}.amacts{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.amform{display:grid;gap:8px;grid-template-columns:repeat(auto-fit,minmax(min(100%,160px),1fr));margin-top:8px}</style>
      <section class="cstep${gwList.some((g) => g.last_ok_at && !g.blocked) ? ' done' : ''}"><h2>지원 메일 받기: 그룹웨어 직접 연결</h2>
        <p class="muted" style="font-size:15px">그룹웨어 아이디·비밀번호를 넣으면 <b>시스템이 1분마다</b> 그 메일함에서 알바몬 지원 메일을 가져와 <b>내 새 지원</b>에 넣어요. <b>PC가 꺼져 있어도</b> 들어와요.</p>
        <div class="stack">
          ${gwList.length ? `<ul class="amlist">${gwList.map(gwRow).join('')}</ul>` : ''}
          <form method="post" action="/applicants/inbox/gw" class="amform" autocomplete="off" data-busy="그룹웨어 연결 확인 중">
            <input name="login_id" maxlength="80" required placeholder="그룹웨어 아이디 (예: bigbear)" autocomplete="off" aria-label="그룹웨어 아이디">
            <input name="pw" type="password" maxlength="100" required placeholder="그룹웨어 비밀번호" autocomplete="new-password" aria-label="그룹웨어 비밀번호">
            <button class="btn small">${gwList.length ? '추가·비밀번호 바꾸기' : '연결하기'}</button></form>
          <p class="muted" style="font-size:13px;margin:0">그룹웨어 비밀번호를 바꾸면 여기서도 다시 저장해 주세요.</p>
        </div></section>`;
  // 관리자: 연락처를 가져오면 바로 지원자로 등록(예전에는 공용 수신 주소 카드 안에 있었다)
  const autoCard = isSuper ? `<div class="card" style="margin-top:12px"><b>자동 등록</b> <small class="muted">관리자</small>
      <div style="margin-top:8px"><form method="post" action="/applicants/inbox/auto" class="inline"><input type="hidden" name="on" value="${autoOn ? 0 : 1}">
        <button class="btn secondary small">연락처를 가져오면 바로 지원자로 등록: <b>${autoOn ? '켜짐 (끄기)' : '꺼짐 (켜기)'}</b></button></form></div></div>` : '';
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

  // 위쪽 상태: 지원 메일(시스템이 그룹웨어에서 직접) · 연락처(PC 크롬 확장) 두 가지를 따로 보여 준다
  const gwOk = gwList.filter((g) => g.active && !g.blocked && g.last_ok_at && Date.now() - g.last_ok_at < 10 * 60000);
  const mailState = gwOk.length ? { cls: 'on', text: '지원 메일: 1분마다 받는 중', hint: `마지막 확인 ${fmtWhen(Math.max(...gwOk.map((g) => g.last_check_at || 0)))}` }
    : gwList.some((g) => g.blocked || g.last_error) ? { cls: 'idle', text: '지원 메일: 확인 필요', hint: '아래 1단계의 빨간 안내를 확인해 주세요' }
    : { cls: '', text: '지원 메일: 설정 필요', hint: '아래 1단계에서 그룹웨어를 연결해 주세요' };
  const contactState = { cls: cs.cls, text: cs.text.replace('자동 수집', '연락처 가져오기'), hint: cs.hint };
  const pill = (x) => `<div class="cstate"><span class="conn ${x.cls}"><i></i>${esc(x.text)}</span><span class="muted" style="font-size:13px">${esc(x.hint)}</span></div>`;

  return `<style>.cstates{display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr))}.cstate{display:grid;gap:4px;align-content:start}</style>
    ${pageHeader({ title: '연결 설정', desc: '지원 메일과 연락처를 자동으로 모으는 설정이에요. 처음 한 번만 하면 돼요.', back: { href: '/applicants/inbox', label: '새 지원' } })}
    ${peopleTabs('connect', pending, todo)}
    ${notices.join('')}
    <div class="hero cstates">${pill(mailState)}${pill(contactState)}</div>
    <div class="csteps">
      ${gwCard}
      <section class="cstep${agent.lastUsedAt ? ' done' : ''}"><h2>연락처 가져오기: 크롬 확장 프로그램 설치</h2>
        <p class="muted" style="font-size:15px">알바몬 메일에는 연락처가 없어요. <b>PC 크롬의 확장 프로그램</b>이 알바몬 이력서를 열어 연락처를 채워 줘요. 한 번만 설치하면 돼요. 그 PC의 크롬이 켜져 있을 때 처리돼요(휴대폰에서 요청해도 돼요).</p>
        <div class="stack">
          <ol class="muted" style="margin:0;padding-left:20px;font-size:14px">
            <li>아래 <b>확장 프로그램 내려받기</b>로 파일을 받고 압축을 풀어요.</li>
            <li>크롬 주소창에 <code>chrome://extensions</code> 입력 → 오른쪽 위 <b>개발자 모드</b> 켜기 → <b>압축해제된 확장 프로그램을 로드합니다</b> → 풀어 둔 <code>albamon-extension</code> 폴더 선택. (새 버전은 같은 폴더에 덮어쓰고 <b>새로고침</b>)</li>
            <li>이 화면을 새로고침하면 아래 상태 줄이 <b>"확장 프로그램: 연결됨"</b>으로 바뀌고 연결 키도 자동으로 연결돼요.</li>
          </ol>
          <div><a class="btn small" href="/applicants/inbox/extension.zip" download>${icon('download', 18)}확장 프로그램 내려받기 (v${esc(EXTENSION_VERSION)})</a></div>
          <div id="extstate" class="notice" role="status" data-latest="${esc(EXTENSION_VERSION)}">확장 프로그램 확인 중…</div>
          <div id="extlast" class="notice" role="status" hidden></div>
          ${agentToken ? `<span id="newkey" hidden>${esc(agentToken)}</span>` : ''}
        </div></section>
      <section class="cstep"><h2>알바몬 로그인 유지</h2>
        <p class="muted" style="font-size:15px">확장 프로그램이 있는 크롬에서 <b>알바몬 기업회원으로 로그인</b>해 두세요(문자 인증 포함). 새 지원에서 <b>연락처 가져오기</b>를 누르면 30초 안에 이력서를 열어 연락처를 채워요. 로그인이 풀리면 확장이 "로그인이 필요해요"라고 알리고 멈춰요. 그 크롬에서 다시 로그인하면 이어서 해요.</p></section>
    </div>
    ${isSuper ? `<section class="section"><div class="shead"><h2>관리자 설정</h2><a href="/applicants/resume-fields">이력서 항목 분석 →</a></div>
      ${autoCard}
      ${MULTI_ACCOUNT_ENABLED ? await albamonAccountsCard(db) : ''}
      ${linkSettingsPanel(await getLinkSettings(db), true)}
    </section>` : ''}
    <details class="advanced"><summary>고급 설정</summary>
      ${keyCard}
      ${tool}
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
      flash: sp.get('ok') || '', err: sp.get('err') || '', origin: new URL(request.url).origin, fetched: sp.get('n') || 0, n: sp.get('n') || 0, skipped: sp.get('s') || 0, fr: sp.get('fr') || 0, later: sp.get('later') || 0
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
    return redirect('/applicants/inbox/connect');   // 메일 수신 주소(Cloudflare Email Routing)는 쓰지 않는다(2026-10-17)
    const f = await readForm(request);
    const r = await setUserMailName(db, user.id, f.random === '1' ? '' : f.name);
    if (!r.ok) return redirect(`/applicants/inbox/connect?err=addr_${r.error}`);
    await audit(db, user, 'applicant.inbox_my_address', '');
    return redirect('/applicants/inbox/connect?ok=addr');
  }
  if (path === '/applicants/inbox/token' && method === 'POST') {
    return redirect('/applicants/inbox/connect');   // 메일 수신 주소(Cloudflare Email Routing)는 쓰지 않는다(2026-10-17)
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
    const sc = inboxScope(viewer);
    // D1 은 쿼리당 값 100개까지라 나눠서 읽는다("이 화면 전체 선택"은 200건까지)
    const rows = [];
    for (const part of chunks(ids)) rows.push(...await all(db, `SELECT * FROM applicant_inbox WHERE id IN (${part.map(() => '?').join(',')}) AND status='pending' AND ${sc.sql}`, ...part, ...sc.args));
    const now = Date.now();
    if (op === 'fetch') {
      let n = 0;
      for (const part of chunks(rows.map((r) => r.id))) n += await requestFetch(db, part, viewer);
      await audit(db, user, 'applicant.inbox_fetch_bulk', `n=${n}`);
      return redirect(`/applicants/inbox?ok=fetchall&n=${n}`);
    }
    if (op === 'ignore') {
      const st = rows.map((r) => stmt(db, `UPDATE applicant_inbox SET status='ignored', handled_by=?, handled_at=? WHERE id=? AND status='pending'`, user.id, now, r.id));
      for (const part of chunks(st, 40)) await db.batch(part);
      await audit(db, user, 'applicant.inbox_ignore_bulk', `n=${rows.length}`);
      return redirect(`/applicants/inbox?ok=bulkign&n=${rows.length}`);
    }
    if (op === 'register') {
      // 한 건 등록에 DB 호출이 7번쯤 든다. Workers 요청당 내부 호출 한도(1,000)를 넘지 않게 한 번에 100건까지만 하고 나머지는 다시 누르게 한다.
      let done = 0, skip = 0;
      const withPhone = rows.filter((r) => r.phone && isValidMobile(r.phone));
      const later = Math.max(0, withPhone.length - BULK_REGISTER_MAX);
      const allowed = new Set(withPhone.slice(0, BULK_REGISTER_MAX).map((r) => r.id));
      const log = opFor(request);
      await log(`${allowed.size}명을 지원자로 등록하는 중…`);
      for (const r of rows) {
        if (r.phone && isValidMobile(r.phone) && !allowed.has(r.id)) continue;
        if (!r.phone || !isValidMobile(r.phone)) { skip++; continue; }
        const x = await deps.saveApplicant(db, { name: r.name, phone: r.phone, applied_to: r.cost_center, job: r.job, recruit_no: r.recruit_no, posting_title: r.job_title, company_raw: r.company }, user.id, 'mail');
        if (!x.ok) { skip++; continue; }
        await run(db, `UPDATE applicant_inbox SET status='registered', applicant_id=?, handled_by=?, handled_at=? WHERE id=?`, x.id, user.id, now, r.id);
        await deps.addEvent(db, x.id, 'apply', `${r.source === 'albamon' ? '알바몬' : '메일'} 지원 메일에서 등록(일괄)`, user.id, now);
        done++;
        if (done % 20 === 0) await log(`${done}/${allowed.size}명 등록했어요`);
      }
      await log(`${done}명 등록 완료`);
      await audit(db, user, 'applicant.inbox_register_bulk', `n=${done}`);
      return redirect(`/applicants/inbox?ok=bulkreg&n=${done}&s=${skip + (ids.length - rows.length)}${later ? `&later=${later}` : ''}`);
    }
    return redirect('/applicants/inbox');
  }

  if (path === '/applicants/inbox/resume-all' && method === 'POST') {
    const sc = inboxScope(viewer, 'i');
    // 연락처가 없으면 연락처+이력서, 연락처가 이미 있으면(예전에 가져온 사람·등록된 사람) 이력서만
    const r = await run(db, `UPDATE applicant_inbox SET resume_only=CASE WHEN phone != '' THEN 1 ELSE 0 END, fetch_state='requested', fetch_at=NULL, fetch_note='', fetch_req_at=?
        WHERE id IN (SELECT i.id FROM applicant_inbox i WHERE i.resume_url != '' AND i.fetch_state != 'requested'
          AND NOT EXISTS (SELECT 1 FROM applicant_resumes x WHERE x.inbox_id=i.id) AND ${sc.sql})`, Date.now(), ...sc.args);
    const n = r.meta.changes || 0;
    await opFor(request)(`${n}명의 이력서 다시 읽기를 요청했어요`);
    await audit(db, user, 'applicant.inbox_resume_all', `n=${n}`);
    return redirect(`/applicants/inbox?ok=resumeall&n=${n}`);
  }
  const rv = path.match(/^\/applicants\/inbox\/(\d+)\/resume$/);
  if (rv && method === 'GET') {
    const sc = inboxScope(viewer, 'i');
    const it = await first(db, `SELECT i.* FROM applicant_inbox i WHERE i.id=? AND ${sc.sql}`, Number(rv[1]), ...sc.args);
    const res = it ? await resumeOfInbox(db, it.id) : null;
    if (!it || !res) return html(pg('없음', '<p>저장된 이력서가 없어요.</p><p><a href="/applicants/inbox">새 지원으로</a></p>', 'applicants'), 404);
    await audit(db, user, 'applicant.resume_view', `inbox=${it.id}`);
    let mf = null; try { mf = it.mail_fields ? JSON.parse(it.mail_fields) : null; } catch { mf = null; }
    return html(pg('저장된 이력서', `${RESUME_CSS}<a class="back" href="${it.applicant_id ? `/applicants/${it.applicant_id}` : '/applicants/inbox'}" style="display:inline-block;font-size:14px;margin-bottom:10px">← ${it.applicant_id ? '지원자' : '새 지원'}</a>
      <header class="phead"><div><h1>${esc(it.name)}</h1><p class="muted">${esc(it.company || '')} · ${esc(it.job_title || '')}</p></div></header>${resumePanel(res, { mailFields: mf })}`, 'applicants'));
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
  // 그룹웨어 직접 연결(내 계정, 관리자는 모두)
  if (path.startsWith('/applicants/inbox/gw') && method === 'POST') {
    const f = Object.fromEntries(new URLSearchParams(await request.text()));
    const m = path.match(/^\/applicants\/inbox\/gw\/(\d+)\/(check|delete)$/);
    if (m) {
      const a = await first(db, `SELECT * FROM gw_accounts WHERE id=?`, Number(m[1]));
      if (!a || (user.role !== 'super' && a.user_id !== user.id)) return redirect('/applicants/inbox/connect');
      if (m[2] === 'delete') { await deleteGwAccount(db, a.id, user.id, user.role === 'super'); await audit(db, user, 'gw.delete', `id=${a.id}`); return redirect('/applicants/inbox/connect?ok=gw_deleted'); }
      await scanGwAccount(env, a, { onStep: opFor(request) });
      await audit(db, user, 'gw.check', `id=${a.id}`);
      return redirect('/applicants/inbox/connect?ok=gw_checked');
    }
    if (path !== '/applicants/inbox/gw') return redirect('/applicants/inbox/connect');
    const r = await saveGwAccount(db, env, user.id, f.login_id, f.pw);
    if (r.error) return redirect(`/applicants/inbox/connect?err=${r.error}`);
    await opFor(request)('그룹웨어 계정을 저장했어요(비밀번호는 암호화)');
    await audit(db, user, 'gw.save', `id=${r.id}`);
    // 저장하자마자 한 번 확인해서 결과를 바로 보여 준다
    const a = await first(db, `SELECT * FROM gw_accounts WHERE id=?`, r.id);
    await scanGwAccount(env, a, { onStep: opFor(request) });
    return redirect('/applicants/inbox/connect?ok=gw_saved');
  }

  // 알바몬 계정(관리자)
  if (path.startsWith('/applicants/inbox/albamon-account') && method === 'POST') {
    if (!MULTI_ACCOUNT_ENABLED) return redirect('/applicants/inbox/connect');
    if (user.role !== 'super') return html(pg('접근 불가', '<p>관리자만 바꿀 수 있어요.</p>'), 403);
    const f = Object.fromEntries(new URLSearchParams(await request.text()));
    const m = path.match(/^\/applicants\/inbox\/albamon-account\/(\d+)\/(toggle|delete)$/);
    if (m && m[2] === 'toggle') { await setAccountActive(db, m[1], f.on === '1'); await audit(db, user, 'albamon.toggle', `id=${m[1]} on=${f.on}`); return redirect('/applicants/inbox/connect?ok=am_toggled'); }
    if (m && m[2] === 'delete') { await deleteAccount(db, m[1]); await audit(db, user, 'albamon.delete', `id=${m[1]}`); return redirect('/applicants/inbox/connect?ok=am_deleted'); }
    if (path !== '/applicants/inbox/albamon-account') return redirect('/applicants/inbox/connect');
    const r = await saveAccount(db, env, { id: f.id ? Number(f.id) : null, label: f.label, login_id: f.login_id, pw: f.pw });
    if (r.error) return redirect(`/applicants/inbox/connect?err=${r.error}`);
    await audit(db, user, 'albamon.save', `id=${f.id || 'new'}`);
    return redirect('/applicants/inbox/connect?ok=am_saved');
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
