// 크롬 확장 시험(알바몬 계정 여러 개): 가짜 알바몬(계정 A·B) + 가짜 시스템으로
//  계정 전환·처음 보는 공고 자동 판별·공고→계정 힌트·쿠키 재사용·로그인 실패 계정 쉬기·내 로그인 되돌리기를 확인한다.
// 사용: xvfb-run node tools/albamon-extension/mock-multi.mjs   (크롬 필요, 실제 알바몬/시스템에 접속하지 않음)
import http from 'node:http';
import { createRequire } from 'node:module';
import { cpSync, readFileSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const puppeteer = createRequire(join(HERE, '..', 'albamon-agent', 'package.json'))('puppeteer-core');
const TOKEN = 'ag_' + 'b'.repeat(48);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 가짜 알바몬: 기업회원 A(corpA/pwA) · B(corpB/pwB). 이력서는 계정마다 자기 공고 것만 열린다 ----
const OWN = { A1: 'A', A2: 'A', B1: 'B', B2: 'B' };
const PHONE = { A1: '010-1111-0001', A2: '010-1111-0002', B1: '010-2222-0001', B2: '010-2222-0002' };
const logins = [];          // 로그인 성공 기록(계정)
const views = [];           // 이력서 열람 [applyNo, 계정]
const who = (req) => { const m = (req.headers.cookie || '').match(/am=([A-Z]+)/); return m ? m[1] : ''; };
const alba = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/user-account/login') {
    if (req.method === 'POST') {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        const p = new URLSearchParams(b);
        const acct = p.get('id') === 'corpA' && p.get('pw') === 'pwA' ? 'A' : p.get('id') === 'corpB' && p.get('pw') === 'pwB' ? 'B' : '';
        if (acct) { logins.push(acct); res.writeHead(302, { 'Set-Cookie': `am=${acct}; Path=/`, Location: '/' }); return res.end(); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<meta charset=utf-8><p>아이디 또는 비밀번호가 맞지 않아요</p><form method="post" action="/user-account/login"><input name="id"><input name="pw" type="password"><button>로그인</button></form>');
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><meta charset=utf-8><ul><li>개인회원</li><li>기업회원</li></ul>
      <form method="post" action="/user-account/login"><input name="id" type="text"><input name="pw" type="password"><button type="submit">로그인</button></form>`);
  }
  if (u.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end('<meta charset=utf-8><h1>홈</h1>'); }
  if (u.pathname === '/resume') {
    const me = who(req);
    if (!me || me === 'MINE') { res.writeHead(302, { Location: '/user-account/login' }); return res.end(); }
    const no = u.searchParams.get('applyNo');
    views.push([no, me]);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (OWN[no] !== me) return res.end('<meta charset=utf-8><h1>안내</h1><p>존재하지 않는 이력서이거나 열람 권한이 없어요.</p>');
    return res.end(`<meta charset=utf-8><h1>이력서</h1><p>이름 지원${no}</p><p>연락처 <span id="p"><button onclick="document.getElementById('p').textContent='${PHONE[no]}'">연락처 보기</button></span></p>`);
  }
  res.writeHead(404); res.end();
});

// ---- 가짜 시스템 ----
let accounts = [{ id: 1, label: '현장HR', login_id: 'corpA', pw: 'pwA', updated_at: 1 }, { id: 2, label: '파견', login_id: 'corpB', pw: 'pwB', updated_at: 1 }];
const learned = {};          // recruit_no → account_id
let items = [];
const results = [];
const statusPosts = [];
const sys = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if ((req.headers.authorization || '') !== 'Bearer ' + TOKEN) { res.writeHead(401); return res.end('{}'); }
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/api/agent/albamon-accounts') return res.end(JSON.stringify({ allowed: true, accounts }));
    if (u.pathname === '/api/agent/albamon-status') { statusPosts.push(JSON.parse(raw)); return res.end('{"ok":true}'); }
    if (u.pathname === '/api/agent/inbox') {
      const list = items.filter((i) => !i.done).map((i) => ({ ...i, account_id: learned[i.recruit_no] || null }));
      items.forEach((i) => { i.done = true; });   // 한 번 가져가면 끝(실제 시스템의 "가져감" 표시와 같게)
      return res.end(JSON.stringify({ items: list }));
    }
    const m = u.pathname.match(/^\/api\/agent\/inbox\/(\d+)\/result$/);
    if (m) {
      const b = JSON.parse(raw);
      const it = [...items].find((x) => x.id === Number(m[1]));
      results.push({ id: Number(m[1]), apply: it && it.apply_no, ...b });
      if (b.ok && b.account_id && it) learned[it.recruit_no] = b.account_id;
      return res.end('{"ok":true}');
    }
    res.writeHead(404); res.end('{}');
  });
});
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const albaPort = await listen(alba);
const sysPort = await listen(sys);
const mk = (id, no, rn) => ({ id, apply_no: no, name: '지원' + no, recruit_no: rn, resume_url: `http://127.0.0.1:${albaPort}/resume?applyNo=${no}` });

const dir = mkdtempSync(join(tmpdir(), 'ext-multi-'));
cpSync(HERE, dir, { recursive: true, filter: (p) => !/mock-/.test(p) });
const mf = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
mf.host_permissions = ['http://127.0.0.1/*'];
mf.content_scripts[0].matches = ['http://127.0.0.1/applicants/inbox*'];
writeFileSync(join(dir, 'manifest.json'), JSON.stringify(mf));

const chrome = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium',
  'C:/Program Files/Google/Chrome/Application/chrome.exe'].filter(Boolean).find((p) => existsSync(p));
const browser = await puppeteer.launch({
  executablePath: chrome, headless: false, userDataDir: join(dir, 'profile'), pipe: true, enableExtensions: true,
  args: ['--no-first-run', '--no-sandbox', '--window-size=800,600']
});
await browser.installExtension(dir);
const wt = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().includes('background.js'), { timeout: 20000 });
const sw = await wt.worker();
await sw.evaluate((c) => chrome.storage.local.set(c), {
  serverUrl: `http://127.0.0.1:${sysPort}`, agentToken: TOKEN, dry: false, gwAccounts: [],
  amCookieDomain: '127.0.0.1', amLoginUrl: `http://127.0.0.1:${albaPort}/user-account/login`
});
const runAndWait = async () => { await sw.evaluate(() => chrome.storage.local.remove('lastStatus')); await Promise.race([sw.evaluate(() => run(true)), sleep(150000)]); return (await sw.evaluate(() => chrome.storage.local.get('lastStatus'))).lastStatus || ''; };
const check = (cond, msg) => { console.log((cond ? 'OK   ' : 'FAIL ') + msg); if (!cond) process.exitCode = 1; };
const myCookie = async () => (await sw.evaluate(() => chrome.cookies.getAll({ domain: '127.0.0.1' }))).filter((c) => c.name === 'am').map((c) => c.value).join(',');

// 이 크롬 사용자의 알바몬 로그인(MINE)
const pg = await browser.newPage();
await pg.goto(`http://127.0.0.1:${albaPort}/`);
await pg.setCookie({ name: 'am', value: 'MINE', url: `http://127.0.0.1:${albaPort}/` });
await pg.close();

// 1) 처음 보는 공고 4건(계정 A 2건, B 2건): 계정을 차례로 시도해 모두 채움
items = [mk(1, 'A1', 'RA'), mk(2, 'B1', 'RB'), mk(3, 'A2', 'RA'), mk(4, 'B2', 'RB')];
let s = await runAndWait();
console.log('  상태:', s);
const by = Object.fromEntries(results.map((r) => [r.apply, r]));
check(by.A1 && by.A1.ok && by.A1.phone === '01011110001' && by.A1.account_id === 1, 'A 공고 지원자: 계정 A 로 번호를 가져옴');
check(by.B1 && by.B1.ok && by.B1.phone === '01022220001' && by.B1.account_id === 2, 'B 공고 지원자: A 로 안 열리면 B 로 바꿔 가져옴');
check(by.A2 && by.A2.ok && by.B2 && by.B2.ok, '4건 모두 채움');
check(logins.filter((x) => x === 'A').length === 1 && logins.filter((x) => x === 'B').length === 1, '계정마다 로그인은 한 번');
check(learned.RA === 1 && learned.RB === 2, '공고→계정 학습(시스템에 계정 번호 전달)');
check(await myCookie() === 'MINE', '끝나면 이 크롬의 내 알바몬 로그인을 되돌림');

// 2) 같은 공고 새 지원자: 힌트로 바로 그 계정으로(다른 계정으로 헛걸음 없음), 보관 쿠키로 로그인 없이
const before = views.length, loginsBefore = logins.length;
items = [mk(5, 'B2', 'RB'), mk(6, 'A1', 'RA')];
results.length = 0;
s = await runAndWait();
const v2 = views.slice(before);
check(results.length === 2 && results.every((r) => r.ok), '힌트 있는 2건 모두 채움');
check(v2.every(([no, acct]) => OWN[no] === acct), '힌트대로 맞는 계정으로만 열어 봄(헛걸음 없음)');
check(logins.length === loginsBefore, '보관한 로그인 쿠키를 다시 써서 새로 로그인하지 않음');

// 3) B 비밀번호가 틀리게 바뀜 + 보관 쿠키 없음 → B 는 로그인 실패로 쉬고, 시스템에 알림. A 공고는 계속 처리
await sw.evaluate(() => chrome.storage.local.remove('amSess'));
accounts = [accounts[0], { ...accounts[1], pw: 'WRONG', updated_at: 2 }];
items = [mk(7, 'A2', 'RA'), mk(8, 'B1', 'RB')];
results.length = 0;
s = await runAndWait();
console.log('  상태:', s);
const r3 = Object.fromEntries(results.map((r) => [r.apply, r]));
check(r3.A2 && r3.A2.ok, '다른 계정이 막혀도 A 공고는 채움');
check(r3.B1 && !r3.B1.ok && /모두 열어 봤지만/.test(r3.B1.note), 'B 공고는 남은 계정으로 시도 후 이유와 함께 실패');
check(statusPosts.some((p) => p.account_id === 2 && /로그인 실패/.test(p.error)), '로그인 실패한 계정을 시스템에 알림');
check(/로그인이 안 돼요/.test(s), '상태 문구에 해야 할 일(비밀번호 확인)');
const loginsB = logins.length, viewsB = views.length;
items = [mk(9, 'B2', 'RB')];
s = await runAndWait();
console.log('  상태:', s, '| 로그인 기록:', logins.join(','), '| 마지막 열람:', JSON.stringify(views.slice(-3)));
check(logins.length === loginsB && !views.slice(viewsB).some(([, a]) => a === 'B'), '같은 비밀번호로는 다시 로그인 시도하지 않음(계정 잠김 방지)');
check(await myCookie() === 'MINE', '마지막에도 내 알바몬 로그인을 되돌림');

await browser.close();
alba.close(); sys.close();
process.exit(process.exitCode || 0);
