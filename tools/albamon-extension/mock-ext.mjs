// 크롬 확장 동작 시험: 가짜 알바몬 + 가짜 시스템 서버를 띄워 로그인 → 연락처 보기 → 번호 읽기 → 결과 전달을 확인한다.
// 사용: node mock-ext.mjs   (크롬이 설치되어 있어야 한다. 실제 알바몬/시스템에는 접속하지 않는다)
import http from 'node:http';
import { createRequire } from 'node:module';
import { cpSync, readFileSync } from 'node:fs';
import { parseAlbamonApply } from '../../src/mail-intake.js';
import { EXT_BRIDGE_JS } from '../../src/ext-bridge-page.js';
import { APP_JS } from '../../src/appjs.js';
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
const sysLog = [];      // 시스템 서버가 받은 모든 요청(주소·머리말·본문)
const mailIn = [];      // /api/agent/mail 로 받아 해석한 결과
const PAGE = `<!doctype html><meta charset=utf-8><title>수신함</title>
<div id="extstate" class="notice">확인 중…</div>
<form id="gwform" data-nolock><input id="gwid"><input id="gwpw" type="password"><button type="submit">내 확장에 저장</button></form>
<div id="gwok" hidden>저장됨</div><script>${APP_JS}</script><script>${EXT_BRIDGE_JS}</script>`;
const sys = http.createServer((req, res) => {
  if (req.url === '/applicants/inbox/agent-token.json' && req.method === 'POST') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ token: TOKEN })); }
  if (req.url.startsWith('/applicants/inbox')) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(PAGE); }
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => sysLog.push(req.method + ' ' + req.url + ' ' + JSON.stringify(req.headers) + ' ' + raw));
  if ((req.headers.authorization || '') !== 'Bearer ' + TOKEN) { res.writeHead(401); return res.end('{}'); }
  const u = new URL(req.url, 'http://x');
  res.setHeader('Content-Type', 'application/json');
  if (u.pathname === '/api/agent/mail' && req.method === 'POST') {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      const pr = parseAlbamonApply(JSON.parse(b).html);
      if (!pr || !pr.name) return res.end(JSON.stringify({ ok: false, reason: 'not_albamon' }));
      const dup = mailIn.some((x) => x.applyNo === pr.applyNo);
      if (!dup) mailIn.push({ applyNo: pr.applyNo, name: pr.name });
      res.end(JSON.stringify({ ok: true, duplicate: dup }));
    });
    return;
  }
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


// ---- 가짜 그룹웨어 (로그인 화면 + 실제와 같은 모양의 메일 목록 + 메일 보기) ----
const GW_ID = 'tester', GW_PW = 'Pw!9&zq*test';
const MBX = 'MBX-TEST-' + Math.random().toString(16).slice(2, 8);   // 사람마다 다른 메일함 번호
const gwViews = [];   // 열어 본 메일 [{id, mb}]
const gwBody = (name, apply) => `<table><tr><th><div>공고번호</div></th><td>111222333</td></tr>
<tr><th><div>근무회사명</div></th><td>㈜테스트-회사</td></tr><tr><th><div>공고제목</div></th><td>[테스트] 현장 직원 모집</td></tr>
<tr><th><div>이름</div></th><td>${name}(여, 33세)</td></tr><tr><th><div>주소</div></th><td>서울 강서구</td></tr>
<tr><td><a href="https://www.albamon.com/email-apply-url-route?recruitNo=111222333&amp;applyNo=${apply}">이력서 보기</a></td></tr></table>`;
const mails = [
  { id: 'M1', from: '알바몬<mailmaster@albamon.com>', subject: '[알바몬] ㈜테스트 온라인지원자 가나다', body: gwBody('가나다', '700000001') },
  { id: 'M2', from: '다른회사<hello@other.example>', subject: '광고 메일', body: '<p>광고</p>' },
  { id: 'M3', from: '알바몬<mailmaster@albamon.com>', subject: '[알바몬] ㈜테스트 온라인지원자 라마바', body: gwBody('라마바', '700000002') }
];
const gw = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const logged = (req.headers.cookie || '').includes('gw=ok');
  const H = { 'Content-Type': 'text/html; charset=utf-8' };
  if (u.pathname === '/login' && req.method === 'POST') {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      const p = new URLSearchParams(b);
      if (p.get('userId') === GW_ID && p.get('pwd') === GW_PW) { res.writeHead(302, { 'Set-Cookie': 'gw=ok; Path=/', Location: '/main' }); res.end(); }
      else { res.writeHead(200, H); res.end('<meta charset=utf-8><p>로그인 실패</p><form method="post" action="/login"><input id="cmmLogin_userId" name="userId"><input id="cmmLogin_pwd" name="pwd" type="password"><button type="submit" id="cmmLogin_login">로그인</button></form>'); }
    });
    return;
  }
  if (!logged) {
    res.writeHead(200, H);
    return res.end('<meta charset=utf-8><title>로그인</title><form method="post" action="/login"><input id="cmmLogin_userId" name="userId"><input id="cmmLogin_pwd" name="pwd" type="password"><button type="submit" id="cmmLogin_login">로그인</button></form>');
  }
  if (u.pathname === '/main') { res.writeHead(200, H); return res.end('<meta charset=utf-8><h1>그룹웨어 메인</h1>'); }
  if (u.pathname === '/mail/data/emlMail/selectMailView.do') {
    const id = u.searchParams.get('mailId'), mb = u.searchParams.get('mailboxId');
    gwViews.push({ id, mb });
    const m = mails.find((x) => x.id === id);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ mailList: [{ emlMessageVo: { content: m && mb === MBX ? m.body : '<p>메일함이 달라요</p>' } }] }));
  }
  if (u.pathname === '/mail/main.do') {
    res.writeHead(200, H);
    if (u.searchParams.get('mode') === 'view') {
      const id = u.searchParams.get('mailId'), mb = u.searchParams.get('mailboxId');
      gwViews.push({ id, mb });
      const m = mails.find((x) => x.id === id);
      return res.end('<meta charset=utf-8><div id="view">' + (m && mb === MBX ? m.body : '<p>메일함이 달라요</p>') + '</div>');
    }
    // 목록은 화면이 열린 뒤 조금 있다가 채워진다(실제 그룹웨어처럼)
    const rows = mails.map((m) => `<li><ul class="mail_list"><li class="checkbox"><input type="checkbox" name="key" value="${m.id}"></li></ul>
      <div class="from"><span style="display:none">${m.from.replace(/</g, '&lt;')}</span></div>
      <div class="title"><div class="subject"><a href="javascript:void(0)" id="emlList_key_${m.id}" data-mailbox-id="${MBX}" class="not_read">${m.subject}</a></div></div></li>`).join('');
    return res.end(`<meta charset=utf-8><ul id="list"></ul><script>setTimeout(function(){document.getElementById('list').innerHTML=${JSON.stringify(rows)};},700);</script>`);
  }
  res.writeHead(404); res.end();
});

const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const albaPort = await listen(alba);
const sysPort = await listen(sys);
const gwPort = await listen(gw);
items.forEach((i) => { i.resume_url = `http://127.0.0.1:${albaPort}/resume?applyNo=${i.apply_no}`; });


// 시험용 확장: 접속 허용 주소만 가짜 서버로 바꾼다
const dir = mkdtempSync(join(tmpdir(), 'ext-test-'));
cpSync(HERE, dir, { recursive: true, filter: (p) => !/mock-ext/.test(p) });
const mf = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
mf.host_permissions = ['http://127.0.0.1/*'];
mf.content_scripts[0].matches = ['http://127.0.0.1/applicants/inbox*'];
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
const setCfg = (extra = {}) => sw.evaluate((c) => chrome.storage.local.set(c), { serverUrl: `http://127.0.0.1:${sysPort}`, agentToken: TOKEN, dry: false, gwOn: false, gwId: '', gwPw: '', gwLastScan: 0, gwSeen: [], gwMailUrl: `http://127.0.0.1:${gwPort}/mail/main.do`, ...extra });
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


// ---- 그룹웨어 메일 가져오기 ----
await setCfg({ gwOn: true, gwId: GW_ID, gwPw: 'wrong-password' });
s = await runAndWait();
console.log('  상태(틀린 비밀번호):', s);
check(/로그인이 안 돼요/.test(s), '그룹웨어 비밀번호가 틀리면 "로그인이 안 돼요"로 알림');
check(mailIn.length === 0 && gwViews.length === 0, '로그인이 안 되면 메일을 열지 않음');

await setCfg({ gwOn: true, gwId: GW_ID, gwPw: GW_PW });
s = await runAndWait();
console.log('  상태(그룹웨어):', s);
check(mailIn.length === 2 && mailIn.map((x) => x.name).sort().join() === '가나다,라마바', '알바몬 지원 메일 2건만 가져옴(다른 발신 메일은 건너뜀)');
check(gwViews.length === 2 && gwViews.every((v) => v.mb === MBX), '메일함 번호를 목록의 속성에서 읽어 사용(고정값 아님)');
check(!gwViews.some((v) => v.id === 'M2'), '알바몬이 아닌 메일은 열지 않음');
const before = gwViews.length;
await setCfg({ gwOn: true, gwId: GW_ID, gwPw: GW_PW, gwSeen: (await sw.evaluate(() => chrome.storage.local.get('gwSeen'))).gwSeen });
await runAndWait();
check(gwViews.length === before, '이미 가져온 메일은 다시 열지 않음');
// 메일 주소(아이디@도메인)로 입력해도 아이디 부분으로 로그인한다
await sw.evaluate(() => chrome.storage.local.set({ gwSeen: [], gwLastScan: 0 }));
await setCfg({ gwOn: true, gwId: GW_ID + '@willvi.co.kr', gwPw: GW_PW });
await sw.evaluate(() => chrome.storage.local.set({ gwSeen: [] }));
const viewsBefore = gwViews.length;
await runAndWait();
check(gwViews.length > viewsBefore, '메일 주소로 입력해도 그룹웨어 로그인이 됨(@ 앞 아이디 사용)');
const leaked = sysLog.filter((l) => l.includes(GW_PW) || l.includes(encodeURIComponent(GW_PW)) || l.includes(GW_ID + '"') );
check(leaked.length === 0, '그룹웨어 비밀번호가 시스템으로 가는 요청에 전혀 없음(' + sysLog.length + '건 검사)');


// ---- 수신함 화면 ↔ 확장 연결 (그룹웨어 계정을 웹 화면에서 입력) ----
await sw.evaluate(() => chrome.storage.local.clear());
await sw.evaluate((c) => chrome.storage.local.set(c), { serverUrl: `http://127.0.0.1:${sysPort}`, gwMailUrl: `http://127.0.0.1:${gwPort}/mail/main.do` });
const web = await browser.newPage();
const sentBefore = sysLog.length;
await web.goto(`http://127.0.0.1:${sysPort}/applicants/inbox`, { waitUntil: 'load' });
await web.waitForFunction(() => /연결됨/.test(document.getElementById('extstate').textContent), { timeout: 15000 }).catch(() => {});
const t1 = await web.$eval('#extstate', (e) => e.textContent);
console.log('  화면 상태:', t1);
check(/확장 프로그램: 연결됨/.test(t1), '화면이 확장 프로그램을 알아봄');
await sleep(1500);
const afterKey = await sw.evaluate(() => chrome.storage.local.get(['agentToken', 'serverUrl']));
check(afterKey.agentToken === TOKEN, '연결 키가 없으면 화면이 자동으로 만들어 확장에 넣음(입력 불필요)');
await web.type('#gwid', GW_ID);
await web.type('#gwpw', GW_PW);
await web.click('#gwform button');
await web.waitForFunction(() => /그룹웨어 계정 저장됨/.test(document.getElementById('extstate').textContent), { timeout: 15000 }).catch(() => {});
const t2 = await web.$eval('#extstate', (e) => e.textContent);
console.log('  화면 상태(저장 뒤):', t2);
const stored = await sw.evaluate(() => chrome.storage.local.get(['gwId', 'gwPw', 'gwOn']));
check(stored.gwId === GW_ID && stored.gwPw === GW_PW && stored.gwOn === true, '그룹웨어 아이디·비밀번호가 확장 저장소에 들어감');
check(/비밀번호 저장됨/.test(t2) && !t2.includes(GW_PW), '화면에는 저장 여부만 보이고 비밀번호는 보이지 않음');
check((await web.$eval('#gwpw', (e) => e.value)) === '', '저장 뒤 비밀번호 입력칸은 비워짐');
await sleep(300);
const btn = await web.$eval('#gwform button', (e) => ({ disabled: e.disabled, text: e.textContent.trim() }));
check(!btn.disabled && !/처리 중/.test(btn.text), '저장 버튼이 "처리 중…"으로 잠기지 않음(공통 스크립트와 함께 시험)');
const htmlNow = await web.content();
check(!htmlNow.includes(GW_PW), '화면 어디에도 비밀번호가 남지 않음');
await sleep(3500);   // 저장 뒤 자동 실행이 끝날 시간
const leaked2 = sysLog.slice(sentBefore).filter((l) => l.includes(GW_PW) || l.includes(encodeURIComponent(GW_PW)));
check(leaked2.length === 0, '화면에서 저장해도 비밀번호가 시스템 서버로 가는 요청에 없음(' + (sysLog.length - sentBefore) + '건 검사)');
await web.close();

await browser.close().catch(() => {});
try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
alba.close(); sys.close();
process.exit(process.exitCode || 0);
