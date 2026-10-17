// 알바몬 연락처 가져오기 — 상시 실행(라즈베리파이 등, 화면 없이 무인)
//  - 문자 관리 시스템에서 "연락처 가져오기"를 요청한 건을 20초마다 확인해, 알바몬 이력서를 열어 번호를 채운다.
//  - 공용 연결 키(관리자가 연결 설정에서 만든 키)를 쓰면 모든 담당자의 요청을 처리한다.
//  - 알바몬 아이디·비밀번호는 이 기기의 설정 파일(/etc/albamon-agent.env, 권한 600)에만 있고 시스템으로 보내지 않는다.
//  - 로그인이 실패하면 계정 잠김을 막기 위해 다시 시도하지 않고 6시간 쉰다(설정을 고친 뒤 서비스를 다시 시작하면 바로 시도).
//  - 이용권 차감·결제 확인 창이 보이면 누르지 않고 1시간 멈춘다.
// 환경변수: AGENT_SERVER_URL, AGENT_TOKEN, ALBAMON_ID, ALBAMON_PW, CHROME_PATH(선택), ALBAMON_LOGIN_URL(선택, 시험용),
//           AGENT_POLL_MS(기본 20000), AGENT_PROFILE(크롬 프로필 폴더), AGENT_ONCE=1(요청이 없으면 끝냄, 시험용)
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { pageRead } from './page-read.mjs';
import { sleep, jitter } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const env = process.env;
const SERVER = String(env.AGENT_SERVER_URL || 'https://interview.bigbears.me').replace(/\/+$/, '');
const TOKEN = env.AGENT_TOKEN || '';
const LOGIN_URL = env.ALBAMON_LOGIN_URL || 'https://www.albamon.com/user-account/login?memberType=CORPORATION';
const POLL = Number(env.AGENT_POLL_MS) || 20000;
const PROFILE = env.AGENT_PROFILE || join(HERE, 'chrome-profile');
const ONCE = env.AGENT_ONCE === '1';
const ITEM_TIMEOUT = 45000;

const log = (m) => console.log(`[${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false })}] ${m}`);

const NOTES = {
  nobutton: '연락처 보기 버튼을 찾지 못했어요(10초 기다렸어요).',
  nophone: '버튼을 눌렀지만 전화번호가 보이지 않았어요(12초 기다렸어요).',
  gone: '이력서를 찾을 수 없어요(삭제되었거나 열람 기간이 지났을 수 있어요).',
  mismatch: '이력서가 맞는지 확인하지 못했어요(이름·지원 번호가 화면에 없어요).',
  deduct: '결제·이용권 확인 창이 떠서 멈췄어요. 알바몬 화면에서 직접 확인해 주세요.'
};

export function findChrome() {
  return [env.CHROME_PATH, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/snap/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:/Program Files/Google/Chrome/Application/chrome.exe'].filter(Boolean).find((p) => existsSync(p));
}

async function api(path, init = {}) {
  const r = await fetch(SERVER + path, {
    ...init, headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', ...(init.headers || {}) },
    signal: AbortSignal.timeout(20000)
  });
  if (r.status === 401) throw Object.assign(new Error('연결 키가 맞지 않아요. 연결 설정에서 공용 연결 키를 다시 만들어 /etc/albamon-agent.env 에 넣어 주세요.'), { fatal: true });
  return r;
}
// 시스템 화면(연결 설정)에 보이는 이 기기 상태
const report = (state, note = '') => api('/api/agent/status', { method: 'POST', body: JSON.stringify({ state, note: String(note).slice(0, 190), device: 'pi' }) })
  .catch((e) => log('상태 보고 실패: ' + e.message));

async function isLoginPage(page) {
  return page.evaluate(() => {
    const pw = document.querySelector('input[type=password]');
    const vis = pw && pw.getBoundingClientRect().width > 0;
    return !!vis || /user-account\/login|\/login/i.test(location.href);
  }).catch(() => false);
}

// 알바몬 기업회원 로그인. 반환: 'ok' | 'failed' | 'noform'
async function login(page) {
  if (!env.ALBAMON_ID || !env.ALBAMON_PW) return 'failed';
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(1500);
  if (!(await isLoginPage(page))) return 'ok';
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('a,button,li,span,label,div')].find((e) => (e.innerText || '').trim() === '기업회원');
    if (el) el.click();
  }).catch(() => {});
  await sleep(500);
  let idEl = null, pwEl = null;
  for (const h of await page.$$('input')) {
    const info = await h.evaluate((e) => ({ type: (e.type || 'text').toLowerCase(), vis: e.getBoundingClientRect().width > 0 }));
    if (!info.vis) continue;
    if (info.type === 'password' && !pwEl) pwEl = h;
    else if (['text', 'email', 'tel'].includes(info.type) && !idEl && !pwEl) idEl = h;
  }
  if (!idEl || !pwEl) return 'noform';
  await idEl.click({ clickCount: 3 }); await idEl.type(env.ALBAMON_ID, { delay: 30 });
  await pwEl.click({ clickCount: 3 }); await pwEl.type(env.ALBAMON_PW, { delay: 30 });
  const clicked = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button,input[type=submit],a')].find((e) => /^로그인$/.test((e.innerText || e.value || '').trim()));
    if (b) { b.click(); return true; }
    return false;
  });
  if (!clicked) await pwEl.press('Enter');
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    if (!(await isLoginPage(page))) return 'ok';
  }
  return 'failed';
}

// 이력서 1건 읽기. 반환: pageRead 결과({state, phone?, labels?})
async function readOne(page, item) {
  await page.goto(item.resume_url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  const started = Date.now();
  for (;;) {
    try {
      return await Promise.race([
        page.evaluate(pageRead, { name: item.name, apply_no: item.apply_no }, false),
        sleep(ITEM_TIMEOUT).then(() => { throw new Error('timeout'); })
      ]);
    } catch (e) {
      // 리다이렉트로 화면이 바뀌면서 읽기가 끊기면 잠시 뒤 다시 읽는다
      if (e.message === 'timeout' || Date.now() - started > ITEM_TIMEOUT - 5000) throw e;
      await sleep(300);
    }
  }
}

async function main() {
  if (!TOKEN) { log('AGENT_TOKEN(공용 연결 키)이 없어요. /etc/albamon-agent.env 를 확인해 주세요.'); process.exit(2); }
  const chrome = findChrome();
  if (!chrome) { log('크롬(chromium)을 찾지 못했어요. sudo apt install chromium 후 다시 시작해 주세요.'); process.exit(2); }
  mkdirSync(PROFILE, { recursive: true });
  log(`시작: 시스템 ${SERVER}, 브라우저 ${chrome}`);

  let browser = null, page = null;
  const open = async () => {
    browser = await puppeteer.launch({
      executablePath: chrome, headless: true, userDataDir: PROFILE, defaultViewport: { width: 1200, height: 900 },
      args: ['--no-first-run', '--no-default-browser-check', '--disable-dev-shm-usage', '--lang=ko-KR', '--no-sandbox']
    });
    page = (await browser.pages())[0] || (await browser.newPage());
  };
  const close = async () => { await browser?.close().catch(() => {}); browser = null; page = null; };

  let pausedUntil = 0;
  for (;;) {
    try {
      if (Date.now() < pausedUntil) { await sleep(Math.min(pausedUntil - Date.now(), 60000)); continue; }
      const { items = [] } = await (await api('/api/agent/inbox?limit=5')).json();
      if (!items.length) {
        await report('idle');
        if (ONCE) break;
        // 요청이 없으면 브라우저를 닫아 메모리를 아낀다(라즈베리파이)
        if (browser) await close();
        await sleep(POLL);
        continue;
      }
      if (!browser) await open();
      let stop = '';
      for (const item of items) {
        let r;
        try {
          r = await readOne(page, item);
          if (r && r.state === 'login') {
            log('알바몬 로그인이 필요해요. 로그인할게요.');
            const lr = await login(page);
            if (lr !== 'ok') { stop = 'login'; break; }
            log('로그인됐어요.');
            r = await readOne(page, item);
          }
        } catch (e) {
          if (e.fatal) throw e;
          r = { state: 'error', note: '이력서 화면을 읽지 못했어요(' + (e.message === 'timeout' ? '시간 초과' : '화면 접근 오류') + ').' };
        }
        if (r.state === 'login') { stop = 'login'; break; }
        if (r.state === 'ok') {
          await api(`/api/agent/inbox/${item.id}/result`, { method: 'POST', body: JSON.stringify({ ok: true, phone: r.phone, note: '' }) });
          log(`연락처를 채웠어요 (#${item.id}, 끝 4자리 ${String(r.phone).slice(-4)})`);
        } else {
          const hint = r.labels && r.labels.length ? ` (화면 버튼: ${r.labels.join(', ')})` : '';
          const note = ((r.note || NOTES[r.state] || '알 수 없는 이유로 실패했어요.') + hint).slice(0, 190);
          await api(`/api/agent/inbox/${item.id}/result`, { method: 'POST', body: JSON.stringify({ ok: false, phone: '', note }) });
          log(`실패 (#${item.id}): ${note}`);
          if (r.state === 'deduct') { stop = 'deduct'; break; }
        }
        await sleep(jitter(800, 2000));
      }
      if (stop === 'login') {
        const why = env.ALBAMON_ID ? '알바몬 로그인에 실패했어요. 아이디·비밀번호를 확인해 /etc/albamon-agent.env 를 고친 뒤 서비스를 다시 시작해 주세요(계정 잠김을 막기 위해 6시간 동안 다시 시도하지 않아요).'
          : '알바몬 아이디·비밀번호가 설정되지 않았어요. /etc/albamon-agent.env 를 확인해 주세요.';
        log(why); await report('login_failed', why);
        pausedUntil = Date.now() + 6 * 3600e3;
        await close();
        if (ONCE) break;
      } else if (stop === 'deduct') {
        await report('paused', NOTES.deduct);
        pausedUntil = Date.now() + 3600e3;
        await close();
        if (ONCE) break;
      } else {
        await report('ok');
      }
    } catch (e) {
      if (e.fatal) { log(e.message); await sleep(10 * 60000); continue; }
      log('오류: ' + e.message);
      await report('error', e.message);
      await close();   // 브라우저가 죽었을 수 있으니 다음에 새로 연다
      if (ONCE) break;
      await sleep(POLL);
    }
  }
  await close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { log('멈췄어요: ' + e.message); process.exit(1); });
}
