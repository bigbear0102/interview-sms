// 문자 관리 시스템 - 연락처 가져오기 (크롬 확장, v1.8)
//  - 새 지원에서 [연락처 가져오기]를 누른 건만, 이 크롬에 로그인된 알바몬으로 이력서를 열어 연락처를 채운다.
//  - 알바몬 아이디·비밀번호는 읽지도 저장하지도 않는다(이 크롬의 로그인 상태를 쓴다).
//  - 이용권 차감·결제 확인 창이 보이면 누르지 않고 멈춘다.
//  - (v1.8) 그룹웨어 메일 가져오기는 시스템이 직접(POP3) 하므로 이 확장에서 뺐다. 예전에 저장한 그룹웨어 계정·비밀번호는 지운다.
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

// ---------------- 로그인 쿠키 보관·복원(알바몬 계정 여러 개 기능용, 지금은 시스템에서 꺼 둠) ----------------
// 읽기 전에 내 쿠키를 보관해 두었다가 끝나면 그대로 되돌린다.
async function clearCookies(domain) {
  const list = await chrome.cookies.getAll({ domain });
  for (const c of list) {
    const url = (c.secure ? 'https://' : 'http://') + c.domain.replace(/^\./, '') + c.path;
    await chrome.cookies.remove({ url, name: c.name, storeId: c.storeId }).catch(() => {});
  }
}
async function restoreCookies(domain, snap) {
  await clearCookies(domain);
  for (const c of snap || []) {
    const d = { url: (c.secure ? 'https://' : 'http://') + c.domain.replace(/^\./, '') + c.path, name: c.name, value: c.value, path: c.path, secure: c.secure, httpOnly: c.httpOnly, storeId: c.storeId };
    if (!c.hostOnly) d.domain = c.domain;
    if (c.sameSite && c.sameSite !== 'unspecified') d.sameSite = c.sameSite;
    if (!c.session && c.expirationDate) d.expirationDate = c.expirationDate;
    await chrome.cookies.set(d).catch(() => {});
  }
}
async function openTab(url) {
  const tab = await chrome.tabs.create({ url, active: false });
  await waitLoaded(tab.id);
  return tab;
}
async function exec(tabId, func, args = []) {
  const [r] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return r && r.result;
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
    if (s.amSwap) { await restoreCookies(s.amSwap.domain, s.amSwap.snap); await chrome.storage.session.remove('amSwap'); }
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
  await clearCookies(await amCookieDomain(cfg));
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
  if (sess[acct.id] && sess[acct.id].length) { await restoreCookies(await amCookieDomain(cfg), sess[acct.id]); return true; }
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
    await restoreCookies(domain, mine);
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
    const cfg = await chrome.storage.local.get(['serverUrl', 'agentToken', 'dry', 'amLoginUrl', 'amCookieDomain']);
    if (!cfg.agentToken) { await setStatus('연결 키가 없어요. 문자 관리 시스템의 연결 설정을 한 번 열면 자동으로 연결돼요.', 'error'); return; }
    cfg.serverUrl = (cfg.serverUrl || 'https://interview.bigbears.me').replace(/\/+$/, '');
    const t0 = Date.now();
    let r = null;
    try { r = await runContacts(cfg); } catch (e) { r = { level: 'error', text: '연락처 가져오기가 멈췄어요: ' + e.message }; }
    await setStatus(r ? `${r.text} [총 ${((Date.now() - t0) / 1000).toFixed(1)}초]` : '새로 처리할 것이 없어요.', r ? r.level : 'ok');
  } catch (e) {
    await setStatus('멈췄어요: ' + e.message, 'error');
  } finally {
    running = false;
  }
}

// ---- 문자 관리 시스템 화면과의 연결(bridge.js) ----
// 화면은 연결 키만 건넨다. 상태(버전·연결 키 있음·최근 결과)만 화면에 알려 준다.
async function saveConfig(p, origin) {
  const set = {};
  if (p.agentToken) set.agentToken = p.agentToken;
  if (typeof p.dry === 'boolean') set.dry = p.dry;
  if (typeof p.serverUrl === 'string' && p.serverUrl) set.serverUrl = p.serverUrl;
  if (!set.serverUrl && origin && set.agentToken) set.serverUrl = origin;
  if (Object.keys(set).length) await chrome.storage.local.set(set);
  if (set.agentToken || set.serverUrl) setTimeout(() => run(true), 300);
}
async function bridgeState() {
  const s = await chrome.storage.local.get(['agentToken', 'lastStatus', 'lastLevel']);
  return { hasKey: !!s.agentToken, lastStatus: s.lastStatus || '', lastLevel: s.lastLevel || 'info', version: chrome.runtime.getManifest().version };
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

// 예전 버전이 이 PC 에 저장해 둔 그룹웨어 계정·비밀번호·메일 기록을 지운다(v1.8 부터 쓰지 않음)
const OLD_GW_KEYS = ['gwAccounts', 'gwId', 'gwPw', 'gwOn', 'gwSeen', 'gwBlocked', 'gwForceLogin', 'gwLastScan', 'gwLimit', 'gwMailUrl', 'gwCookieDomain', 'gwLoginBase'];
async function cleanupOld() {
  await chrome.storage.local.remove(OLD_GW_KEYS).catch(() => {});
  await chrome.storage.session.remove('gwSwap').catch(() => {});
}
chrome.runtime.onInstalled.addListener(() => { chrome.alarms.create(ALARM, { periodInMinutes: 0.5 }); cleanupOld(); });
chrome.runtime.onStartup.addListener(() => { chrome.alarms.create(ALARM, { periodInMinutes: 0.5 }); cleanupOld(); });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === ALARM) run(false); });
chrome.runtime.onMessage.addListener((m, sender, send) => {
  if (m && m.type === 'run') run(true);
  if (m && m.type === 'popup-save' && sender.id === chrome.runtime.id) { saveConfig(m.patch || {}, '').then(() => send(true)); return true; }
  return false;
});
