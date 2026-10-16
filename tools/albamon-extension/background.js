// 문자 관리 시스템 - 연락처 가져오기 (크롬 확장)
//  - 수신함에서 [연락처 가져오기]를 누른 건만 처리한다.
//  - 이 크롬의 알바몬 로그인 상태를 그대로 쓴다. 알바몬 아이디·비밀번호는 읽지도 저장하지도 않는다.
//  - 이용권 차감·결제 확인 창이 보이면 누르지 않고 멈춘다.
const ALARM = 'albamon-poll';
const MAX_PER_RUN = 5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let running = false;

async function setStatus(text) {
  await chrome.storage.local.set({ lastStatus: new Date().toLocaleTimeString('ko-KR') + ' · ' + text });
  try { await chrome.action.setBadgeText({ text: /로그인|멈췄|키/.test(text) ? '!' : '' }); } catch { /* ignore */ }
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
    await waitLoaded(tab.id);
    await sleep(1000);
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: pageRead, args: [{ name: item.name, apply_no: item.apply_no }, !!cfg.dry] });
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

async function run() {
  if (running) return;
  running = true;
  try {
    const cfg = await chrome.storage.local.get(['serverUrl', 'agentToken', 'dry']);
    if (!cfg.agentToken) { await setStatus('연결 키가 없어요. 아이콘을 눌러 키를 넣어 주세요.'); return; }
    cfg.serverUrl = (cfg.serverUrl || 'https://interview.bigbears.me').replace(/\/+$/, '');
    const q = await (await api(cfg, '/api/agent/inbox')).json();
    const items = (q.items || []).slice(0, MAX_PER_RUN);
    if (!items.length) { await setStatus('처리할 요청이 없어요.'); return; }
    let ok = 0, fail = 0, dry = 0;
    for (const item of items) {
      const r = await processItem(cfg, item);
      if (r.stop === 'login') { await setStatus('알바몬 로그인이 필요해요. 이 크롬에서 알바몬에 로그인해 주세요.'); return; }
      if (r.ok) ok++; else if (r.dry) dry++; else fail++;
      if (r.stop === 'deduct') { await setStatus('이용권 확인 창 때문에 멈췄어요. 알바몬 화면을 확인해 주세요.'); return; }
      await sleep(2500 + Math.random() * 3500);
    }
    await setStatus(dry ? `시험 실행: ${dry}건에서 연락처 보기 버튼을 찾았어요.` : `${ok}건 채웠어요${fail ? `, ${fail}건 실패` : ''}.`);
  } catch (e) {
    await setStatus('멈췄어요: ' + e.message);
  } finally {
    running = false;
  }
}

chrome.runtime.onInstalled.addListener(() => chrome.alarms.create(ALARM, { periodInMinutes: 1 }));
chrome.runtime.onStartup.addListener(() => chrome.alarms.create(ALARM, { periodInMinutes: 1 }));
chrome.alarms.onAlarm.addListener((a) => { if (a.name === ALARM) run(); });
chrome.runtime.onMessage.addListener((m) => { if (m && m.type === 'run') run(); });
