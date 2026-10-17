// 문자 관리 시스템 - 연락처 가져오기 (크롬 확장)
//  - 수신함에서 [연락처 가져오기]를 누른 건만 처리한다.
//  - 이 크롬의 알바몬 로그인 상태를 그대로 쓴다. 알바몬 아이디·비밀번호는 읽지도 저장하지도 않는다.
//  - 이용권 차감·결제 확인 창이 보이면 누르지 않고 멈춘다.
//  - (v1.7) 관리자가 시스템에 알바몬 계정을 여러 개 등록하면, 관리자 확장이 계정을 바꿔 가며 모든 담당자의 요청을 처리한다.
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
// 알바몬 이력서는 화면이 늦게 그려지고 번호도 눌러야 늦게 나타난다. 그래서 고정 시간만 기다리지 않고 "보일 때까지" 짧게 확인하며 기다린다.
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
  const DEDUCT = /(차감|이용권|열람권|포인트|결제|구매|사용하시겠|유료|잔여|캐시|상품)/;
  const GONE = /(삭제된 이력서|존재하지 않는|찾을 수 없|열람 기간|열람기간|기간이 만료|비공개)/;
  const pats = [/(연락처|전화번호|휴대폰|핸드폰|휴대전화).{0,6}(보기|확인|열람|조회)/, /(보기|확인|열람|조회).{0,6}(연락처|전화번호|휴대폰|핸드폰)/];
  const findReveal = () => {
    const els = [...document.querySelectorAll('button,a,[role=button],span,div,li,label')];
    const hit = els.filter((e) => {
      const t = (e.innerText || '').replace(/\s+/g, ' ').trim();
      return t && t.length <= 24 && visible(e) && pats.some((re) => re.test(t));
    });
    return hit.find((e) => !hit.some((o) => o !== e && e.contains(o))) || hit[0] || null;
  };
  const labels = () => [...new Set([...document.querySelectorAll('button,[role=button],input[type=button],input[type=submit]')].filter(visible)
    .map((e) => (e.innerText || e.value || '').replace(/\s+/g, ' ').trim()).filter((t) => t && t.length <= 14))].slice(0, 10);
  const dialogs = () => [...document.querySelectorAll('dialog[open],[role=dialog],[role=alertdialog],.modal,.popup,.layer,[class*=modal],[class*=popup],[class*=layer]')].filter(visible);
  const loginNow = () => { const pw = document.querySelector('input[type=password]'); return (pw && visible(pw)) || /user-account\/login|\/login/i.test(location.href); };

  // 1) 화면이 준비될 때까지(최대 15초): 로그인 화면 / 번호가 이미 보임 / 연락처 보기 버튼 / 이력서 없음 안내
  const start = Date.now();
  let phone = '', el = null;
  for (;;) {
    if (loginNow()) return { state: 'login' };
    const t = text();
    phone = pickPhone(t);
    if (phone) break;
    el = findReveal();
    if (el) break;
    if (Date.now() - start > 3000 && GONE.test(t)) return { state: 'gone' };
    if (Date.now() - start > 10000) return { state: 'nobutton', labels: labels() };
    await sleepP(150);
  }
  const before = text();
  const urlOk = location.href.includes(item.apply_no);
  const nameOk = nameMatches(before, item.name);

  // 2) 번호가 이미 보이면 누르지 않는다. 아니면 눌러서 번호가 보일 때까지(최대 12초) 기다린다.
  if (!phone) {
    if (dry) return { state: 'dry' };
    el.click();
    const t0 = Date.now();
    let confirmed = false, retried = false;
    for (;;) {
      await sleepP(150);
      const t = text();
      phone = pickPhone(t);
      if (phone) break;
      const dlg = dialogs();
      const dtext = dlg.map((e) => e.innerText || '').join(' ');
      if (DEDUCT.test(dtext)) return { state: 'deduct' };
      // 이용권과 상관없는 "연락처를 확인하시겠어요?" 같은 확인 창이면 확인을 한 번 눌러 준다
      if (!confirmed && dlg.length && /연락처|전화번호|휴대폰/.test(dtext)) {
        const ok = dlg.flatMap((d) => [...d.querySelectorAll('button,[role=button],a')]).find((b) => visible(b) && /^(확인|예|열람|보기|계속)$/.test((b.innerText || '').trim()));
        if (ok) { ok.click(); confirmed = true; continue; }
      }
      // 4초 동안 아무 변화가 없으면 한 번 더 누른다
      if (!retried && Date.now() - t0 > 3000 && t === before) { el.click(); retried = true; }
      if (Date.now() - t0 > 12000) return { state: 'nophone', labels: labels() };
    }
  }
  if (!urlOk && !nameOk && !nameMatches(text(), item.name)) return { state: 'mismatch' };
  return { state: 'ok', phone };
}

const NOTES = {
  nobutton: '연락처 보기 버튼을 찾지 못했어요(10초 기다렸어요).',
  nophone: '버튼을 눌렀지만 전화번호가 보이지 않았어요(12초 기다렸어요).',
  gone: '이력서를 찾을 수 없어요(삭제되었거나 열람 기간이 지났을 수 있어요).',
  mismatch: '이력서가 맞는지 확인하지 못했어요(이름·지원 번호가 화면에 없어요).',
  deduct: '결제·이용권 확인 창이 떠서 멈췄어요. 알바몬 화면에서 직접 확인해 주세요.'
};

// 이력서 한 건을 열어 읽는다(결과는 보내지 않는다). 반환: pageRead 결과 { state, phone?, labels? } 또는 { state:'error', note }
async function readItem(cfg, item) {
  const tab = await chrome.tabs.create({ url: item.resume_url, active: false });
  try {
    // 화면 안의 번호·버튼은 pageRead 가 "보일 때까지" 기다리므로, 모든 자원(이미지 등)이 끝나길 기다리지 않고 최대 3초만 기다린 뒤 바로 읽기 시작한다.
    // 이동(리다이렉트)이 아직 진행 중이라 화면이 바뀌면서 읽기가 끊기면 조금 뒤 다시 시도한다.
    await waitLoaded(tab.id, 3000);
    const started = Date.now();
    for (;;) {
      try {
        const [res] = await withTimeout(chrome.scripting.executeScript({ target: { tabId: tab.id }, func: pageRead, args: [{ name: item.name, apply_no: item.apply_no }, !!cfg.dry] }), Math.max(ITEM_TIMEOUT - (Date.now() - started), 1000), 'timeout');
        return (res && res.result) || { state: 'nobutton' };
      } catch (e) {
        if (e.message === 'timeout' || Date.now() - started > ITEM_TIMEOUT - 5000) throw e;
        await sleep(250);
      }
    }
  } catch (e) {
    return { state: 'error', note: '이력서 화면을 읽지 못했어요(' + (e.message === 'timeout' ? '시간 초과' : '화면 접근 오류') + ').' };
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

// 결과를 시스템에 보낸다. acct: 어느 알바몬 계정으로 열었는지(여러 계정일 때, 공고→계정 학습용)
async function reportItem(cfg, item, r, acct = null, prefix = '') {
  if (r.state === 'ok') {
    await api(cfg, `/api/agent/inbox/${item.id}/result`, { method: 'POST', body: JSON.stringify({ ok: true, phone: r.phone, note: '', account_id: acct ? acct.id : undefined }) });
    return { ok: true };
  }
  const hint = r.labels && r.labels.length ? ` (화면 버튼: ${r.labels.join(', ')})` : '';
  await api(cfg, `/api/agent/inbox/${item.id}/result`, { method: 'POST', body: JSON.stringify({ ok: false, phone: '', note: (prefix + (r.note || NOTES[r.state] || '알 수 없는 이유로 실패했어요.') + hint).slice(0, 190) }) });
  return { stop: r.state === 'deduct' ? 'deduct' : '', failed: true };
}

async function processItem(cfg, item) {
  const r = await readItem(cfg, item);
  if (r.state === 'login') return { stop: 'login' };
  if (r.state === 'dry') return { dry: true };
  if (cfg.dry && r.state === 'error') return { dry: false, failed: true };
  return reportItem(cfg, item, r);
}

// ---------------- 그룹웨어 계정(여러 개) ----------------
// 계정은 이 PC 크롬(chrome.storage.local)에만 저장한다. 문자 관리 시스템에는 아이디만 알리고 비밀번호는 보내지 않는다.
// 한 사람이 여러 그룹웨어 메일함(여러 계정)을 등록해 한 수신함에서 받을 수 있다.
//   gwAccounts: [{ id, pw, on, blocked, force, seen[], last:{text,level,at} }]
const MAX_ACCOUNTS = 5;
const acctKey = (id) => String(id || '').split('@')[0].trim().toLowerCase();

async function getAccounts() {
  const s = await chrome.storage.local.get(['gwAccounts', 'gwId', 'gwPw', 'gwOn', 'gwSeen', 'gwBlocked', 'gwForceLogin']);
  if (Array.isArray(s.gwAccounts)) return s.gwAccounts;
  if (s.gwId) {   // 예전 버전(계정 1개) 저장값을 옮긴다
    const a = [{ id: s.gwId, pw: s.gwPw || '', on: s.gwOn !== false, blocked: !!s.gwBlocked, force: !!s.gwForceLogin, seen: s.gwSeen || [], last: null }];
    await chrome.storage.local.set({ gwAccounts: a });
    await chrome.storage.local.remove(['gwId', 'gwPw', 'gwOn', 'gwSeen', 'gwBlocked', 'gwForceLogin']);
    return a;
  }
  return [];
}
const putAccounts = (list) => chrome.storage.local.set({ gwAccounts: list });
async function updateAccount(key, fn) {
  const list = await getAccounts();
  const a = list.find((x) => acctKey(x.id) === key);
  if (a) { fn(a); await putAccounts(list); }
}

// ---------------- 그룹웨어 비밀번호 확인 ----------------
// 이 크롬이 이미 그룹웨어에 로그인되어 있으면 저장한 비밀번호와 상관없이 메일함이 열려, 틀린 비밀번호도 모르고 지나간다.
// 그래서 저장할 때 그룹웨어의 로그인 확인 요청을 쿠키 없이(세션을 만들지 않고) 한 번 보내 맞는지 확인한다.
// 주의: 그룹웨어는 비밀번호를 여러 번(예: 5번) 틀리면 계정을 잠글 수 있다. 그래서 틀리면 자동으로 다시 시도하지 않고, 새로 저장할 때만 확인한다.
const GW_LOGIN_BASE_DEFAULT = 'https://gw.willvi.co.kr';
async function verifyGwLogin(acct, loginBase) {
  const base = (loginBase || GW_LOGIN_BASE_DEFAULT).replace(/\/+$/, '');
  const host = new URL(base).host;
  const id = acctKey(acct.id);
  const H = { 'Content-Type': 'application/json;charset=UTF-8', Accept: 'application/json' };
  try {
    const dr = await fetch(`${base}/gw/data/common/login/selectDepartmentList.do?_=${Date.now()}t`, {
      method: 'POST', credentials: 'omit', headers: H, body: JSON.stringify({ deptId: '', langCode: 'ko', gwUrl: host, userId: id, pwd: '', sec: '' })
    });
    const depts = await dr.json();
    const d = Array.isArray(depts) ? (depts.find((x) => x.reprsntDeptYn === 'Y') || depts[0]) : null;
    const r = await fetch(`${base}/gw/data/common/login/selectLoginFlag.do?lang=ko&_=${Date.now()}t`, {
      method: 'POST', credentials: 'omit', headers: H, body: JSON.stringify({ deptId: d ? d.deptId : '', langCode: 'ko', gwUrl: host, userId: id, pwd: acct.pw, sec: '', token: null })
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

// 설정 저장(수신함 화면·팝업 공통).
//  patch.account {id, pw}  계정 추가·수정(저장 전에 비밀번호를 확인한다)   patch.removeAccount id   patch.toggleAccount {id, on}
//  (예전 형식 patch.gwId / patch.gwPw 는 첫 번째 계정으로 본다)
async function saveConfig(p, origin) {
  const set = {};
  if (p.agentToken) set.agentToken = p.agentToken;
  if (typeof p.dry === 'boolean') set.dry = p.dry;
  if (typeof p.gwLimit === 'number' && p.gwLimit >= 0) set.gwLimit = Math.min(Math.round(p.gwLimit), 5000);
  if (typeof p.serverUrl === 'string' && p.serverUrl) set.serverUrl = p.serverUrl;
  const acc = p.account && p.account.id ? p.account : (typeof p.gwId === 'string' && p.gwId ? { id: p.gwId, pw: p.gwPw || '', first: true } : null);
  if (!set.serverUrl && origin && (set.agentToken || acc)) set.serverUrl = origin;
  if (Object.keys(set).length) await chrome.storage.local.set(set);
  const base = (await chrome.storage.local.get('gwLoginBase')).gwLoginBase;
  let list = await getAccounts();
  let touched = false;

  if (typeof p.removeAccount === 'string') {
    const k = acctKey(p.removeAccount);
    list = list.filter((a) => acctKey(a.id) !== k); touched = true;
    await putAccounts(list);
    await setStatus(list.length ? `그룹웨어 계정 ${k}을(를) 지웠어요.` : '그룹웨어 계정을 모두 지웠어요. 메일을 가져오려면 계정을 추가해 주세요.', 'ok');
  }
  if (p.toggleAccount && p.toggleAccount.id) {
    await updateAccount(acctKey(p.toggleAccount.id), (a) => { a.on = !!p.toggleAccount.on; });
    touched = true;
  }
  if (acc) {
    const key = acctKey(acc.id);
    const exist = list.find((a) => acctKey(a.id) === key);
    const pw = acc.pw || (exist && exist.pw) || '';
    if (!pw) { await setStatus('그룹웨어 비밀번호를 입력해 주세요.', 'error'); return; }
    if (!exist && !acc.first && list.length >= MAX_ACCOUNTS) { await setStatus(`그룹웨어 계정은 최대 ${MAX_ACCOUNTS}개까지 등록할 수 있어요.`, 'error'); return; }
    await setStatus(`그룹웨어 계정(${key})을 확인하는 중…`, 'info');
    const v = await verifyGwLogin({ id: acc.id, pw }, base);
    const entry = { id: acc.id.trim(), pw, on: true, blocked: !v.ok, force: v.ok, seen: exist ? exist.seen || [] : [],
      last: { text: v.ok ? '로그인 확인됨' : gwFailText(v), level: v.ok ? 'ok' : 'error', at: Date.now() } };
    list = await getAccounts();
    if (acc.first && list.length && !exist) list[0] = entry;       // 예전 형식: 첫 번째 계정을 바꾼다
    else { const i = list.findIndex((a) => acctKey(a.id) === key); if (i >= 0) list[i] = entry; else list.push(entry); }
    await putAccounts(list);
    if (!v.ok) { await setStatus(`[${key}] ${gwFailText(v)}`, 'error'); return; }
    touched = true;
  }
  if (touched || set.agentToken || set.gwLimit !== undefined) setTimeout(() => run(true), 300);
}

// ---------------- 그룹웨어 로그인 쿠키 보관·복원 ----------------
// 이 크롬에는 그룹웨어 로그인(쿠키)이 하나뿐이다. 계정을 바꿔 가며 읽으려면 쿠키를 잠깐 바꿔야 하므로,
// 읽기 전에 내 쿠키를 보관해 두었다가 끝나면 그대로 되돌린다. (보관본은 확장 프로그램이 꺼졌다 켜져도 복원되도록 세션 저장소에도 둔다)
async function clearGwCookies(domain) {
  const list = await chrome.cookies.getAll({ domain });
  for (const c of list) {
    const url = (c.secure ? 'https://' : 'http://') + c.domain.replace(/^\./, '') + c.path;
    await chrome.cookies.remove({ url, name: c.name, storeId: c.storeId }).catch(() => {});
  }
}
async function restoreGwCookies(domain, snap) {
  await clearGwCookies(domain);
  for (const c of snap || []) {
    const d = { url: (c.secure ? 'https://' : 'http://') + c.domain.replace(/^\./, '') + c.path, name: c.name, value: c.value, path: c.path, secure: c.secure, httpOnly: c.httpOnly, storeId: c.storeId };
    if (!c.hostOnly) d.domain = c.domain;
    if (c.sameSite && c.sameSite !== 'unspecified') d.sameSite = c.sameSite;
    if (!c.session && c.expirationDate) d.expirationDate = c.expirationDate;
    await chrome.cookies.set(d).catch(() => {});
  }
}
async function recoverGwSwap() {
  try {
    const s = await chrome.storage.session.get('gwSwap');
    if (s.gwSwap) { await restoreGwCookies(s.gwSwap.domain, s.gwSwap.snap); await chrome.storage.session.remove('gwSwap'); }
  } catch { /* ignore */ }
}
recoverGwSwap();   // 확장이 읽는 도중에 꺼졌다면 켜질 때 내 로그인 쿠키를 되돌린다

// ---------------- 그룹웨어 메일에서 알바몬 지원 메일 가져오기 ----------------
// 그룹웨어 아이디·비밀번호는 이 PC 크롬(chrome.storage.local)에만 저장하고, 그룹웨어 로그인 화면에만 입력한다.
// 문자 관리 시스템으로는 보내지 않는다. 시스템에는 알바몬 지원 메일 본문(표)만 보낸다.
const GW_MAIL_DEFAULT = 'https://mail.willvi.co.kr/mail/link/emlMail/emlMailMain.do';
const GW_EVERY_MS = 5 * 60 * 1000;
const GW_MAX_PER_SCAN = 1000;   // 한 번에 읽는 최대 건수(남은 것은 다음 확인 때 이어서)
const GW_CHUNK = 50;            // 이만큼씩 받아서 시스템에 넣고 중간 저장
const SEEN_CAP = 6000;

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

// 알바몬이 보낸 메일 목록을 그룹웨어의 메일 목록 API 로 쪽마다 받아 온다(최신 순). limit: 최근 몇 통까지(0 = 전부, 최대 5000통).
// 이미 로그인된 이 탭의 쿠키를 그대로 쓴다. 반환: { total, mails:[{id, mb}], error }
async function pageListAlbamon(limit) {
  const PAGE = 100, HARD = 5000;
  const want = limit > 0 ? Math.min(limit, HARD) : HARD;
  const mails = [];
  let total = 0;
  try {
    for (let pageNo = 1; mails.length < want; pageNo++) {
      const r = await fetch('/mail/data/emlMail/selectMailList.do?_=' + Date.now() + 't', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isLazy: 'N', boxCode: 'recv', pageNo: String(pageNo), pageSize: String(PAGE), mailType: 'all', searchField: 'mailFrom', keyword: 'mailmaster@albamon.com', startDt: null, endDt: null })
      });
      const j = await r.json();
      const list = Array.isArray(j.mailList) ? j.mailList : [];
      total = Number(j.totalCount) || total;
      for (const m of list) if (m && m.mailId && m.mailboxId) mails.push({ id: m.mailId, mb: m.mailboxId });
      if (list.length < PAGE) break;
    }
  } catch { return { total, mails: mails.slice(0, want), error: true }; }
  if (!mails.length) {
    // 알바몬 메일이 0통일 때: 정말 없는 건지, 로그인이 풀려 빈 응답이 온 건지 구분한다(받은 메일함 전체 수를 본다)
    try {
      const r = await fetch('/mail/data/emlMail/selectMailList.do?_=' + Date.now() + 't', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isLazy: 'N', boxCode: 'recv', pageNo: '1', pageSize: '1', mailType: 'all', searchField: '', keyword: '', startDt: null, endDt: null })
      });
      const j = await r.json();
      if (!(Number(j.totalCount) > 0)) return { total, mails: [], error: true };
    } catch { return { total, mails: [], error: true }; }
  }
  return { total, mails: mails.slice(0, want) };
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

// 계정 하나의 메일함을 읽는다. 반환: { text, level }
async function scanAccount(cfg, acct) {
  const key = acctKey(acct.id);
  const base = cfg.gwMailUrl || GW_MAIL_DEFAULT;
  const record = (r) => updateAccount(key, (a) => { a.last = { text: r.text, level: r.level, at: Date.now() }; });
  // 메일 화면 전체는 무거워서(수 초) 열지 않는다. 같은 주소(origin)의 가벼운 페이지에서 API 만 호출한다.
  const light = new URL(base).origin + '/robots.txt';
  const limit = Number(cfg.gwLimit) || 0;
  const tab = await openTab(light);
  try {
    let list = (await exec(tab.id, pageListAlbamon, [limit]).catch(() => null)) || { total: 0, mails: [], error: true };
    if (list.error) {
      // 로그인이 풀렸거나, 이 크롬에 로그인(또는 메일 쪽 연결)이 아직 없다 → 메일 화면을 열어 필요하면 로그인한다.
      // 로그인은 계정당 한 번만 시도한다(계정 잠김 방지).
      await chrome.tabs.update(tab.id, { url: base });
      await waitLoaded(tab.id, 8000);
      const loginUrl = (await chrome.tabs.get(tab.id).catch(() => ({}))).url || base;
      const st = await exec(tab.id, pageLogin, [key, acct.pw]).catch(() => 'error');
      if (st === 'submitted') {
        // 로그인 뒤 화면에 도착할 때까지 기다린다(틀린 비밀번호면 주소가 바뀌지 않는다)
        for (let i = 0; i < 60; i++) {
          await sleep(150);
          const t = await chrome.tabs.get(tab.id).catch(() => null);
          if (t && t.url && t.url !== loginUrl && !/login/i.test(t.url) && t.status === 'complete') break;
        }
        await chrome.tabs.update(tab.id, { url: base });   // 메일 화면을 한 번 열어 메일 쪽 로그인 연결을 끝낸다(처음 한 번만)
        await waitLoaded(tab.id, 8000);
      }
      list = (await exec(tab.id, pageListAlbamon, [limit]).catch(() => null)) || { total: 0, mails: [], error: true };
      if (list.error && st === 'submitted') {
        const r = { level: 'error', text: `그룹웨어(${key}) 로그인이 안 돼요. 아이디 또는 비밀번호가 맞는지 확인하고, 수신함 화면에서 다시 저장해 주세요. 계정 잠김을 막으려고 자동으로 다시 시도하지 않아요.` };
        await updateAccount(key, (a) => { a.blocked = true; });
        await record(r);
        return r;
      }
      // 로그인 화면이 아닌데도 목록을 못 읽었으면 아래에서 "목록을 읽지 못했어요"로 알린다
    }
    // 알바몬 지원 메일 목록(설정한 양만큼, 최신 순)은 위에서 받아 왔다
    const scope = limit > 0 ? `최근 ${limit}통` : '전부';
    let res;
    if (list.error && !list.mails.length) {
      res = { level: 'warn', text: `그룹웨어(${key}) 메일 목록을 읽지 못했어요. 로그인이 풀렸거나, 느리거나, 그룹웨어 화면이 바뀌었을 수 있어요. 5분 뒤 다시 확인해요.` };
    } else if (!list.mails.length) {
      res = { level: 'ok', text: `그룹웨어(${key}) 확인 완료: 알바몬 지원 메일이 없어요.` };
    } else {
      const seen = new Set(acct.seen || []);
      const todoAll = list.mails.filter((m) => !seen.has(m.id));
      if (!todoAll.length) {
        res = { level: 'ok', text: `그룹웨어(${key}) 확인 완료: 알바몬 지원 메일 ${list.mails.length}통(${scope}), 새 메일은 없어요.` };
      } else {
        const todo = todoAll.slice(0, GW_MAX_PER_SCAN);
        let added = 0, dup = 0, skipped = 0, failed = 0;
        for (let i = 0; i < todo.length; i += GW_CHUNK) {
          const chunk = todo.slice(i, i + GW_CHUNK);
          await setStatus(`그룹웨어(${key}) 메일 읽는 중… (${Math.min(i + chunk.length, todo.length)}/${todo.length})`);
          const bodies = (await exec(tab.id, pageFetchBodies, [chunk]).catch(() => [])) || [];
          for (const b of bodies) {
            if (b.html === null) { failed++; continue; }   // 못 받은 건은 기억하지 않아서 다음 확인 때 다시 시도
            if (!b.html) { skipped++; seen.add(b.id); continue; }
            const r = await (await api(cfg, '/api/agent/mail', { method: 'POST', body: JSON.stringify({ html: b.html, account: key }) })).json();
            seen.add(b.id);
            if (r.ok) { if (r.duplicate) dup++; else added++; } else skipped++;
          }
          await updateAccount(key, (a) => { a.seen = [...seen].slice(-SEEN_CAP); });   // 긴 작업 중 꺼져도 이어서 하도록 중간 저장
        }
        const rest = todoAll.length - todo.length;
        if (failed && failed === todo.length) res = { level: 'error', text: `그룹웨어(${key}) 메일 ${failed}건의 내용을 받지 못했어요. 그룹웨어 로그인이 풀렸거나 화면 구조가 바뀌었을 수 있어요. 다음 확인 때 다시 시도해요.` };
        else res = { added, level: failed ? 'warn' : 'ok', text: `그룹웨어(${key}) 알바몬 지원 메일 ${list.mails.length}통(${scope}) 중 ${added}건 새로 가져왔어요${dup ? `(이미 있는 ${dup}건)` : ''}${skipped ? `, 지원 메일이 아니어서 건너뜀 ${skipped}건` : ''}${failed ? `, 받지 못한 ${failed}건은 다음에 다시 시도` : ''}${rest ? `, 남은 ${rest}건은 다음 확인 때 이어서 가져와요` : ''}.` };
      }
    }
    await record(res);
    return res;
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

// 등록된 모든 계정을 차례로 읽는다. 반환: null(이번에는 확인하지 않음) | { text, level }
async function scanGroupware(cfg, force) {
  const accts = (await getAccounts()).filter((a) => a.on !== false && a.pw);
  if (!accts.length) return null;
  const results = [];
  const active = [];
  for (const a of accts) {
    if (a.blocked) results.push({ level: 'error', text: `그룹웨어(${acctKey(a.id)})는 비밀번호 확인이 필요해요. 계정이 잠기지 않도록 자동으로 다시 시도하지 않아요. 수신함 화면에서 다시 저장해 주세요.` });
    else active.push(a);
  }
  const last = (await chrome.storage.local.get('gwLastScan')).gwLastScan || 0;
  if (!force && Date.now() - last < GW_EVERY_MS) {   // 아직 확인할 때가 아니면, 막힌 계정이 있을 때만 그 안내를 계속 보여 준다
    return results.length ? { level: 'error', text: results.map((r) => r.text).join(' ') } : null;
  }
  await chrome.storage.local.set({ gwLastScan: Date.now() });
  const multi = active.length >= 2;
  const domain = cfg.gwCookieDomain || 'willvi.co.kr';
  let snap = null;
  if (multi) {   // 여러 계정을 읽는 동안 내 그룹웨어 로그인(쿠키)을 잠깐 바꾸므로, 먼저 보관하고 끝나면 되돌린다
    snap = await chrome.cookies.getAll({ domain });
    await chrome.storage.session.set({ gwSwap: { domain, snap } });
  }
  try {
    for (const a of active) {
      // 계정이 둘 이상이거나 새로 저장한 계정이면 이 크롬의 그룹웨어 로그인을 지우고 그 계정으로 로그인한다(엉뚱한 메일함 방지)
      if (multi || a.force) await clearGwCookies(domain);
      if (a.force) await updateAccount(acctKey(a.id), (x) => { x.force = false; });
      try { results.push(await scanAccount(cfg, a)); } catch (e) { results.push({ level: 'error', text: `그룹웨어(${acctKey(a.id)})를 가져오지 못했어요: ${e.message}` }); }
    }
  } finally {
    if (multi) { await restoreGwCookies(domain, snap); await chrome.storage.session.remove('gwSwap'); }
  }
  const level = results.reduce((w, r) => worst(w, r.level), 'ok');
  return { level, text: results.map((r) => r.text).join(' '), added: results.reduce((n, r) => n + (r.added || 0), 0) };
}

// ---------------- 알바몬 계정 여러 개 (관리자가 시스템에 등록) ----------------
// 관리자 확장만 계정 목록(비밀번호 포함)을 받는다. 계정마다 로그인 쿠키를 보관해 두었다가 바꿔 끼우고(매번 로그인하지 않게),
// 처음 보는 공고는 계정을 차례로 시도해 열리는 계정을 찾는다(시스템이 공고→계정을 기억해 다음부터 힌트로 준다).
// 처리하는 동안 이 크롬의 내 알바몬 로그인을 보관했다가 끝나면 되돌린다.
const AM_TRY_NEXT = new Set(['gone', 'nobutton', 'mismatch', 'nophone']);   // 다른 계정 공고일 때 보이는 상태
async function amCookieDomain(cfg) { return cfg.amCookieDomain || 'albamon.com'; }
async function recoverAmSwap() {
  try {
    const s = await chrome.storage.session.get('amSwap');
    if (s.amSwap) { await restoreGwCookies(s.amSwap.domain, s.amSwap.snap); await chrome.storage.session.remove('amSwap'); }
  } catch { /* ignore */ }
}
recoverAmSwap();

// 알바몬 로그인 화면에 아이디·비밀번호를 넣고 로그인을 누른다(화면 안에서 실행). 반환: 'submitted' | 'noform'
function pageAlbamonLogin(id, pw) {
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const tab = [...document.querySelectorAll('a,button,li,span,label,div')].find((e) => (e.innerText || '').trim() === '기업회원' && vis(e));
  if (tab) tab.click();
  const inputs = [...document.querySelectorAll('input')].filter(vis);
  const pwEl = inputs.find((e) => (e.type || '').toLowerCase() === 'password');
  const idEl = inputs.find((e) => ['text', 'email', 'tel', ''].includes((e.type || '').toLowerCase()) && e !== pwEl);
  if (!idEl || !pwEl) return 'noform';
  // React 등 화면 프레임워크가 값을 알아채도록 원래 setter 로 넣고 input 이벤트를 보낸다
  const set = (el, v) => { const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value'); el.focus(); d.set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
  set(idEl, id); set(pwEl, pw);
  const btn = [...document.querySelectorAll('button,input[type=submit],a')].filter(vis).find((e) => /^로그인$/.test((e.innerText || e.value || '').trim()));
  if (btn) btn.click(); else if (pwEl.form) pwEl.form.requestSubmit ? pwEl.form.requestSubmit() : pwEl.form.submit();
  return 'submitted';
}
function pageIsLogin() {
  const pw = document.querySelector('input[type=password]');
  const r = pw && pw.getBoundingClientRect();
  return !!(r && r.width > 0) || /user-account\/login|\/login/i.test(location.href);
}

// 이 계정으로 로그인한다(보관한 쿠키가 없거나 만료됐을 때). 반환: true/false
async function amLogin(cfg, acct) {
  const url = cfg.amLoginUrl || 'https://www.albamon.com/user-account/login?memberType=CORPORATION';
  await clearGwCookies(await amCookieDomain(cfg));
  const tab = await openTab(url);
  try {
    const sub = await exec(tab.id, pageAlbamonLogin, [acct.login_id, acct.pw]);
    if (sub !== 'submitted') return false;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      const t = await chrome.tabs.get(tab.id).catch(() => null);
      if (!t) return false;
      if (t.status !== 'complete') continue;
      const still = await exec(tab.id, pageIsLogin).catch(() => true);
      if (!still) {
        const sess = (await chrome.storage.local.get('amSess')).amSess || {};
        sess[acct.id] = await chrome.cookies.getAll({ domain: await amCookieDomain(cfg) });
        await chrome.storage.local.set({ amSess: sess });
        return true;
      }
    }
    return false;
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

// 이 계정의 보관 쿠키로 바꿔 끼운다(없으면 로그인)
async function amSwitch(cfg, acct) {
  const sess = (await chrome.storage.local.get('amSess')).amSess || {};
  if (sess[acct.id] && sess[acct.id].length) { await restoreGwCookies(await amCookieDomain(cfg), sess[acct.id]); return true; }
  return amLogin(cfg, acct);
}

// 여러 계정으로 연락처 가져오기. 반환: 상태 { level, text } 또는 null
async function runContactsMulti(cfg, accounts) {
  const t0 = Date.now();
  const domain = await amCookieDomain(cfg);
  const blocked = (await chrome.storage.local.get('amBlocked')).amBlocked || {};
  const usable = accounts.filter((a) => blocked[a.id] !== a.updated_at);   // 로그인 실패한 계정은 비밀번호를 바꿀 때까지 쉬게(잠김 방지)
  const notes = [];
  if (usable.length < accounts.length) notes.push({ level: 'error', text: `알바몬 계정 ${accounts.length - usable.length}개는 로그인이 안 돼서 쉬고 있어요. 시스템 연결 설정에서 비밀번호를 고쳐 주세요.` });
  if (!usable.length) return notes[0];
  let ok = 0, fail = 0, stop = null;
  const mine = await chrome.cookies.getAll({ domain });   // 내 알바몬 로그인 보관
  await chrome.storage.session.set({ amSwap: { domain, snap: mine } });
  try {
    for (let round = 0; round < 10 && !stop; round++) {
      const q = await (await api(cfg, '/api/agent/inbox?limit=20&all=1')).json();
      const items = q.items || [];
      if (!items.length) break;
      const known = new Set(usable.map((a) => a.id));
      const groups = new Map();
      let unknown = [];
      for (const it of items) {
        if (it.account_id && known.has(it.account_id)) { if (!groups.has(it.account_id)) groups.set(it.account_id, []); groups.get(it.account_id).push(it); }
        else unknown.push(it);
      }
      const order = [...usable].sort((a, b) => (groups.has(b.id) ? 1 : 0) - (groups.has(a.id) ? 1 : 0));
      const lastState = new Map();
      for (const acct of order) {
        if (stop) break;
        const work = [...(groups.get(acct.id) || []), ...unknown];
        if (!work.length) continue;
        await setStatus(`연락처 가져오는 중… (알바몬 계정 ${acct.label})`);
        if (!(await amSwitch(cfg, acct))) {
          blocked[acct.id] = acct.updated_at;
          await chrome.storage.local.set({ amBlocked: blocked });
          await api(cfg, '/api/agent/albamon-status', { method: 'POST', body: JSON.stringify({ account_id: acct.id, error: '알바몬 로그인 실패(아이디·비밀번호 확인)' }) }).catch(() => {});
          notes.push({ level: 'error', text: `알바몬 계정 "${acct.label}" 로그인이 안 돼요. 시스템 연결 설정에서 아이디·비밀번호를 확인해 주세요.` });
          unknown = work;   // 이 계정 몫은 다른 계정으로 시도
          continue;
        }
        const retry = [];
        let next = 0, relogged = false;
        const worker = async () => {
          while (!stop && next < work.length) {
            const it = work[next++];
            let r = await readItem(cfg, it);
            if (r.state === 'login' && !relogged) { relogged = true; if (await amLogin(cfg, acct)) r = await readItem(cfg, it); }
            if (r.state === 'ok') { await reportItem(cfg, it, r, acct); ok++; continue; }
            if (r.state === 'deduct') { await reportItem(cfg, it, r); fail++; stop = { level: 'error', text: '결제·이용권 확인 창이 떠서 멈췄어요. 알바몬 화면에서 직접 확인해 주세요.' }; return; }
            if (AM_TRY_NEXT.has(r.state) || r.state === 'login') { lastState.set(it.id, r); retry.push(it); continue; }
            await reportItem(cfg, it, r); fail++;
          }
        };
        await Promise.all(Array.from({ length: Math.min(CONTACT_CONCURRENCY, work.length) }, worker));
        // 쿠키가 갱신됐을 수 있으니 이 계정 보관본을 새로 저장
        const sess = (await chrome.storage.local.get('amSess')).amSess || {};
        sess[acct.id] = await chrome.cookies.getAll({ domain });
        await chrome.storage.local.set({ amSess: sess });
        unknown = retry;
      }
      // 모든 계정으로 열어 봐도 안 된 건
      for (const it of stop ? [] : unknown) {
        await reportItem(cfg, it, lastState.get(it.id) || { state: 'nobutton' }, null, `등록된 알바몬 계정 ${usable.length}개로 모두 열어 봤지만 안 됐어요: `);
        fail++;
      }
    }
  } finally {
    await restoreGwCookies(domain, mine);
    await chrome.storage.session.remove('amSwap');
  }
  if (stop) notes.push(stop);
  if (ok || fail) notes.push({ level: fail ? (ok ? 'warn' : 'error') : 'ok', text: `연락처 ${ok}건 채웠어요(알바몬 계정 ${usable.length}개, ${((Date.now() - t0) / 1000).toFixed(1)}초)${fail ? `, ${fail}건은 못 채웠어요(이유는 새 지원 카드에)` : ''}.` });
  if (!notes.length) return null;
  return { level: notes.reduce((w, n) => worst(w, n.level), 'ok'), text: notes.map((n) => n.text).join(' ') };
}

const CONTACT_CONCURRENCY = 4;   // 이력서 탭을 동시에 몇 개까지 열어 읽을지
async function runContacts(cfg) {
  // 관리자 확장이고 시스템에 알바몬 계정이 등록돼 있으면 여러 계정 방식으로(모든 담당자 요청)
  try {
    const am = await (await api(cfg, '/api/agent/albamon-accounts')).json();
    if (am.allowed && am.accounts && am.accounts.length && !cfg.dry) return runContactsMulti(cfg, am.accounts);
  } catch { /* 예전 시스템이거나 일시 오류면 기존 방식 */ }
  const t0 = Date.now();
  let ok = 0, fail = 0, dry = 0, done = 0, stop = null;
  // 요청이 있으면 20건씩 받아 4건씩 동시에 처리하고, 큐가 빌 때까지 이어서 한다(한 번에 최대 10번 = 200건)
  for (let round = 0; round < 10 && !stop; round++) {
    const q = await (await api(cfg, '/api/agent/inbox?limit=20')).json();
    const items = q.items || [];
    if (!items.length) break;
    let next = 0;
    const worker = async () => {
      while (!stop && next < items.length) {
        const item = items[next++];
        await setStatus(`연락처 가져오는 중… (${++done}번째)`);
        const r = await processItem(cfg, item);
        if (r.stop === 'login') { stop = { level: 'error', text: '알바몬 로그인이 필요해요. 이 크롬에서 알바몬(기업회원)에 로그인한 뒤 다시 "연락처 가져오기"를 눌러 주세요.' }; return; }
        if (r.ok) ok++; else if (r.dry) dry++; else fail++;
        if (r.stop === 'deduct') { stop = { level: 'error', text: '결제·이용권 확인 창이 떠서 멈췄어요. 알바몬 화면에서 직접 확인해 주세요.' }; return; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONTACT_CONCURRENCY, items.length) }, worker));
    if (dry) break;   // 시험 실행은 한 번만
  }
  if (stop) return stop;
  if (!done) return null;
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (dry) return { level: 'ok', text: `시험 실행: ${dry}건에서 연락처 보기 버튼을 찾았어요.` };
  return { level: fail ? (ok ? 'warn' : 'error') : 'ok', text: `연락처 ${ok}건 채웠어요(${secs}초)${fail ? `, ${fail}건은 못 채웠어요(이유는 새 지원 화면의 해당 카드에 적혀 있어요)` : ''}.` };
}

async function run(force = false) {
  if (running && Date.now() - runningSince < 5 * 60 * 1000) return;
  running = true;
  runningSince = Date.now();
  try {
    const cfg = await chrome.storage.local.get(['serverUrl', 'agentToken', 'dry', 'gwMailUrl', 'gwCookieDomain', 'gwLimit', 'amLoginUrl', 'amCookieDomain']);
    if (!cfg.agentToken) { await setStatus('연결 키가 없어요. 문자 관리 시스템의 수신함을 한 번 열면 자동으로 연결돼요.', 'error'); return; }
    cfg.serverUrl = (cfg.serverUrl || 'https://interview.bigbears.me').replace(/\/+$/, '');
    const parts = [];
    let level = 'ok';
    const add = (r) => { if (r) { parts.push(r.text); level = worst(level, r.level); } };
    const t0 = Date.now();
    const contacts = async () => { try { add(await runContacts(cfg)); } catch (e) { add({ level: 'error', text: '연락처 가져오기가 멈췄어요: ' + e.message }); } };
    await contacts();   // 사용자가 요청한 연락처 가져오기를 먼저(그룹웨어 확인을 기다리지 않는다)
    let gwAdded = 0;
    try { const g = await scanGroupware(cfg, force); if (g) { add(g); gwAdded = g.added || 0; } } catch (e) { add({ level: 'error', text: '그룹웨어 메일을 가져오지 못했어요: ' + e.message }); }
    if (gwAdded) await contacts();   // 새로 들어온 메일이 규칙으로 자동 요청됐을 수 있으니 바로 이어서
    await setStatus(parts.length ? `${parts.join(' ')} [총 ${((Date.now() - t0) / 1000).toFixed(1)}초]` : '새로 처리할 것이 없어요.', parts.length ? level : 'ok');
  } catch (e) {
    await setStatus('멈췄어요: ' + e.message, 'error');
  } finally {
    running = false;
  }
}

// ---- 수신함 화면과의 연결(bridge.js) ----
// 화면에서 보낸 그룹웨어 계정·연결 키를 이 PC의 확장 저장소에만 넣는다. 비밀번호는 화면으로 돌려주지 않는다.
async function bridgeState() {
  const s = await chrome.storage.local.get(['agentToken', 'lastStatus', 'lastLevel', 'gwLimit']);
  const accts = await getAccounts();
  const first = accts[0];
  return {
    hasKey: !!s.agentToken, gwLimit: Number(s.gwLimit) || 0,
    accounts: accts.map((x) => ({ id: x.id, on: x.on !== false, blocked: !!x.blocked, hasPw: !!x.pw, last: x.last || null })),
    gwId: first ? first.id : '', hasPw: first ? !!first.pw : false, blocked: accts.some((x) => x.blocked), gwOn: accts.some((x) => x.on !== false),
    lastStatus: s.lastStatus || '', lastLevel: s.lastLevel || 'info', version: chrome.runtime.getManifest().version
  };
}
async function senderAllowed(sender) {
  try {
    const o = new URL(sender.url || sender.tab?.url || '').origin;
    const cfg = await chrome.storage.local.get('serverUrl');
    const mine = cfg.serverUrl ? new URL(cfg.serverUrl).origin : 'https://interview.bigbears.me';
    return o === mine || o === 'https://interview.bigbears.me';
  } catch { return false; }
}
// 문자 관리 시스템 화면에서 "연락처 가져오기"를 요청했을 때 알람(30초)을 기다리지 않고 바로 확인한다
chrome.runtime.onMessage.addListener((m, sender) => {
  if (m && m.type === 'kick') senderAllowed(sender).then((ok) => { if (ok) run(false); });
  return false;
});
chrome.runtime.onMessage.addListener((m, sender, send) => {
  if (!m || (m.type !== 'bridge-state' && m.type !== 'bridge-save')) return false;
  (async () => {
    if (!(await senderAllowed(sender))) return send({});
    if (m.type === 'bridge-save') await saveConfig(m.patch || {}, new URL(sender.url).origin);
    send(await bridgeState());
  })();
  return true;
});

chrome.runtime.onInstalled.addListener(() => chrome.alarms.create(ALARM, { periodInMinutes: 0.5 }));
chrome.runtime.onStartup.addListener(() => chrome.alarms.create(ALARM, { periodInMinutes: 0.5 }));
chrome.alarms.onAlarm.addListener((a) => { if (a.name === ALARM) run(false); });
chrome.runtime.onMessage.addListener((m, sender, send) => {
  if (m && m.type === 'run') run(true);
  if (m && m.type === 'popup-save' && sender.id === chrome.runtime.id) { saveConfig(m.patch || {}, '').then(() => send(true)); return true; }
  return false;
});
