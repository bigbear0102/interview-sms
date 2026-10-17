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
const clicks = [];   // 가짜 알바몬에서 "연락처 보기"가 눌린 이력서
let buys = 0;        // 결제 버튼이 눌린 횟수(0이어야 함)
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
  if (u.pathname === '/clicked') { clicks.push(u.searchParams.get('no')); res.writeHead(200); return res.end('ok'); }
  if (u.pathname === '/buy') { buys++; res.writeHead(200); return res.end('ok'); }
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
    // 늦게 그려지는 화면 / 번호가 늦게 나타남 / 이용권과 무관한 확인 창 / 삭제된 이력서 / 연락처 보기 버튼이 없는 화면
    if (no === '411') return res.end(`<meta charset=utf-8><h1>이력서</h1><div id="c">이력서를 불러오는 중…</div><script>setTimeout(function(){document.getElementById('c').innerHTML='<p>이름 지연생성</p><p>연락처 <span id="p"><button onclick="document.getElementById(\\'p\\').textContent=\\'010-4110-0411\\'">연락처 보기</button></span></p>';},3500);</script>`);
    if (no === '412') return res.end(`<meta charset=utf-8><h1>이력서</h1><p>이름 늦게나옴</p><p>연락처 <span id="p"><button onclick="setTimeout(function(){document.getElementById('p').textContent='010-4120-0412'},3000)">연락처 보기</button></span></p>`);
    if (no === '413') return res.end(`<meta charset=utf-8><h1>이력서</h1><p>이름 확인창</p><p>연락처 <span id="p"><button onclick="document.getElementById('d').style.display='block'">연락처 보기</button></span></p><div id="d" role="dialog" style="display:none">연락처를 확인하시겠습니까? <button onclick="document.getElementById('p').textContent='010-4130-0413';document.getElementById('d').style.display='none'">확인</button></div>`);
    if (no === '414') return res.end(`<meta charset=utf-8><h1>이력서</h1><p>삭제된 이력서입니다.</p>`);
    // v1.9 이력서 전체: 정의 목록·표·구역 제목·접힌 자기소개(더보기). 결제 버튼은 누르면 안 됨.
    if (no === '416' || no === '417') return res.end(`<meta charset=utf-8><title>이력서 보기</title><h1>이력서</h1>
      <section><h2>기본정보</h2><dl><dt>이름</dt><dd>${no === '416' ? '전체읽기' : '다시읽기'}</dd><dt>이메일</dt><dd>full@example.com</dd><dt>생년월일</dt><dd>1995.03.04 (31세)</dd></dl>
      <p>연락처 <span id="p"><button onclick="fetch('/clicked?no=${no}');document.getElementById('p').textContent='010-4160-0416'">연락처 보기</button></span></p></section>
      <section><h2>희망근무조건</h2><table><tr><th>희망근무지</th><td>서울 강남구</td></tr><tr><th>근무형태</th><td>알바</td><td>주말</td></tr></table></section>
      <section><h2>경력사항</h2><p>아마노코리아 주차관리 2년</p></section>
      <section><h2>자격증</h2><table><tr><th>자격증</th><td>운전면허 1종 보통</td></tr></table></section>
      <section><h2>자기소개</h2><p>성실하게 일하겠습니다.</p><div id="more" style="display:none">야간 근무도 가능합니다.</div><button onclick="document.getElementById('more').style.display='block'">더보기</button></section>
      <button onclick="fetch('/buy')">열람권 구매</button>`);
    if (no === '415') return res.end(`<meta charset=utf-8><h1>이력서</h1><p>이름 버튼없음</p><button>스크랩</button><button>인쇄</button>`);
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
  if (u.pathname === '/mail/data/emlMail/selectMailList.do' && req.method === 'POST' && !logged) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end('<html>로그인</html>'); }
  if (u.pathname === '/robots.txt') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('User-agent: *'); }
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

const chrome = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].filter(Boolean).find((p) => existsSync(p));
const browser = await puppeteer.launch({
  executablePath: chrome, headless: false, userDataDir: join(dir, 'profile'), pipe: true, enableExtensions: true,
  args: ['--no-first-run', '--no-sandbox', '--window-position=-2000,0', '--window-size=800,600']
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
check(byId[4] && byId[4].ok, '4번: 여러 건을 동시에 읽으므로 3번이 멈춰도 같이 읽던 건은 정상 처리됨');
check(/이용권/.test(s), '상태 문구에 이용권 확인 안내');



// ---- 이력서 읽기 견고성: 늦게 그려지는 화면, 늦게 나타나는 번호, 확인 창, 삭제된 이력서, 버튼 없는 화면 ----
pending.delete(4);
for (const [id, no, nm] of [[11, '411', '지연생성'], [12, '412', '늦게나옴'], [13, '413', '확인창'], [14, '414', '삭제됨'], [15, '415', '버튼없음']]) {
  items.push({ id, apply_no: no, name: nm, resume_url: `http://127.0.0.1:${albaPort}/resume?applyNo=${no}` });
  pending.add(id);
}
await setCfg();
const tRead = Date.now();
s = await runAndWait(150000);
console.log('  상태(이력서 읽기):', s, ' (' + Math.round((Date.now() - tRead) / 1000) + '초)');
const rr = Object.fromEntries(results.map((r) => [r.id, r]));
console.log('  결과 기록:', JSON.stringify(Object.values(rr).filter((x) => x.id >= 11).map((x) => ({ id: x.id, ok: x.ok, note: String(x.note).slice(0, 90) }))));
check(rr[11] && rr[11].ok && rr[11].phone === '01041100411', '화면이 3.5초 늦게 그려져도 기다렸다가 연락처 보기를 눌러 번호를 가져옴');
check(rr[12] && rr[12].ok && rr[12].phone === '01041200412', '번호가 누른 뒤 3초 늦게 나타나도 기다렸다가 가져옴');
check(rr[13] && rr[13].ok && rr[13].phone === '01041300413', '이용권과 상관없는 "연락처를 확인하시겠습니까?" 창은 확인을 눌러 번호를 가져옴');
check(rr[14] && !rr[14].ok && /찾을 수 없어요/.test(rr[14].note), '삭제된 이력서는 "찾을 수 없어요"로 이유를 남김');
check(rr[15] && !rr[15].ok && /연락처 보기 버튼을 찾지 못했어요/.test(rr[15].note) && /스크랩/.test(rr[15].note), '버튼이 없으면 이유와 함께 화면에 있던 버튼 이름을 남김(원인 파악용)');

// ---- v1.9: 이력서 전체 읽기, 이력서만 다시 읽기(연락처 보기는 누르지 않음) ----
for (const [id, no, nm, ro] of [[16, '416', '전체읽기', 0], [17, '417', '다시읽기', 1]]) {
  items.push({ id, apply_no: no, name: nm, resume_only: ro, resume_url: `http://127.0.0.1:${albaPort}/resume?applyNo=${no}` });
  pending.add(id);
}
await setCfg();
s = await runAndWait(120000);
const rv = Object.fromEntries(results.map((r) => [r.id, r]));
const r16 = rv[16] && rv[16].resume, r17 = rv[17] && rv[17].resume;
const has = (r, k, v) => r && r.pairs.some(([a, b]) => a === k && b.includes(v));
console.log('  이력서 읽기 결과(16):', JSON.stringify(r16 && { pairs: r16.pairs, sections: r16.sections, textLen: r16.text.length }));
check(rv[16] && rv[16].ok && rv[16].phone === '01041600416', '이력서 전체 읽기: 연락처도 함께 가져옴');
check(has(r16, '이메일', 'full@example.com') && has(r16, '생년월일', '1995.03.04') && has(r16, '희망근무지', '서울 강남구') && has(r16, '근무형태', '알바 / 주말') && has(r16, '자격증', '운전면허'), '이력서의 항목·값(정의 목록·표)을 모두 보냄');
check(r16 && ['기본정보', '희망근무조건', '경력사항', '자격증', '자기소개'].every((x) => r16.sections.includes(x)), '이력서의 구역 제목을 보냄');
check(r16 && /야간 근무도 가능합니다/.test(r16.text) && /아마노코리아 주차관리 2년/.test(r16.text), '접힌 "더보기" 내용까지 펼쳐서 글 전체를 보냄');
check(buys === 0, '결제(열람권 구매) 버튼은 누르지 않음');
check(rv[17] && rv[17].ok && rv[17].phone === '' && r17 && has(r17, '이메일', 'full@example.com'), '이력서만 다시 읽기: 이력서 내용을 보냄');
check(!clicks.includes('417') && clicks.includes('416'), '이력서만 다시 읽기에서는 연락처 보기 버튼을 누르지 않음');
check(sysLog.some((l) => /GET \/api\/agent\/inbox/.test(l) && /"x-ext-version":"1\.9\.1"/.test(l)), '시스템에 확장 버전을 알림(예전 확장에는 이력서만 읽기 요청을 주지 않도록)');

// ---- v1.8: 예전 버전이 저장한 그룹웨어 계정·비밀번호를 지운다(그룹웨어 메일은 시스템이 POP3 로 직접) ----
await sw.evaluate(() => chrome.storage.local.set({ gwAccounts: [{ id: 'x', pw: 'old-secret' }], gwId: 'x', gwPw: 'old-secret', gwSeen: ['1'] }));
await sw.evaluate(() => cleanupOld());
const leftover = await sw.evaluate(() => chrome.storage.local.get(['gwAccounts', 'gwId', 'gwPw', 'gwSeen']));
check(Object.keys(leftover).length === 0, '예전 그룹웨어 계정·비밀번호·메일 기록을 확장 저장소에서 지움');
check(typeof (await sw.evaluate(() => typeof scanGroupware)) === 'string' && (await sw.evaluate(() => typeof scanGroupware)) === 'undefined', '그룹웨어 메일 가져오기 기능이 없음(연락처 전용)');

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
// 화면에서 연락처 가져오기를 누르면(kick) 30초 알람을 기다리지 않고 바로 처리
pending.add(1); items[0].resume_url = `http://127.0.0.1:${albaPort}/resume?applyNo=111`;
const tKick = Date.now();
await web.evaluate(() => window.postMessage({ source: 'interview-page', type: 'kick' }, window.location.origin));
for (let i = 0; i < 40 && pending.has(1); i++) await sleep(250);
check(!pending.has(1), `화면의 요청 신호로 바로 처리(${((Date.now() - tKick) / 1000).toFixed(1)}초)`);
await web.close();

await browser.close().catch(() => {});
try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
alba.close(); sys.close();
process.exit(process.exitCode || 0);
