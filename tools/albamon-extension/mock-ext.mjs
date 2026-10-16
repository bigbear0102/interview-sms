// 크롬 확장 동작 시험: 가짜 알바몬 + 가짜 시스템 서버를 띄워 로그인 → 연락처 보기 → 번호 읽기 → 결과 전달을 확인한다.
// 사용: node mock-ext.mjs   (크롬이 설치되어 있어야 한다. 실제 알바몬/시스템에는 접속하지 않는다)
import http from 'node:http';
import { createRequire } from 'node:module';
import { cpSync, readFileSync } from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const puppeteer = createRequire(join(HERE, '..', 'albamon-agent', 'package.json'))('puppeteer-core');
const TOKEN = 'ag_' + 'a'.repeat(48);
const results = [];
const items = [
  { id: 1, apply_no: '111', name: '홍길동', resume_url: '' },     // 정상: 버튼 클릭 → 번호
  { id: 2, apply_no: '222', name: '박민수', resume_url: '' },     // 번호가 이미 보이는 페이지
  { id: 3, apply_no: '333', name: '이영희', resume_url: '' },     // 이용권 차감 확인 창 → 멈춤
  { id: 4, apply_no: '444', name: '최수아', resume_url: '' }      // (3번에서 멈추므로 처리되지 않아야 함)
];
const pending = new Set([1, 2, 3, 4]);

// ---- 가짜 알바몬 ----
const alba = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const logged = (req.headers.cookie || '').includes('sid=ok');
  if (u.pathname === '/user-account/login') {
    if (req.method === 'POST') {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        const p = new URLSearchParams(b);
        if (p.get('id') === 'corp' && p.get('pw') === 'secret') { res.writeHead(302, { 'Set-Cookie': 'sid=ok; Path=/', Location: '/' }); res.end(); }
        else { res.writeHead(401); res.end('fail'); }
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><meta charset=utf-8><title>로그인</title>
      <ul><li>개인회원</li><li id="corp">기업회원</li></ul>
      <form method="post" action="/user-account/login"><input name="id" type="text"><input name="pw" type="password"><button type="submit">로그인</button></form>`);
  }
  if (u.pathname === '/login-as') { res.writeHead(200, { 'Set-Cookie': 'sid=ok; Path=/', 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (u.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end('<meta charset=utf-8><h1>홈</h1>'); }
  if (u.pathname === '/resume') {
    if (!logged) { res.writeHead(302, { Location: '/user-account/login' }); return res.end(); }
    const no = u.searchParams.get('applyNo');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (no === '222') return res.end(`<meta charset=utf-8><h1>이력서</h1><p>이름 박민수</p><p>연락처 010-5555-6666</p><p>회사 대표번호 02-123-4567</p>`);
    if (no === '333') {
      return res.end(`<meta charset=utf-8><h1>이력서</h1><p>이름 이영희</p><p>연락처 <button id="b" onclick="document.getElementById('m').style.display='block'">연락처 보기</button></p>
        <div id="m" role="dialog" style="display:none">이용권 1개가 차감됩니다. 계속하시겠습니까?<button>확인</button></div>`);
    }
    return res.end(`<meta charset=utf-8><h1>이력서</h1><p>이름 홍길동</p><p>연락처 <span id="p"><button onclick="document.getElementById('p').textContent='010-1234-5678'">연락처 보기</button></span></p>`);
  }
  res.writeHead(404); res.end();
});

// ---- 가짜 시스템(에이전트 API) ----
const sys = http.createServer((req, res) => {
  if ((req.headers.authorization || '') !== 'Bearer ' + TOKEN) { res.writeHead(401); return res.end('{}'); }
  const u = new URL(req.url, 'http://x');
  res.setHeader('Content-Type', 'application/json');
  if (u.pathname === '/api/agent/inbox') {
    const list = items.filter((i) => pending.has(i.id)).slice(0, 5);
    return res.end(JSON.stringify({ items: list }));
  }
  const m = u.pathname.match(/^\/api\/agent\/inbox\/(\d+)\/result$/);
  if (m && req.method === 'POST') {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => { const body = JSON.parse(b); results.push({ id: Number(m[1]), ...body }); pending.delete(Number(m[1])); res.end('{"ok":true}'); });
    return;
  }
  res.writeHead(404); res.end('{}');
});

const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const albaPort = await listen(alba);
const sysPort = await listen(sys);
items.forEach((i) => { i.resume_url = `http://127.0.0.1:${albaPort}/resume?applyNo=${i.apply_no}`; });


// 시험용 확장: 접속 허용 주소만 가짜 서버로 바꾼다
const dir = mkdtempSync(join(tmpdir(), 'ext-test-'));
cpSync(HERE, dir, { recursive: true, filter: (p) => !/mock-ext/.test(p) });
const mf = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
mf.host_permissions = ['http://127.0.0.1/*'];
writeFileSync(join(dir, 'manifest.json'), JSON.stringify(mf));

const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find((p) => existsSync(p));
const browser = await puppeteer.launch({
  executablePath: chrome, headless: false, userDataDir: join(dir, 'profile'), pipe: true, enableExtensions: true,
  args: ['--no-first-run', '--window-position=-2000,0', '--window-size=800,600']
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await browser.installExtension(dir);
const wt = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().includes('background.js'), { timeout: 20000 });
const sw = await wt.worker();
const setCfg = (extra = {}) => sw.evaluate((c) => chrome.storage.local.set(c), { serverUrl: `http://127.0.0.1:${sysPort}`, agentToken: TOKEN, dry: false, ...extra });
const status = () => sw.evaluate(() => chrome.storage.local.get('lastStatus')).then((r) => r.lastStatus || '');
const runAndWait = async (ms = 90000) => {
  await sw.evaluate(() => chrome.storage.local.remove('lastStatus'));
  await Promise.race([sw.evaluate(() => run()), sleep(ms)]);
  return status();
};
const check = (cond, msg) => { console.log((cond ? 'OK   ' : 'FAIL ') + msg); if (!cond) process.exitCode = 1; };

// 1) 로그인 안 된 상태
await setCfg();
let s = await runAndWait();
console.log('  상태:', s);
check(/로그인이 필요/.test(s), '알바몬 로그인 전에는 "로그인이 필요해요"로 멈춤');
check(results.length === 0, '로그인 전에는 결과를 보내지 않음');

// 2) 로그인 후
const pg = await browser.newPage();
await pg.goto(`http://127.0.0.1:${albaPort}/login-as`);
await pg.close();
s = await runAndWait();
console.log('  상태:', s);
const byId = Object.fromEntries(results.map((r) => [r.id, r]));
check(byId[1] && byId[1].ok && byId[1].phone === '01012345678', '1번: 연락처 보기를 눌러 번호를 가져옴');
check(byId[2] && byId[2].ok && byId[2].phone === '01055556666', '2번: 이미 보이는 번호(대표번호 제외)');
check(byId[3] && !byId[3].ok && /이용권|차감|결제/.test(byId[3].note), '3번: 이용권 차감 창이면 누르지 않고 실패 처리');
check(!byId[4], '4번: 차감 창에서 멈췄으므로 처리하지 않음');
check(/이용권/.test(s), '상태 문구에 이용권 확인 안내');

await browser.close().catch(() => {});
try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
alba.close(); sys.close();
process.exit(process.exitCode || 0);
