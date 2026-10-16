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

async function setStatus(text) {
  await chrome.storage.local.set({ lastStatus: new Date().toLocaleTimeString('ko-KR') + ' · ' + text });
  try { await chrome.action.setBadgeText({ text: /로그인|멈췄|키|안 돼요/.test(text) ? '!' : '' }); } catch { /* ignore */ }
}

async function api(cfg, path, init = {}) {
  const r = await fetch(cfg.serverUrl + path, {
    ...init, headers: { Authorization: 'Bearer ' + cfg.agentToken, 'Content-Type': 'application/json', ...(init.headers || {}) }
  });
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

// ---------------- 그룹웨어 메일에서 알바몬 지원 메일 가져오기 ----------------
// 그룹웨어 아이디·비밀번호는 이 PC 크롬(chrome.storage.local)에만 저장하고, 그룹웨어 로그인 화면에만 입력한다.
// 문자 관리 시스템으로는 보내지 않는다. 시스템에는 알바몬 지원 메일 본문(표)만 보낸다.
const GW_MAIL_DEFAULT = 'https://mail.willvi.co.kr/mail/link/emlMail/emlMailMain.do';
const GW_EVERY_MS = 5 * 60 * 1000;
const GW_MAX_PER_SCAN = 15;
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
function pageListMails() {
  const out = [];
  for (const u of document.querySelectorAll('ul.mail_list')) {
    const li = u.closest('li');
    if (!li || !/mailmaster@albamon\.com/.test(li.innerHTML)) continue;
    const inp = li.querySelector('input[name=key]');
    const a = li.querySelector('.subject a[data-mailbox-id]');
    if (inp && a) out.push({ id: inp.value, mb: a.getAttribute('data-mailbox-id') });
  }
  return out;
}

// 메일 본문에서 지원자 표를 찾아 HTML 로 돌려준다
function pageMailBody() {
  const els = [...document.querySelectorAll('table,div,td')].filter((e) => {
    const t = e.innerText || '';
    return t.includes('공고번호') && t.includes('이력서 보기');
  });
  els.sort((x, y) => x.outerHTML.length - y.outerHTML.length);
  return els[0] ? els[0].outerHTML : '';
}

async function exec(tabId, func, args = []) {
  const [r] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return r && r.result;
}

async function scanGroupware(cfg, force) {
  if (!cfg.gwId || !cfg.gwPw || cfg.gwOn === false) return '';
  const last = (await chrome.storage.local.get('gwLastScan')).gwLastScan || 0;
  if (!force && Date.now() - last < GW_EVERY_MS) return '';
  const base = cfg.gwMailUrl || GW_MAIL_DEFAULT;
  await chrome.storage.local.set({ gwLastScan: Date.now() });

  let tab = await openTab(base);
  try {
    // 로그인 화면이면 입력한다(최대 2번 시도)
    for (let i = 0; i < 2; i++) {
      await sleep(800);
      const st = await exec(tab.id, pageLogin, [cfg.gwId, cfg.gwPw]).catch(() => 'error');
      if (st === 'nologin') break;
      if (i === 1) return '그룹웨어 로그인이 안 돼요. 아이디·비밀번호를 확인해 주세요.';
      // 로그인 뒤 화면이 바뀔 때까지 기다린다
      await new Promise((r) => setTimeout(r, 400));
      await waitLoaded(tab.id);
      await sleep(1500);
      await chrome.tabs.update(tab.id, { url: base });
      await waitLoaded(tab.id);
    }
    await sleep(2500);   // 메일 목록은 화면이 열린 뒤에 채워진다
    const mails = (await exec(tab.id, pageListMails).catch(() => [])) || [];
    if (!mails.length) return '';
    const seenArr = (await chrome.storage.local.get('gwSeen')).gwSeen || [];
    const seen = new Set(seenArr);
    const todo = mails.filter((m) => !seen.has(m.id)).slice(0, GW_MAX_PER_SCAN);
    let added = 0, dup = 0, skipped = 0;
    for (const m of todo) {
      await setStatus(`그룹웨어 메일 읽는 중… (${added + dup + skipped + 1}/${todo.length})`);
      await chrome.tabs.update(tab.id, { url: `${base}?mode=view&mailId=${encodeURIComponent(m.id)}&mailboxId=${encodeURIComponent(m.mb)}` });
      await waitLoaded(tab.id);
      await sleep(2000);
      const html = await exec(tab.id, pageMailBody).catch(() => '');
      if (!html) { skipped++; seen.add(m.id); continue; }
      const r = await (await api(cfg, '/api/agent/mail', { method: 'POST', body: JSON.stringify({ html }) })).json();
      seen.add(m.id);
      if (r.ok) { if (r.duplicate) dup++; else added++; } else skipped++;
      await sleep(800 + Math.random() * 1200);
    }
    await chrome.storage.local.set({ gwSeen: [...seen].slice(-SEEN_CAP) });
    return todo.length ? `그룹웨어 메일 ${added}건 새로 가져왔어요${dup ? `(이미 있는 ${dup}건)` : ''}.` : '';
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function runContacts(cfg) {
  const q = await (await api(cfg, '/api/agent/inbox')).json();
  const items = (q.items || []).slice(0, MAX_PER_RUN);
  if (!items.length) return '';
  let ok = 0, fail = 0, dry = 0;
  let idx = 0;
  for (const item of items) {
    await setStatus(`처리 중… (${++idx}/${items.length})`);
    const r = await processItem(cfg, item);
    if (r.stop === 'login') return '알바몬 로그인이 필요해요. 이 크롬에서 알바몬에 로그인해 주세요.';
    if (r.ok) ok++; else if (r.dry) dry++; else fail++;
    if (r.stop === 'deduct') return '이용권 확인 창 때문에 멈췄어요. 알바몬 화면을 확인해 주세요.';
    await sleep(2500 + Math.random() * 3500);
  }
  return dry ? `시험 실행: ${dry}건에서 연락처 보기 버튼을 찾았어요.` : `연락처 ${ok}건 채웠어요${fail ? `, ${fail}건 실패` : ''}.`;
}

async function run(force = false) {
  if (running && Date.now() - runningSince < 5 * 60 * 1000) return;
  running = true;
  runningSince = Date.now();
  try {
    const cfg = await chrome.storage.local.get(['serverUrl', 'agentToken', 'dry', 'gwId', 'gwPw', 'gwOn', 'gwMailUrl']);
    if (!cfg.agentToken) { await setStatus('연결 키가 없어요. 아이콘을 눌러 키를 넣어 주세요.'); return; }
    cfg.serverUrl = (cfg.serverUrl || 'https://interview.bigbears.me').replace(/\/+$/, '');
    const parts = [];
    try { const g = await scanGroupware(cfg, force); if (g) parts.push(g); } catch (e) { parts.push('그룹웨어 메일을 가져오지 못했어요(' + e.message + ').'); }
    const c = await runContacts(cfg);
    if (c) parts.push(c);
    await setStatus(parts.length ? parts.join(' ') : '새로 처리할 것이 없어요.');
  } catch (e) {
    await setStatus('멈췄어요: ' + e.message);
  } finally {
    running = false;
  }
}

chrome.runtime.onInstalled.addListener(() => chrome.alarms.create(ALARM, { periodInMinutes: 1 }));
chrome.runtime.onStartup.addListener(() => chrome.alarms.create(ALARM, { periodInMinutes: 1 }));
chrome.alarms.onAlarm.addListener((a) => { if (a.name === ALARM) run(false); });
chrome.runtime.onMessage.addListener((m) => { if (m && m.type === 'run') run(true); });
