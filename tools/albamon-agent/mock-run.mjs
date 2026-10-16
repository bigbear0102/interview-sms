// 에이전트 동작 시험: 가짜 알바몬 + 가짜 시스템 서버를 띄워 로그인 → 연락처 보기 → 번호 읽기 → 결과 전달을 확인한다.
// 사용: node mock-run.mjs   (크롬이 설치되어 있어야 한다. 실제 알바몬/시스템에는 접속하지 않는다)
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
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

// 설정 파일 대신 환경변수로 연결하고, 로그인 아이디/비밀번호는 표준입력으로 넣는다
const dir = mkdtempSync(join(tmpdir(), 'agent-test-'));
writeFileSync(join(HERE, 'agent.config.json'), JSON.stringify({
  serverUrl: `http://127.0.0.1:${sysPort}`, agentToken: TOKEN, loginUrl: `http://127.0.0.1:${albaPort}/user-account/login`
}));
const child = spawn(process.execPath, ['agent.mjs', '--max', '10'], {
  cwd: HERE, env: { ...process.env, AGENT_HEADLESS: '1' }, stdio: ['pipe', 'pipe', 'inherit']
});
let out = '';
child.stdout.on('data', (d) => {
  const s = d.toString(); out += s; process.stdout.write(s);
  if (/알바몬 아이디/.test(s)) child.stdin.write('corp\n');
  if (/알바몬 비밀번호/.test(s)) child.stdin.write('secret\n');
});
const code = await new Promise((r) => child.on('exit', r));
rmSync(dir, { recursive: true, force: true });
rmSync(join(HERE, 'agent.config.json'), { force: true });
try { rmSync(join(HERE, 'chrome-profile'), { recursive: true, force: true }); } catch { /* 크롬이 아직 닫히는 중이면 다음 실행에서 지운다 */ }
alba.close(); sys.close();

const byId = Object.fromEntries(results.map((r) => [r.id, r]));
const check = (cond, msg) => { console.log((cond ? 'OK   ' : 'FAIL ') + msg); if (!cond) process.exitCode = 1; };
check(byId[1] && byId[1].ok && byId[1].phone === '01012345678', '1번: 로그인 후 연락처 보기를 눌러 번호를 가져옴');
check(byId[2] && byId[2].ok && byId[2].phone === '01055556666', '2번: 이미 보이는 번호는 누르지 않고 연락처 표시 옆 번호를 고름(대표번호 제외)');
check(byId[3] && !byId[3].ok && /이용권|차감|결제/.test(byId[3].note), '3번: 이용권 차감 확인 창이 뜨면 누르지 않고 실패 처리');
check(!byId[4], '4번: 차감 창에서 멈췄으므로 처리하지 않음');
check(/로그인됐어요/.test(out), '아이디·비밀번호 입력으로 로그인');
process.exit(process.exitCode || 0);
