// 문자 관리 시스템 - 연락처 가져오기 (크롬 확장)
//  - 수신함에서 [연락처 가져오기]를 누른 건만 처리한다.
//  - 이 크롬의 알바몬 로그인 상태를 그대로 쓴다. 알바몬 아이디·비밀번호는 읽지도 저장하지도 않는다.
//  - 이용권 차감·결제 확인 창이 보이면 누르지 않고 멈춘다.
const ALARM = 'albamon-poll';
const MAX_PER_RUN = 5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let running = false;
let runningSince = 0;
const ITEM_TIMEOUT = 70000;
const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(label)), ms))]);

// level: 'info'(진행 중) | 'ok'(잘 됨) | 'warn'(일부 안 됨) | 'error'(막힘 — 사용자가 해야 할 일이 있음)
async function setStatus(text, level = 'info') {
  await chrome.storage.local.set({ lastStatus: new Date().toLocaleTimeString('ko-KR') + ' · ' + text, lastLevel: level });
  try { await chrome.action.setBadgeText({ text: level === 'error' || level === 'warn' ? '!' : '' }); } catch { /* ignore */ }
}
const rank = { ok: 0, info: 0, warn: 1, error: 2 };
const worst = (a, b) => (rank[b] > rank[a] ? b : a);

async function api(cfg, path, init = {}) {
  let r;
  try {
    r = await fetch(cfg.serverUrl + path, {
      ...init, headers: { Authorization: 'Bearer ' + cfg.agentToken, 'Content-Type': 'application/json', ...(init.headers || {}) }
    });
  } catch {
    throw new Error('문자 관리 시스템(' + cfg.serverUrl.replace(/^https?:\/\//, '') + ')에 연결하지 못했어요. 인터넷 연결을 확인해 주세요.');
  }
  if (r.status === 401) throw new Error('연결 키가 맞지 않아요. 수신함에서 키를 다시 만들어 넣어 주세요.');
  if (!r.ok) throw new Error('시스템 응답 오류 ' + r.status);
  return r;
}

// 탭이 다 열릴 때까지 기다린다
function waitLoaded(tabId, ms = 45000) {
  return new Promise((resolve) => {
    let done = false;
    const fin = () => { if (done) return; done = true; chrome.tabs.onUpdated.removeListener(on); clearTimeout(t); resolve(); };
    const on = (id, info) => { if (id === tabId && info.status === 'complete') fin(); };
    const t = setTimeout(fin, ms);
    chrome.tabs.onUpdated.addListener(on);
    chrome.tabs.get(tabId).then((tab) => { if (tab.status === 'complete') fin(); }).catch(fin);
  });
}

// ---- 이력서 탭 안에서 실행되는 함수 (다른 것을 참조하지 않는다) ----
async function pageRead(item, dry) {
  const sleepP = (ms) => new Promise((r) => setTimeout(r, ms));
  const text = () => (document.body && document.body.innerText) || '';
  const PHONE_RE = /01[016789][-\s.]?\d{3,4}[-\s.]?\d{4}/g;
  const digits = (s) => String(s || '').replace(/\D/g, '');
  const findPhones = (t) => { const o = []; for (const m of String(t).matchAll(PHONE_RE)) { const d = digits(m[0]); if (/^01[016789]\d{7,8}$/.test(d) && !o.includes(d)) o.push(d); } return o; };
  const pickPhone = (t) => {
    const all = findPhones(t); if (!all.length) return '';
    const lines = String(t).split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (/(연락처|휴대폰|핸드폰|전화번호|휴대전화)/.test(lines[i])) { const n = findPhones(lines.slice(i, i + 3).join(' ')); if (n.length) return n[0]; }
    }
    return all[0];
  };
  const nameMatches = (t, name) => {
    const n = String(name || '').trim(); if (!n) return false;
    if (t.includes(n)) return true;
    if (n.length >= 2) { const m = n[0] + '*'.repeat(Math.max(n.length - 2, 1)) + n[n.length - 1]; return t.includes(m) || t.includes(n[0] + '*' + n.slice(2)); }
    return false;
  };
  const visible = (e) => { const r = e.getBoundingClientRect(); const st = getComputedStyle(e); return r.width > 0 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden'; };

  await sleepP(1500);
  const pw = document.querySelector('input[type=password]');
  if ((pw && visible(pw)) || /user-account\/login|\/login/i.test(location.href)) return { state: 'login' };

  const before = text();
  const urlOk = location.href.includes(item.apply_no);
  const nameOk = nameMatches(before, item.name);
  let phone = pickPhone(before);
  let clicked = false;
  if (!phone) {
    const pats = [/(연락처|전화번호|휴대폰|핸드폰|휴대전화).{0,6}(보기|확인|열람|조회)/, /(보기|확인|열람|조회).{0,6}(연락처|전화번호|휴대폰|핸드폰)/];
    const els = [...document.querySelectorAll('button,a,[role=button],span,div,li,label')];
    const hit = els.filter((e) => {
      const t = (e.innerText || '').replace(/\s+/g, ' ').trim();
      return t && t.length <= 24 && visible(e) && pats.some((re) => re.test(t));
    });
    const el = hit.find((e) => !hit.some((o) => o !== e && e.contains(o))) || hit[0];
    if (!el) return { state: 'nobutton' };
    if (dry) return { state: 'dry' };
    el.click();
    clicked = true;
    await sleepP(1500);
    let after = text();
    if (after === before) { el.click(); await sleepP(1200); after = text(); }
    const dlg = [...document.querySelectorAll('dialog[open],[role=dialog],[role=alertdialog],.modal,.popup,.layer,[class*=modal],[class*=popup],[class*=layer]')]
      .filter(visible).map((e) => e.innerText || '').join(' ');
    phone = pickPhone(after);
    if (/(차감|이용권|열람권|포인트|결제|구매|사용하시겠|유료|잔여|캐시|상품)/.test(dlg) && !phone) return { state: 'deduct' };
  }
  if (!phone) return { state: 'nophone', clicked };
  if (!urlOk && !nameOk && !nameMatches(text(), item.name)) return { state: 'mismatch' };
  return { state: 'ok', phone };
}

const NOTES = {
  nobutton: '연락처 보기 버튼을 찾지 못했어요(화면 구조가 다를 수 있어요).',
  nophone: '버튼을 눌렀지만 전화번호가 보이지 않았어요.',
  mismatch: '이력서가 맞는지 확인하지 못했어요(이름·지원 번호가 화면에 없어요).',
  deduct: '이용권 차감·결제 확인 창이 떠서 멈췄어요. 알바몬 화면에서 직접 확인해 주세요.'
};

async function processItem(cfg, item) {
  const tab = await chrome.tabs.create({ url: item.resume_url, active: false });
  try {
    let res;
    try {
      await waitLoaded(tab.id);
      await sleep(1000);
      [res] = await withTimeout(chrome.scripting.executeScript({ target: { tabId: tab.id }, func: pageRead, args: [{ name: item.name, apply_no: item.apply_no }, !!cfg.dry] }), ITEM_TIMEOUT, 'timeout');
    } catch (e) {
      if (cfg.dry) return { dry: false, failed: true };
      await api(cfg, `/api/agent/inbox/${item.id}/result`, { method: 'POST', body: JSON.stringify({ ok: false, phone: '', note: '이력서 화면을 읽지 못했어요(' + (e.message === 'timeout' ? '시간 초과' : '화면 접근 오류') + ').' }) });
      return { failed: true };
    }
    const r = (res && res.result) || { state: 'nobutton' };
    if (r.state === 'login') return { stop: 'login' };
    if (r.state === 'dry') return { dry: true };
    if (r.state === 'ok') {
      await api(cfg, `/api/agent/inbox/${item.id}/result`, { method: 'POST', body: JSON.stringify({ ok: true, phone: r.phone, note: '' }) });
      return { ok: true };
    }
    await api(cfg, `/api/agent/inbox/${item.id}/result`, { method: 'POST', body: JSON.stringify({ ok: false, phone: '', note: NOTES[r.state] || '알 수 없는 이유로 실패했어요.' }) });
    return { stop: r.state === 'deduct' ? 'deduct' : '', failed: true };
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

// ---------------- 그룹웨어 비밀번호 확인 ----------------
// 이 크롬이 이미 그룹웨어에 로그인되어 있으면 저장한 비밀번호와 상관없이 메일함이 열려서, 틀린 비밀번호도 모르고 지나간다.
// 그래서 저장할 때 그룹웨어의 로그인 확인 요청을 쿠키 없이(세션을 만들지 않고) 한 번 보내 맞는지 확인한다.
// 주의: 그룹웨어는 비밀번호를 여러 번(예: 5번) 틀리면 계정을 잠글 수 있다. 그래서 틀리면 자동으로 다시 시도하지 않고, 새로 저장할 때만 확인한다.
const GW_LOGIN_BASE_DEFAULT = 'https://gw.willvi.co.kr';
async function verifyGwLogin(cfg) {
  const base = (cfg.gwLoginBase || GW_LOGIN_BASE_DEFAULT).replace(/\/+$/, '');
  const host = new URL(base).host;
  const id = String(cfg.gwId || '').split('@')[0].trim();
  const H = { 'Content-Type': 'application/json;charset=UTF-8', Accept: 'application/json' };
  try {
    const dr = await fetch(`${base}/gw/data/common/login/selectDepartmentList.do?_=${Date.now()}t`, {
      method: 'POST', credentials: 'omit', headers: H, body: JSON.stringify({ deptId: '', langCode: 'ko', gwUrl: host, userId: id, pwd: '', sec: '' })
    });
    const depts = await dr.json();
    const d = Array.isArray(depts) ? (depts.find((x) => x.reprsntDeptYn === 'Y') || depts[0]) : null;
    const r = await fetch(`${base}/gw/data/common/login/selectLoginFlag.do?lang=ko&_=${Date.now()}t`, {
      method: 'POST', credentials: 'omit', headers: H, body: JSON.stringify({ deptId: d ? d.deptId : '', langCode: 'ko', gwUrl: host, userId: id, pwd: cfg.gwPw, sec: '', token: null })
    });
    const j = await r.json();
    if (String(j.resultCode) === '0') return { ok: true };
    return { ok: false, code: String(j.resultCode), now: j.nowErrorCnt, limit: j.limitErrorCnt };
  } catch { return { ok: false, network: true }; }
}
function gwFailText(v) {
  if (v.network) return '그룹웨어에 연결하지 못했어요. 인터넷·사내망 연결을 확인한 뒤 다시 저장해 주세요.';
  if (v.code === '-20') return '그룹웨어에 없는 아이디예요. 아이디(메일 주소의 @ 앞부분)를 확인해 주세요.';
  const cnt = v.limit ? ` (틀린 횟수 ${v.now}/${v.limit} — ${v.limit}번 틀리면 그룹웨어 계정이 잠길 수 있어요)` : '';
  return `그룹웨어 아이디 또는 비밀번호가 맞지 않아요${cnt}. 그룹웨어를 직접 열어 같은 아이디·비밀번호로 로그인되는지 확인하고, 수신함 화면에서 다시 저장해 주세요.`;
}

// 설정 저장(수신함 화면·팝업 공통). 그룹웨어 계정이 바뀌면 바로 확인하고, 결과를 상태에 남긴다.
async function saveConfig(p, origin) {
  const set = {};
  if (p.agentToken) set.agentToken = p.agentToken;
  if (typeof p.gwId === 'string') set.gwId = p.gwId;
  if (p.gwPw) set.gwPw = p.gwPw;
  if (typeof p.gwOn === 'boolean') set.gwOn = p.gwOn;
  if (typeof p.dry === 'boolean') set.dry = p.dry;
  if (typeof p.serverUrl === 'string' && p.serverUrl) set.serverUrl = p.serverUrl;
  else if (origin && (set.agentToken || set.gwId || set.gwPw)) set.serverUrl = origin;
  if (!Object.keys(set).length) return;
  await chrome.storage.local.set(set);
  if (set.gwId !== undefined || set.gwPw) {
    const cfg = await chrome.storage.local.get(['gwId', 'gwPw', 'gwLoginBase']);
    if (cfg.gwId && cfg.gwPw) {
      await setStatus('그룹웨어 아이디·비밀번호를 확인하는 중…', 'info');
      const v = await verifyGwLogin(cfg);
      if (!v.ok) { await chrome.storage.local.set({ gwBlocked: true }); await setStatus(gwFailText(v), 'error'); return; }
      await chrome.storage.local.set({ gwBlocked: false, gwForceLogin: true });
    }
  }
  setTimeout(() => run(true), 300);
}

// 이 크롬이 다른 사람(또는 다른 계정)으로 그룹웨어에 로그인돼 있으면 엉뚱한 메일함을 읽게 된다.
// 그래서 새 계정을 저장한 뒤 처음 확인할 때는 그룹웨어 로그인 정보를 지우고 **저장한 내 계정으로 다시 로그인**한다.
// (이 크롬에서 열어 둔 그룹웨어 창은 로그아웃될 수 있다)
async function clearGwCookies(cfg) {
  const domain = cfg.gwCookieDomain || 'willvi.co.kr';
  const list = await chrome.cookies.getAll({ domain });
  for (const c of list) {
    const url = (c.secure ? 'https://' : 'http://') + c.domain.replace(/^\./, '') + c.path;
    await chrome.cookies.remove({ url, name: c.name, storeId: c.storeId }).catch(() => {});
  }
}

// ---------------- 그룹웨어 메일에서 알바몬 지원 메일 가져오기 ----------------
// 그룹웨어 아이디·비밀번호는 이 PC 크롬(chrome.storage.local)에만 저장하고, 그룹웨어 로그인 화면에만 입력한다.
// 문자 관리 시스템으로는 보내지 않는다. 시스템에는 알바몬 지원 메일 본문(표)만 보낸다.
const GW_MAIL_DEFAULT = 'https://mail.willvi.co.kr/mail/link/emlMail/emlMailMain.do';
const GW_EVERY_MS = 5 * 60 * 1000;
const GW_MAX_PER_SCAN = 40;
const SEEN_CAP = 3000;

async function openTab(url) {
  const tab = await chrome.tabs.create({ url, active: false });
  await waitLoaded(tab.id);
  return tab;
}

// 그룹웨어 로그인 화면이면 저장된 아이디·비밀번호를 입력한다. 반환: 'ok' | 'login_failed'
function pageLogin(id, pw) {
  const idEl = document.querySelector('#cmmLogin_userId');
  const pwEl = document.querySelector('#cmmLogin_pwd');
  if (!idEl || !pwEl) return 'nologin';
  const set = (el, v) => { el.focus(); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
  set(idEl, id); set(pwEl, pw);
  const btn = document.querySelector('#cmmLogin_login');
  if (btn) btn.click(); else pwEl.form && pwEl.form.submit();
  return 'submitted';
}

// 메일 목록에서 알바몬 발신 메일을 찾는다
function pageHasLogin() { return !!document.querySelector('#cmmLogin_userId'); }

function pageListMails() {
  const out = [];
  let total = 0;
  for (const u of document.querySelectorAll('ul.mail_list')) {
    const li = u.closest('li');
    if (li) total++;
    if (!li || !/mailmaster@albamon\.com/.test(li.innerHTML)) continue;
    const inp = li.querySelector('input[name=key]');
    const a = li.querySelector('.subject a[data-mailbox-id]');
    if (inp && a) out.push({ id: inp.value, mb: a.getAttribute('data-mailbox-id') });
  }
  return { total, mails: out };
}

// 메일 본문을 화면을 열지 않고 그룹웨어의 메일 보기 API 로 바로 받아 온다(메일당 약 0.1초).
// 이미 로그인된 이 탭의 쿠키를 그대로 쓴다. 반환: [{ id, html }]
async function pageFetchBodies(mails) {
  const out = [];
  let next = 0;
  const one = async (m) => {
    try {
      const url = '/mail/data/emlMail/selectMailView.do?_=' + Date.now() + '&mode=view&mailType=all&searchField=&mailboxId=' + encodeURIComponent(m.mb) +
        '&pageSize=30&startDt=&endDt=&mailId=' + encodeURIComponent(m.id) + '&isLazy=Y&keyword=';
      const j = await (await fetch(url, { credentials: 'include' })).json();
      const c = j && j.mailList && j.mailList[0] && j.mailList[0].emlMessageVo && j.mailList[0].emlMessageVo.content;
      out.push({ id: m.id, html: typeof c === 'string' ? c : '' });
    } catch { out.push({ id: m.id, html: null }); }   // null = 받지 못함(다음에 다시 시도)
  };
  const worker = async () => { while (next < mails.length) await one(mails[next++]); };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return out;
}

async function exec(tabId, func, args = []) {
  const [r] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return r && r.result;
}

// 반환: null(이번에는 확인하지 않음) | { text, level }
async function scanGroupware(cfg, force) {
  if (!cfg.gwId || !cfg.gwPw || cfg.gwOn === false) return null;
  if (cfg.gwBlocked) return { level: 'error', text: '그룹웨어 로그인 정보 확인이 필요해요(이전 로그인 실패). 계정이 잠기지 않도록 자동으로 다시 시도하지 않아요. 수신함 화면에서 아이디·비밀번호를 다시 저장해 주세요.' };
  const last = (await chrome.storage.local.get('gwLastScan')).gwLastScan || 0;
  if (!force && Date.now() - last < GW_EVERY_MS) return null;
  const base = cfg.gwMailUrl || GW_MAIL_DEFAULT;
  await chrome.storage.local.set({ gwLastScan: Date.now() });
  const who = String(cfg.gwId).split('@')[0].trim();
  if (cfg.gwForceLogin) { await clearGwCookies(cfg); await chrome.storage.local.set({ gwForceLogin: false }); }

  let tab = await openTab(base);
  try {
    // 로그인 화면이면 입력한다(최대 2번 시도)
    for (let i = 0; i < 2; i++) {
      await sleep(800);
      // 첫 번째에만 로그인을 시도한다. 두 번째에도 로그인 화면이면 실패로 보고 멈춘다(계정 잠김 방지).
      if (i === 1) {
        if (!(await exec(tab.id, pageHasLogin).catch(() => false))) break;
        await chrome.storage.local.set({ gwBlocked: true });
        return { level: 'error', text: '그룹웨어 로그인이 안 돼요. 아이디 또는 비밀번호가 맞는지 확인하고, 수신함 화면에서 다시 저장해 주세요. (그룹웨어를 직접 열어 같은 아이디·비밀번호로 로그인되는지도 확인해 보세요.) 계정 잠김을 막으려고 자동으로 다시 시도하지 않아요.' };
      }
      const st = await exec(tab.id, pageLogin, [String(cfg.gwId).split('@')[0].trim(), cfg.gwPw]).catch(() => 'error');
      if (st === 'nologin') break;
      // 로그인 뒤 화면이 바뀔 때까지 기다린다
      await new Promise((r) => setTimeout(r, 400));
      await waitLoaded(tab.id);
      await sleep(1500);
      await chrome.tabs.update(tab.id, { url: base });
      await waitLoaded(tab.id);
    }
    // 메일 목록은 화면이 열린 뒤에 채워진다: 보일 때까지 짧게 확인한다(최대 10초)
    let list = { total: 0, mails: [] };
    for (let i = 0; i < 25 && !list.total; i++) {
      list = (await exec(tab.id, pageListMails).catch(() => null)) || { total: 0, mails: [] };
      if (!list.total) await sleep(400);
    }
    if (!list.total) return { level: 'warn', text: '그룹웨어 메일함 목록을 읽지 못했어요. 메일함이 비어 있거나, 느리거나, 화면이 바뀌었을 수 있어요. 5분 뒤 다시 확인해요.' };
    const mails = list.mails;
    if (!mails.length) return { level: 'ok', text: `그룹웨어(${who}) 확인 완료: 메일 ${list.total}통 중 알바몬 지원 메일이 없어요.` };
    const seenArr = (await chrome.storage.local.get('gwSeen')).gwSeen || [];
    const seen = new Set(seenArr);
    const todo = mails.filter((m) => !seen.has(m.id)).slice(0, GW_MAX_PER_SCAN);
    if (!todo.length) return { level: 'ok', text: `그룹웨어(${who}) 확인 완료: 알바몬 지원 메일 ${mails.length}통, 새 메일은 없어요.` };
    let added = 0, dup = 0, skipped = 0, failed = 0;
    if (todo.length) await setStatus(`그룹웨어 메일 ${todo.length}건 읽는 중…`);
    const bodies = (await exec(tab.id, pageFetchBodies, [todo]).catch(() => [])) || [];
    for (const b of bodies) {
      if (b.html === null) { failed++; continue; }   // 못 받은 건은 기억하지 않아서 다음 확인 때 다시 시도
      if (!b.html) { skipped++; seen.add(b.id); continue; }
      const r = await (await api(cfg, '/api/agent/mail', { method: 'POST', body: JSON.stringify({ html: b.html }) })).json();
      seen.add(b.id);
      if (r.ok) { if (r.duplicate) dup++; else added++; } else skipped++;
    }
    await chrome.storage.local.set({ gwSeen: [...seen].slice(-SEEN_CAP) });
    if (failed && failed === bodies.length) return { level: 'error', text: `그룹웨어 메일 ${failed}건의 내용을 받지 못했어요. 그룹웨어 로그인이 풀렸거나 화면 구조가 바뀌었을 수 있어요. 다음 확인 때 다시 시도해요.` };
    return { level: failed ? 'warn' : 'ok', text: `그룹웨어(${who}) 메일 ${added}건 새로 가져왔어요${dup ? `(이미 있는 ${dup}건)` : ''}${skipped ? `, 지원 메일이 아니어서 건너뜀 ${skipped}건` : ''}${failed ? `, 받지 못한 ${failed}건은 다음에 다시 시도` : ''}.` };
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function runContacts(cfg) {
  const q = await (await api(cfg, '/api/agent/inbox')).json();
  const items = (q.items || []).slice(0, MAX_PER_RUN);
  if (!items.length) return null;
  let ok = 0, fail = 0, dry = 0;
  let idx = 0;
  for (const item of items) {
    await setStatus(`처리 중… (${++idx}/${items.length})`);
    const r = await processItem(cfg, item);
    if (r.stop === 'login') return { level: 'error', text: '알바몬 로그인이 필요해요. 이 크롬에서 알바몬(기업회원)에 로그인한 뒤 다시 "연락처 가져오기"를 눌러 주세요.' };
    if (r.ok) ok++; else if (r.dry) dry++; else fail++;
    if (r.stop === 'deduct') return { level: 'error', text: '이용권 차감·결제 확인 창이 떠서 멈췄어요. 알바몬 화면에서 직접 확인해 주세요.' };
    await sleep(2500 + Math.random() * 3500);
  }
  if (dry) return { level: 'ok', text: `시험 실행: ${dry}건에서 연락처 보기 버튼을 찾았어요.` };
  return { level: fail ? (ok ? 'warn' : 'error') : 'ok', text: `연락처 ${ok}건 채웠어요${fail ? `, ${fail}건은 못 채웠어요(이유는 수신함의 해당 줄에 적혀 있어요)` : ''}.` };
}

async function run(force = false) {
  if (running && Date.now() - runningSince < 5 * 60 * 1000) return;
  running = true;
  runningSince = Date.now();
  try {
    const cfg = await chrome.storage.local.get(['serverUrl', 'agentToken', 'dry', 'gwId', 'gwPw', 'gwOn', 'gwMailUrl', 'gwBlocked', 'gwForceLogin', 'gwCookieDomain']);
    if (!cfg.agentToken) { await setStatus('연결 키가 없어요. 문자 관리 시스템의 수신함을 한 번 열면 자동으로 연결돼요.', 'error'); return; }
    cfg.serverUrl = (cfg.serverUrl || 'https://interview.bigbears.me').replace(/\/+$/, '');
    const parts = [];
    let level = 'ok';
    const add = (r) => { if (r) { parts.push(r.text); level = worst(level, r.level); } };
    try { add(await scanGroupware(cfg, force)); } catch (e) { add({ level: 'error', text: '그룹웨어 메일을 가져오지 못했어요: ' + e.message }); }
    try { add(await runContacts(cfg)); } catch (e) { add({ level: 'error', text: '연락처 가져오기가 멈췄어요: ' + e.message }); }
    await setStatus(parts.length ? parts.join(' ') : '새로 처리할 것이 없어요.', parts.length ? level : 'ok');
  } catch (e) {
    await setStatus('멈췄어요: ' + e.message, 'error');
  } finally {
    running = false;
  }
}

// ---- 수신함 화면과의 연결(bridge.js) ----
// 화면에서 보낸 그룹웨어 계정·연결 키를 이 PC의 확장 저장소에만 넣는다. 비밀번호는 화면으로 돌려주지 않는다.
async function bridgeState() {
  const s = await chrome.storage.local.get(['agentToken', 'gwId', 'gwPw', 'gwOn', 'lastStatus', 'lastLevel', 'gwBlocked']);
  return { hasKey: !!s.agentToken, gwId: s.gwId || '', hasPw: !!s.gwPw, blocked: !!s.gwBlocked, gwOn: s.gwOn !== false && !!s.gwId, lastStatus: s.lastStatus || '', lastLevel: s.lastLevel || 'info', version: chrome.runtime.getManifest().version };
}
async function senderAllowed(sender) {
  try {
    const o = new URL(sender.url || sender.tab?.url || '').origin;
    const cfg = await chrome.storage.local.get('serverUrl');
    const mine = cfg.serverUrl ? new URL(cfg.serverUrl).origin : 'https://interview.bigbears.me';
    return o === mine || o === 'https://interview.bigbears.me';
  } catch { return false; }
}
chrome.runtime.onMessage.addListener((m, sender, send) => {
  if (!m || (m.type !== 'bridge-state' && m.type !== 'bridge-save')) return false;
  (async () => {
    if (!(await senderAllowed(sender))) return send({});
    if (m.type === 'bridge-save') await saveConfig(m.patch || {}, new URL(sender.url).origin);
    send(await bridgeState());
  })();
  return true;
});

chrome.runtime.onInstalled.addListener(() => chrome.alarms.create(ALARM, { periodInMinutes: 1 }));
chrome.runtime.onStartup.addListener(() => chrome.alarms.create(ALARM, { periodInMinutes: 1 }));
chrome.alarms.onAlarm.addListener((a) => { if (a.name === ALARM) run(false); });
chrome.runtime.onMessage.addListener((m, sender, send) => {
  if (m && m.type === 'run') run(true);
  if (m && m.type === 'popup-save' && sender.id === chrome.runtime.id) { saveConfig(m.patch || {}, '').then(() => send(true)); return true; }
  return false;
});
