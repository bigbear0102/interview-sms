// 알바몬 연락처 가져오기 에이전트
//  - 문자 관리 시스템의 "메일 수신함"에서 [연락처 가져오기]를 누른 건만 처리한다.
//  - 이 PC의 크롬으로 알바몬에 로그인(직접 하거나 아이디·비밀번호를 여기에 입력)하고, 이력서의 "연락처 보기"를 눌러 번호를 읽어 시스템에 돌려준다.
//  - 알바몬 아이디·비밀번호는 이 PC 밖으로 나가지 않고 파일로도 저장하지 않는다. (로그인 상태만 크롬 프로필 폴더에 남는다)
//  - 이용권 차감·결제 확인 창이 보이면 누르지 않고 멈춘다.
// 사용: node agent.mjs [--dry] [--once] [--max 10] [--reset]
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { pickPhone, isRevealText, looksLikeDeduction, nameMatches, looksLikeLogin, sleep, jitter } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG = join(HERE, 'agent.config.json');
const PROFILE = join(HERE, 'chrome-profile');
const args = process.argv.slice(2);
const flag = (n) => args.includes('--' + n);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const say = (m) => console.log(m);
const rl = () => createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => { const r = rl(); r.question(q, (a) => { r.close(); res(a.trim()); }); });
function askHidden(q) {
  return new Promise((res) => {
    process.stdout.write(q);
    const stdin = process.stdin;
    if (!stdin.isTTY) { ask('').then(res); return; }
    let buf = '';
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    const onData = (c) => {
      for (const ch of c) {
        if (ch === '\r' || ch === '\n') { stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); process.stdout.write('\n'); return res(buf); }
        if (ch === '\u0003') process.exit(1);
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1); else buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

function findChrome() {
  const c = [process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
  return c.find((p) => existsSync(p));
}

async function loadConfig() {
  let cfg = {};
  if (existsSync(CONFIG) && !flag('reset')) { try { cfg = JSON.parse(readFileSync(CONFIG, 'utf8')); } catch { cfg = {}; } }
  if (process.env.AGENT_SERVER_URL) cfg.serverUrl = process.env.AGENT_SERVER_URL;
  if (process.env.AGENT_TOKEN) cfg.agentToken = process.env.AGENT_TOKEN;
  let changed = false;
  if (!cfg.serverUrl) { cfg.serverUrl = (await ask('시스템 주소 (엔터 = https://interview.bigbears.me): ')) || 'https://interview.bigbears.me'; changed = true; }
  if (!cfg.agentToken) { cfg.agentToken = await ask('에이전트 연결 키 (수신함 > 연락처 자동 가져오기 에이전트에서 만든 ag_로 시작하는 값): '); changed = true; }
  cfg.loginUrl = cfg.loginUrl || 'https://www.albamon.com/user-account/login';
  if (changed) writeFileSync(CONFIG, JSON.stringify({ serverUrl: cfg.serverUrl, agentToken: cfg.agentToken, loginUrl: cfg.loginUrl }, null, 2));
  cfg.serverUrl = cfg.serverUrl.replace(/\/+$/, '');
  return cfg;
}

async function api(cfg, path, init = {}) {
  const r = await fetch(cfg.serverUrl + path, {
    ...init, headers: { Authorization: 'Bearer ' + cfg.agentToken, 'Content-Type': 'application/json', ...(init.headers || {}) }
  });
  if (r.status === 401) throw new Error('연결 키가 맞지 않아요. 수신함에서 키를 다시 확인해 주세요.');
  return r;
}

// ---------------- 브라우저 동작 ----------------
async function pageText(page) {
  return page.evaluate(() => (document.body && document.body.innerText) || '');
}
async function needsLogin(page) {
  const hasPassword = await page.evaluate(() => {
    const el = document.querySelector('input[type=password]');
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }).catch(() => false);
  return looksLikeLogin({ url: page.url(), hasPassword });
}

async function tryAutoLogin(page, id, pw) {
  // 기업회원 탭이 있으면 누른다
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('a,button,li,span,label,div')].find((e) => (e.innerText || '').trim() === '기업회원');
    if (el) el.click();
  }).catch(() => {});
  await sleep(500);
  const inputs = await page.$$('input');
  let idInput = null, pwInput = null;
  for (const h of inputs) {
    const info = await h.evaluate((e) => ({ type: (e.type || '').toLowerCase(), vis: e.getBoundingClientRect().width > 0 }));
    if (!info.vis) continue;
    if (info.type === 'password' && !pwInput) pwInput = h;
    else if (['text', 'email', ''].includes(info.type) && !idInput) idInput = h;
  }
  if (!idInput || !pwInput) return false;
  await idInput.click({ clickCount: 3 }); await idInput.type(id, { delay: 40 });
  await pwInput.click({ clickCount: 3 }); await pwInput.type(pw, { delay: 40 });
  const clicked = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button,input[type=submit],a')].find((e) => /^로그인$/.test((e.innerText || e.value || '').trim()));
    if (b) { b.click(); return true; }
    return false;
  });
  if (!clicked) await pwInput.press('Enter');
  return true;
}

async function ensureLoggedIn(page, cfg, state) {
  if (!(await needsLogin(page))) return true;
  say('알바몬 로그인이 필요해요.');
  if (!state.askedLogin) {
    state.askedLogin = true;
    const id = await ask('알바몬 아이디 (엔터 = 크롬 창에서 직접 로그인): ');
    if (id) {
      const pw = await askHidden('알바몬 비밀번호 (입력 내용은 화면에 보이지 않아요): ');
      const ok = await tryAutoLogin(page, id, pw);
      if (!ok) say('로그인 입력칸을 찾지 못했어요. 크롬 창에서 직접 로그인해 주세요.');
    } else {
      say('열린 크롬 창에서 알바몬 기업회원으로 로그인해 주세요. (최대 10분 기다려요)');
    }
  }
  const until = Date.now() + 10 * 60 * 1000;
  while (Date.now() < until) {
    await sleep(2000);
    if (!(await needsLogin(page))) { say('로그인됐어요.'); return true; }
  }
  say('로그인 시간이 지났어요.');
  return false;
}

// 연락처 보기 버튼 찾기 → 눌러서 번호 읽기. 반환 { ok, phone, note, stop }
async function readContact(page, item, { dry }) {
  const before = await pageText(page);
  const nameOk = nameMatches(before, item.name);
  const urlOk = page.url().includes(item.apply_no);
  // 이미 번호가 보이면 누르지 않는다
  let phone = pickPhone(before);
  let clicked = false;
  if (!phone) {
    const handle = await page.evaluateHandle((patterns) => {
      const res = patterns.map((p) => new RegExp(p));
      const els = [...document.querySelectorAll('button,a,[role=button],span,div,li,label')];
      const hit = els.filter((e) => {
        const t = (e.innerText || '').replace(/\s+/g, ' ').trim();
        if (!t || t.length > 24) return false;
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && res.some((re) => re.test(t));
      });
      // 가장 안쪽(자식이 없는) 요소를 고른다
      return hit.find((e) => !hit.some((o) => o !== e && e.contains(o))) || hit[0] || null;
    }, [
      '(연락처|전화번호|휴대폰|핸드폰|휴대전화).{0,6}(보기|확인|열람|조회)',
      '(보기|확인|열람|조회).{0,6}(연락처|전화번호|휴대폰|핸드폰)'
    ]);
    const el = handle.asElement();
    if (!el) return { ok: false, note: '연락처 보기 버튼을 찾지 못했어요(화면 구조가 다를 수 있어요).' };
    if (dry) return { ok: false, note: '(시험 실행) 연락처 보기 버튼을 찾았어요. 누르지 않았어요.', dry: true };
    if (process.env.AGENT_DEBUG) say('  누를 요소: ' + await el.evaluate((e) => `${e.tagName}#${e.id}: ${(e.innerText || '').slice(0, 30)}`));
    await el.click();
    clicked = true;
    await sleep(1200);
    let after = await pageText(page);
    // 마우스 클릭이 먹지 않은 경우(화면 일부만 보임 등)를 대비해, 변화가 없으면 요소에 직접 클릭 신호를 한 번 더 보낸다
    if (after === before) {
      await el.evaluate((e) => e.click()).catch(() => {});
      await sleep(1200);
      after = await pageText(page);
    }
    // 차감·결제 확인 창
    const dialogText = await page.evaluate(() => {
      // 눈에 보이는 창만 본다(숨겨진 창의 글은 무시)
      const vis = (e) => { const r = e.getBoundingClientRect(); const st = getComputedStyle(e); return r.width > 0 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden'; };
      const list = [...document.querySelectorAll('dialog[open],[role=dialog],[role=alertdialog],.modal,.popup,.layer,[class*=modal],[class*=popup],[class*=layer]')].filter(vis);
      return list.map((e) => e.innerText || '').join(' ');
    }).catch(() => '');
    if (looksLikeDeduction(dialogText) && !pickPhone(after)) {
      return { ok: false, stop: true, note: '이용권 차감·결제 확인 창이 떠서 멈췄어요. 알바몬 화면에서 직접 확인해 주세요.' };
    }
    phone = pickPhone(after);
    if (process.env.AGENT_DEBUG) {
      say('  누른 뒤 화면 글: ' + after.replace(/\s+/g, ' ').slice(0, 120));
      say('  주소: ' + page.url());
      say('  HTML: ' + (await page.evaluate(() => document.body.innerHTML)).replace(/\s+/g, ' ').slice(0, 300));
    }
  }
  if (!phone) return { ok: false, note: clicked ? '버튼을 눌렀지만 전화번호가 보이지 않았어요.' : '전화번호를 찾지 못했어요.' };
  if (!urlOk && !nameOk) return { ok: false, note: '이력서가 맞는지 확인하지 못했어요(이름·지원 번호가 화면에 없어요).' };
  return { ok: true, phone };
}

async function main() {
  const cfg = await loadConfig();
  const chrome = findChrome();
  if (!chrome) { say('크롬을 찾지 못했어요. CHROME_PATH 환경변수에 chrome.exe 경로를 적어 주세요.'); process.exit(1); }
  const max = Number(opt('max', 10)) || 10;
  const dry = flag('dry');
  say(`시스템: ${cfg.serverUrl}${dry ? ' · 시험 실행(연락처 보기를 누르지 않아요)' : ''}`);

  // 처리할 건이 있는지 먼저 확인(없으면 브라우저를 열지 않는다)
  const first = await (await api(cfg, '/api/agent/inbox')).json();
  const headless = process.env.AGENT_HEADLESS === '1';
  const browser = await puppeteer.launch({
    executablePath: chrome, headless: headless ? 'new' : false, userDataDir: PROFILE,
    defaultViewport: headless ? { width: 1100, height: 900 } : null, args: ['--no-first-run', '--no-default-browser-check', '--window-size=1100,900']
  });
  const page = (await browser.pages())[0] || (await browser.newPage());
  const state = {};
  let done = 0;
  try {
    // 처음에는 로그인 화면을 열어 로그인 상태를 만든다
    await page.goto(cfg.loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (await needsLogin(page)) {
      if (!(await ensureLoggedIn(page, cfg, state))) return;
    } else {
      say('이미 로그인되어 있어요.');
    }
    const once = flag('once');
    for (;;) {
      const q = done === 0 ? first : await (await api(cfg, '/api/agent/inbox')).json();
      const items = q.items || [];
      if (!items.length) {
        if (once || done > 0) { say(done ? `끝났어요. ${done}건 처리했어요.` : '처리할 요청이 없어요.'); break; }
        say('처리할 요청이 없어요. 수신함에서 "연락처 가져오기"를 누르면 여기서 이어서 처리해요. (30초마다 확인)');
        await sleep(30000);
        continue;
      }
      for (const item of items) {
        if (done >= max) { say(`한 번에 ${max}건까지만 처리해요. 남은 건은 다시 실행해 주세요.`); return; }
        say(`[${item.name}] 이력서를 열어요…`);
        try {
          await page.goto(item.resume_url, { waitUntil: 'domcontentloaded', timeout: 60000 });
          await sleep(1500);
          if (await needsLogin(page)) {
            if (!(await ensureLoggedIn(page, cfg, state))) { say('로그인이 안 되어 멈춰요.'); return; }
            await page.goto(item.resume_url, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await sleep(1500);
          }
          const r = await readContact(page, item, { dry });
          if (r.dry) { say(`  ${r.note}`); done++; continue; }
          await api(cfg, `/api/agent/inbox/${item.id}/result`, { method: 'POST', body: JSON.stringify({ ok: r.ok, phone: r.phone || '', note: r.note || '' }) });
          say(r.ok ? `  연락처를 채웠어요 (끝 4자리 ${r.phone.slice(-4)})` : `  실패: ${r.note}`);
          done++;
          if (r.stop) { say('이용권 확인 창 때문에 여기서 멈춰요. 알바몬 화면을 확인한 뒤 다시 실행해 주세요.'); return; }
        } catch (e) {
          say(`  오류: ${e.message}`);
          await api(cfg, `/api/agent/inbox/${item.id}/result`, { method: 'POST', body: JSON.stringify({ ok: false, note: '에이전트 오류: ' + String(e.message).slice(0, 100) }) }).catch(() => {});
          done++;
        }
        await sleep(jitter(2500, 6000));
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error('에이전트가 멈췄어요:', e.message); process.exit(1); });
