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
<select id="gwlimit"><option value="0">전부</option><option value="30">30</option><option value="100">100</option></select><ul id="gwlist"></ul><form id="gwform" data-nolock><input id="gwid"><input id="gwpw" type="password"><button type="submit">내 확장에 저장</button></form>
<div id="extlast" class="notice" hidden></div><div id="gwerr" hidden></div><div id="gwok" hidden>저장됨</div><script>${APP_JS}</script><script>${EXT_BRIDGE_JS}</script>`;
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
      if (!dup) mailIn.push({ applyNo: pr.applyNo, name: pr.name, account: JSON.parse(b).account || '' });
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
const GW2_ID = 'tester2', GW2_PW = 'Second!7&pw';
const MBX = 'MBX-TEST-' + Math.random().toString(16).slice(2, 8);   // 사람마다 다른 메일함 번호
const MBX2 = 'MBX-TWO-' + Math.random().toString(16).slice(2, 8);
const GW4_ID = 'tester4', GW4_PW = 'Fourth!4&pw';
const MBX4 = 'MBX-FOUR-' + Math.random().toString(16).slice(2, 8);
const USERS = { [GW_ID]: { pw: GW_PW, mb: MBX }, [GW2_ID]: { pw: GW2_PW, mb: MBX2 }, [GW4_ID]: { pw: GW4_PW, mb: MBX4 } };
const gwLoginUsers = [];
const gwListCalls = [];   // 목록 API 호출 {쪽, 크기}   // 로그인 화면에서 제출된 아이디 기록
const gwViews = [];   // 열어 본 메일 [{id, mb}]
let gwLoginPosts = 0;  // 로그인 화면에서 제출된 횟수
let gwFlagCalls = 0, gwWrong = 0;   // 로그인 확인 API 호출 수, 틀린 횟수
const gwBody = (name, apply) => `<table><tr><th><div>공고번호</div></th><td>111222333</td></tr>
<tr><th><div>근무회사명</div></th><td>㈜테스트-회사</td></tr><tr><th><div>공고제목</div></th><td>[테스트] 현장 직원 모집</td></tr>
<tr><th><div>이름</div></th><td>${name}(여, 33세)</td></tr><tr><th><div>주소</div></th><td>서울 강서구</td></tr>
<tr><td><a href="https://www.albamon.com/email-apply-url-route?recruitNo=111222333&amp;applyNo=${apply}">이력서 보기</a></td></tr></table>`;
const mails = [
  { id: 'M1', from: '알바몬<mailmaster@albamon.com>', subject: '[알바몬] ㈜테스트 온라인지원자 가나다', body: gwBody('가나다', '700000001') },
  { id: 'M2', from: '다른회사<hello@other.example>', subject: '광고 메일', body: '<p>광고</p>' },
  { id: 'M3', from: '알바몬<mailmaster@albamon.com>', subject: '[알바몬] ㈜테스트 온라인지원자 라마바', body: gwBody('라마바', '700000002') },
  { id: 'N1', owner: GW2_ID, from: '알바몬<mailmaster@albamon.com>', subject: '[알바몬] ㈜테스트 온라인지원자 사아자', body: gwBody('사아자', '700000011') },
  { id: 'N2', owner: GW2_ID, from: '알바몬<mailmaster@albamon.com>', subject: '[알바몬] ㈜테스트 온라인지원자 차카타', body: gwBody('차카타', '700000012') }
];
// 네 번째 계정: 알바몬 지원 메일 25통(최신이 앞) + 다른 메일 3통 — 가져올 양 설정 시험용
for (let i = 25; i >= 1; i--) mails.push({ id: 'P' + i, owner: GW4_ID, from: '알바몬<mailmaster@albamon.com>', subject: '[알바몬] 후보' + String(i).padStart(2, '0'), body: gwBody('후보' + String(i).padStart(2, '0'), String(800000000 + i)) });
for (let i = 1; i <= 3; i++) mails.push({ id: 'Q' + i, owner: GW4_ID, from: '광고<ad@other.example>', subject: '광고 ' + i, body: '<p>광고</p>' });
const whoIs = (req) => { const m = (req.headers.cookie || '').match(/gw=ok-([a-z0-9]+)/); return m ? m[1] : ''; };
const mine = (u) => mails.filter((m) => (m.owner || GW_ID) === u);
const gw = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const logged = !!whoIs(req);
  const H = { 'Content-Type': 'text/html; charset=utf-8' };
  if (u.pathname === '/gw/data/common/login/selectDepartmentList.do') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify([{ deptId: 'D1', reprsntDeptYn: 'Y' }])); }
  if (u.pathname === '/gw/data/common/login/selectLoginFlag.do') {
    let b = ''; req.on('data', (c) => (b += c));
    req.on('end', () => {
      gwFlagCalls++;
      const j = JSON.parse(b);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (!USERS[j.userId]) return res.end(JSON.stringify({ resultCode: '-20', limitErrorCnt: 0, nowErrorCnt: 0 }));
      if (USERS[j.userId].pw === j.pwd && !(req.headers.cookie || '')) return res.end(JSON.stringify({ resultCode: '0' }));
      res.end(JSON.stringify({ resultCode: '-40', limitErrorCnt: 5, nowErrorCnt: ++gwWrong }));
    });
    return;
  }
  if (u.pathname === '/login' && req.method === 'POST') {
    gwLoginPosts++;
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      const p = new URLSearchParams(b);
      gwLoginUsers.push(p.get('userId'));
      if (USERS[p.get('userId')] && USERS[p.get('userId')].pw === p.get('pwd')) { res.writeHead(302, { 'Set-Cookie': 'gw=ok-' + p.get('userId') + '; Path=/', Location: '/main' }); res.end(); }
      else { res.writeHead(200, H); res.end('<meta charset=utf-8><p>로그인 실패</p><form method="post" action="/login"><input id="cmmLogin_userId" name="userId"><input id="cmmLogin_pwd" name="pwd" type="password"><button type="submit" id="cmmLogin_login">로그인</button></form>'); }
    });
    return;
  }
  if (!logged) {
    res.writeHead(200, H);
    return res.end('<meta charset=utf-8><title>로그인</title><form method="post" action="/login"><input id="cmmLogin_userId" name="userId"><input id="cmmLogin_pwd" name="pwd" type="password"><button type="submit" id="cmmLogin_login">로그인</button></form>');
  }
  if (u.pathname === '/main') { res.writeHead(200, H); return res.end('<meta charset=utf-8><h1>그룹웨어 메인</h1>'); }
  if (u.pathname === '/mail/data/emlMail/selectMailList.do' && req.method === 'POST') {
    let b = ''; req.on('data', (c) => (b += c));
    req.on('end', () => {
      const j = JSON.parse(b || '{}');
      const me = whoIs(req);
      let list = mine(me);
      if (j.searchField === 'mailFrom') list = list.filter((m) => m.from.includes(j.keyword || ''));
      const size = Number(j.pageSize) || 30, no = Number(j.pageNo) || 1;
      gwListCalls.push({ no, size });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ totalCount: list.length, pageNo: no, pageSize: size, mailList: list.slice((no - 1) * size, no * size).map((m) => ({ mailId: m.id, mailboxId: USERS[me] ? USERS[me].mb : '', dispMailFrom: m.from })) }));
    });
    return;
  }
  if (u.pathname === '/mail/data/emlMail/selectMailView.do') {
    const id = u.searchParams.get('mailId'), mb = u.searchParams.get('mailboxId');
    gwViews.push({ id, mb });
    const me = whoIs(req);
    const m = mine(me).find((x) => x.id === id);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ mailList: [{ emlMessageVo: { content: m && USERS[me] && mb === USERS[me].mb ? m.body : '<p>메일함이 달라요</p>' } }] }));
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
    const me = whoIs(req);
    const rows = mine(me).map((m) => `<li><ul class="mail_list"><li class="checkbox"><input type="checkbox" name="key" value="${m.id}"></li></ul>
      <div class="from"><span style="display:none">${m.from.replace(/</g, '&lt;')}</span></div>
      <div class="title"><div class="subject"><a href="javascript:void(0)" id="emlList_key_${m.id}" data-mailbox-id="${USERS[me] ? USERS[me].mb : MBX}" class="not_read">${m.subject}</a></div></div></li>`).join('');
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
const setCfg = async (extra = {}) => { await sw.evaluate(() => chrome.storage.local.remove(['gwAccounts'])); return sw.evaluate((c) => chrome.storage.local.set(c), { serverUrl: `http://127.0.0.1:${sysPort}`, agentToken: TOKEN, dry: false, gwOn: false, gwId: '', gwPw: '', gwLastScan: 0, gwSeen: [], gwBlocked: false, gwForceLogin: false, gwCookieDomain: '127.0.0.1', gwLoginBase: `http://127.0.0.1:${gwPort}`, gwMailUrl: `http://127.0.0.1:${gwPort}/mail/main.do`, ...extra }); };
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
check(/로그인이 안 돼요/.test(s) && /아이디 또는 비밀번호/.test(s), '그룹웨어 비밀번호가 틀리면 "로그인이 안 돼요"와 해야 할 일을 알림');
check((await sw.evaluate(() => chrome.storage.local.get('lastLevel'))).lastLevel === 'error', '틀린 비밀번호는 "막힘(error)" 단계로 기록');
check(mailIn.length === 0 && gwViews.length === 0, '로그인이 안 되면 메일을 열지 않음');
check(gwLoginPosts === 1, '로그인은 한 번만 시도함(계정 잠김 방지, 시도 ' + gwLoginPosts + '번)');
const sBlocked = await runAndWait();
check(gwLoginPosts === 1 && /다시 시도하지 않아요/.test(sBlocked), '실패 뒤에는 다시 저장하기 전까지 로그인을 다시 시도하지 않음');

await setCfg({ gwOn: true, gwId: GW_ID, gwPw: GW_PW });
s = await runAndWait();
console.log('  상태(그룹웨어):', s);
check(mailIn.length === 2 && mailIn.map((x) => x.name).sort().join() === '가나다,라마바', '알바몬 지원 메일 2건만 가져옴(다른 발신 메일은 건너뜀)');
check(gwViews.length === 2 && gwViews.every((v) => v.mb === MBX), '메일함 번호를 목록의 속성에서 읽어 사용(고정값 아님)');
check(!gwViews.some((v) => v.id === 'M2'), '알바몬이 아닌 메일은 열지 않음');
const before = gwViews.length;
await setCfg({ gwOn: true, gwId: GW_ID, gwPw: GW_PW, gwSeen: (((await sw.evaluate(() => chrome.storage.local.get('gwAccounts'))).gwAccounts || [{}])[0].seen || []) });
await runAndWait();
check(gwViews.length === before, '이미 가져온 메일은 다시 열지 않음');
const sNone = (await sw.evaluate(() => chrome.storage.local.get(['lastStatus', 'lastLevel'])));
check(/새 메일은 없어요/.test(sNone.lastStatus) && sNone.lastLevel === 'ok', '새 메일이 없을 때도 "확인 완료: 새 메일은 없어요"로 알림');
// 메일 주소(아이디@도메인)로 입력해도 아이디 부분으로 로그인한다
await sw.evaluate(() => chrome.storage.local.set({ gwSeen: [], gwLastScan: 0 }));
await setCfg({ gwOn: true, gwId: GW_ID + '@willvi.co.kr', gwPw: GW_PW });
await sw.evaluate(() => chrome.storage.local.set({ gwSeen: [] }));
const viewsBefore = gwViews.length;
await runAndWait();
check(gwViews.length > viewsBefore, '메일 주소로 입력해도 그룹웨어 로그인이 됨(@ 앞 아이디 사용)');
// ---- 여러 그룹웨어 계정 ----
const cookieOf = (name) => sw.evaluate((n) => chrome.cookies.get({ url: 'http://127.0.0.1/', name: n }).then((c) => (c ? c.value : null)), name);
// 이 크롬의 "내 그룹웨어 로그인"은 tester 라고 두고, 계정 3개(tester, tester2, 비밀번호 확인이 필요한 tester3)를 등록한다
await sw.evaluate(() => chrome.cookies.set({ url: 'http://127.0.0.1/', name: 'gw', value: 'ok-tester', path: '/' }));
await sw.evaluate(() => chrome.cookies.set({ url: 'http://127.0.0.1/', name: 'myown', value: 'keep-me', path: '/', httpOnly: true, expirationDate: Math.floor(Date.now() / 1000) + 86400 }));
const acc = (id, pw, extra = {}) => ({ id, pw, on: true, blocked: false, force: false, seen: [], last: null, ...extra });
await sw.evaluate((a) => chrome.storage.local.set({ gwAccounts: a, gwLastScan: 0 }), [acc(GW_ID, GW_PW), acc(GW2_ID, GW2_PW), acc('tester3', 'whatever', { blocked: true })]);
const mailPre = mailIn.length, usersPre = gwLoginUsers.length;
s = await runAndWait();
console.log('  상태(여러 계정):', s);
check(mailIn.some((x) => x.name === '사아자' && x.account === 'tester2') && mailIn.some((x) => x.name === '차카타' && x.account === 'tester2'), '두 번째 계정(tester2)의 메일함에서도 지원 메일을 가져오고 계정 이름을 함께 기록함');
check(!mailIn.some((x) => x.name === '가나다' && x.account === 'tester2'), '계정별로 자기 메일함만 읽음(섞이지 않음)');
check(!gwLoginUsers.slice(usersPre).includes('tester3'), '비밀번호 확인이 필요한 계정은 건너뛰고 로그인을 시도하지 않음');
check(/tester3/.test(s) && /확인이 필요/.test(s), '건너뛴 계정은 이유와 함께 알림');
check((await cookieOf('gw')) === 'ok-tester', '여러 계정을 읽은 뒤 내 그룹웨어 로그인(쿠키)이 원래대로 돌아옴');
check((await cookieOf('myown')) === 'keep-me', '내 다른 쿠키도 그대로 돌아옴');
check(!(await sw.evaluate(() => chrome.storage.session.get('gwSwap'))).gwSwap, '쿠키 보관본은 정리됨');
// 읽는 도중 확장이 꺼졌던 경우를 흉내: 보관본만 남기고 쿠키를 바꿔 둔 뒤 복구 함수가 되돌리는지
await sw.evaluate(() => chrome.storage.session.set({ gwSwap: { domain: '127.0.0.1', snap: [{ name: 'gw', value: 'ok-tester', domain: '127.0.0.1', path: '/', secure: false, httpOnly: false, hostOnly: true, session: true, sameSite: 'unspecified', storeId: '0' }] } }));
await sw.evaluate(() => chrome.cookies.set({ url: 'http://127.0.0.1/', name: 'gw', value: 'ok-tester2', path: '/' }));
await sw.evaluate(() => recoverGwSwap());
check((await cookieOf('gw')) === 'ok-tester', '읽는 도중 꺼졌다가 켜져도 내 그룹웨어 로그인이 복구됨');


// ---- 가져올 양(설정) ----
await sw.evaluate((a) => chrome.storage.local.set({ gwAccounts: a, gwLastScan: 0, gwLimit: 10 }), [acc(GW4_ID, GW4_PW, { force: true })]);
const mailPre4 = mailIn.length, viewPre4 = gwViews.filter((v) => v.id.startsWith('P')).length;
s = await runAndWait();
console.log('  상태(최근 10통):', s);
const got4 = mailIn.slice(mailPre4);
check(got4.length === 10 && got4.every((x) => x.account === 'tester4'), '가져올 양을 "최근 10통"으로 정하면 10통만 가져옴');
check(got4.some((x) => x.name === '후보25') && !got4.some((x) => x.name === '후보15'), '최신 메일부터 가져옴(최근 10통 = 후보25~후보16)');
check(!gwViews.some((v) => v.id.startsWith('Q')), '알바몬이 보낸 메일만 목록에서 골라 읽음(광고 메일은 열지 않음)');
// 양을 "전부"로 바꾸면 남은 메일을 이어서 가져오고, 이미 가져온 10통은 다시 열지 않는다
await sw.evaluate(() => chrome.storage.local.set({ gwLimit: 0, gwLastScan: 0 }));
s = await runAndWait();
console.log('  상태(전부):', s);
check(mailIn.length - mailPre4 === 25, '"전부"로 바꾸면 나머지 15통까지 모두 가져옴(총 25통)');
check(gwViews.filter((v) => v.id.startsWith('P')).length - viewPre4 === 25, '이미 가져온 10통은 다시 열지 않음(본문 요청 25번)');
const views4 = gwViews.length;
await sw.evaluate(() => chrome.storage.local.set({ gwLastScan: 0 }));
s = await runAndWait();
check(/새 메일은 없어요/.test(s) && gwViews.length === views4, '다시 확인해도 중복은 가져오지 않음(새 메일 없음)');
check(gwListCalls.some((c) => c.no === 1 && c.size === 100), '목록은 100통씩 쪽을 넘겨 받음');
await sw.evaluate(() => chrome.storage.local.set({ gwLimit: 0 }));

const leaked = sysLog.filter((l) => l.includes(GW4_PW) || l.includes(GW2_PW) || l.includes(GW_PW) || l.includes(encodeURIComponent(GW_PW)) );
check(leaked.length === 0, '그룹웨어 비밀번호가 시스템으로 가는 요청에 전혀 없음(' + sysLog.length + '건 검사)');


// ---- 수신함 화면 ↔ 확장 연결 (그룹웨어 계정을 웹 화면에서 입력) ----
await sw.evaluate(() => chrome.storage.local.clear());
await sw.evaluate((c) => chrome.storage.local.set(c), { serverUrl: `http://127.0.0.1:${sysPort}`, gwCookieDomain: '127.0.0.1', gwLoginBase: `http://127.0.0.1:${gwPort}`, gwMailUrl: `http://127.0.0.1:${gwPort}/mail/main.do` });
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
// (0) 없는 아이디를 저장해 본다
await web.type('#gwid', 'nobody-here');
await web.type('#gwpw', 'whatever');
await web.click('#gwform button');
await web.waitForFunction(() => /없는 아이디/.test(document.getElementById('gwerr').textContent), { timeout: 15000 }).catch(() => {});
check(/없는 아이디/.test(await web.$eval('#gwerr', (e) => e.textContent)), '그룹웨어에 없는 아이디를 저장하면 "없는 아이디예요"로 알림');
await sw.evaluate(() => chrome.storage.local.set({ gwAccounts: [] }));
await web.$eval('#gwid', (e) => { e.value = ''; });
await web.$eval('#gwpw', (e) => { e.value = ''; });
// (1) 일부러 틀린 비밀번호를 저장해 본다: 이 크롬은 이미 그룹웨어에 로그인된 상태여도 틀린 비밀번호를 알아채야 한다
const viewsPre = gwViews.length, flagPre = gwFlagCalls;
await web.type('#gwid', GW_ID);
await web.type('#gwpw', 'wrong-password');
await web.click('#gwform button');
await web.waitForFunction(() => /맞지 않아요/.test(document.getElementById('extlast').textContent), { timeout: 15000 }).catch(() => {});
const tWrong = await web.$eval('#extlast', (e) => ({ text: e.textContent, cls: e.className }));
console.log('  화면 결과(틀린 비밀번호):', tWrong.text);
check(/맞지 않아요/.test(tWrong.text) && /틀린 횟수 \d+\/5/.test(tWrong.text), '틀린 비밀번호를 저장하면 바로 "맞지 않아요"와 틀린 횟수를 알림');
check(/warn/.test(tWrong.cls), '화면에 경고 색으로 표시');
const errBox = await web.$eval('#gwerr', (e) => ({ hidden: e.hidden, text: e.textContent }));
check(!errBox.hidden && /맞지 않아요/.test(errBox.text), '입력칸 바로 아래에도 "맞지 않아요" 오류가 보임');
check((await web.$eval('#gwpw', (e) => e.value)) === 'wrong-password', '틀렸을 때는 입력한 값을 지우지 않아 고칠 수 있음');
check((await web.$eval('#gwok', (e) => e.hidden)) === true, '틀렸을 때는 "저장했어요" 성공 안내를 보이지 않음');
check(gwFlagCalls === flagPre + 1 && gwViews.length === viewsPre, '저장 때 확인 요청은 한 번만, 메일은 읽지 않음');
check((((await sw.evaluate(() => chrome.storage.local.get('gwAccounts'))).gwAccounts || [])[0] || {}).blocked === true, '틀리면 자동 재시도를 막음(계정 잠김 방지)');
// (2) 올바른 비밀번호로 다시 저장
const postsPre = gwLoginPosts;
await web.$eval('#gwpw', (e) => { e.value = ''; });
await web.type('#gwpw', GW_PW);
await web.click('#gwform button');
await web.waitForFunction(() => /그룹웨어 계정 \d개 등록됨/.test(document.getElementById('extstate').textContent) && !/⚠/.test(document.getElementById('extstate').textContent), { timeout: 15000 }).catch(() => {});
const t2 = await web.$eval('#extstate', (e) => e.textContent);
console.log('  화면 상태(저장 뒤):', t2);
const stored = ((await sw.evaluate(() => chrome.storage.local.get('gwAccounts'))).gwAccounts || [])[0] || {};
check(stored.id === GW_ID && stored.pw === GW_PW && stored.on === true, '그룹웨어 아이디·비밀번호가 확장 저장소에 들어감');
check(/계정 1개 등록됨/.test(t2) && !t2.includes(GW_PW), '화면에는 저장 여부만 보이고 비밀번호는 보이지 않음');
check((await web.$eval('#gwpw', (e) => e.value)) === '', '확인에 성공하면 비밀번호 입력칸은 비워짐');
check((await web.$eval('#gwok', (e) => e.hidden)) === false && (await web.$eval('#gwerr', (e) => e.hidden)) === true, '성공하면 성공 안내만 보이고 오류는 사라짐');
await sleep(300);
const btn = await web.$eval('#gwform button', (e) => ({ disabled: e.disabled, text: e.textContent.trim() }));
check(!btn.disabled && !/처리 중/.test(btn.text), '저장 버튼이 "처리 중…"으로 잠기지 않음(공통 스크립트와 함께 시험)');
const htmlNow = await web.content();
check(!htmlNow.includes(GW_PW), '화면 어디에도 비밀번호가 남지 않음');
await sleep(3500);   // 저장 뒤 자동 실행이 끝날 시간
check(gwLoginPosts > postsPre, '새 계정을 저장하면 이미 로그인된 세션이 있어도 저장한 계정으로 다시 로그인함(엉뚱한 메일함 방지)');
const leaked2 = sysLog.slice(sentBefore).filter((l) => l.includes(GW_PW) || l.includes(encodeURIComponent(GW_PW)));
check(leaked2.length === 0, '화면에서 저장해도 비밀번호가 시스템 서버로 가는 요청에 없음(' + (sysLog.length - sentBefore) + '건 검사)');
// 가져올 양 선택: 화면에서 고르면 확장에 저장되고, 다시 열면 그 값이 보인다
await web.select('#gwlimit', '100');
await sleep(800);
check((await sw.evaluate(() => chrome.storage.local.get('gwLimit'))).gwLimit === 100, '화면에서 "가져올 양"을 고르면 확장에 저장됨');
await sleep(3500);
check((await web.$eval('#gwlimit', (e) => e.value)) === '100', '확장이 알려 주는 값으로 선택칸이 유지됨');
await web.select('#gwlimit', '0');
await sleep(500);
// 두 번째 계정을 화면에서 추가하고, 목록에 보이고, 삭제할 수 있는지
await web.type('#gwid', GW2_ID);
await web.type('#gwpw', GW2_PW);
await web.click('#gwform button[type=submit]');
await web.waitForFunction(() => document.querySelectorAll('#gwlist li').length === 2, { timeout: 15000 }).catch(() => {});
const lis = await web.$$eval('#gwlist li', (els) => els.map((e) => e.textContent));
console.log('  등록된 계정 목록:', JSON.stringify(lis.map((t) => t.slice(0, 40))));
check(lis.length === 2 && lis.some((t) => t.includes(GW_ID)) && lis.some((t) => t.includes(GW2_ID)), '화면에 등록된 계정 두 개가 목록으로 보임');
check(!(await web.content()).includes(GW2_PW), '두 번째 계정의 비밀번호도 화면에 남지 않음');
web.on('dialog', (d) => d.accept());
await web.evaluate(() => { [...document.querySelectorAll('#gwlist li')].find((li) => li.textContent.includes('tester2') && !li.textContent.startsWith('tester ')).querySelector('button').click(); });
await web.waitForFunction(() => document.querySelectorAll('#gwlist li').length === 1, { timeout: 15000 }).catch(() => {});
check((await web.$$eval('#gwlist li', (els) => els.length)) === 1, '삭제하면 목록에서 사라짐');
check(!(((await sw.evaluate(() => chrome.storage.local.get('gwAccounts'))).gwAccounts || []).some((a) => a.id === GW2_ID)), '삭제하면 확장 저장소에서도(비밀번호 포함) 지워짐');
await web.close();

await browser.close().catch(() => {});
try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
alba.close(); sys.close();
process.exit(process.exitCode || 0);
