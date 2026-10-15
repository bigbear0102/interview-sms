import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { openDb } from './db.js';
import { hashPassword, verifyPassword, createSession, getUser, canAccessDepartment, ensureInitialAdmin } from './auth.js';
import { candidatesFromCsv, toCsv } from './csv.js';
import { registerWebhook, verifySignature } from './gateway.js';
import {
  DEFAULT_TEMPLATE, createCampaign, scheduleCampaign, cancelCampaign, remindCampaign,
  processQueue, handleInbound, setManualStatus, purgeExpired, campaignStats
} from './core.js';
import { page, esc, STATUS_LABEL, fmtTime } from './views.js';

const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.DB_PATH || 'data/app.db';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://127.0.0.1:${PORT}`;
const SEND_INTERVAL_MS = Number(process.env.SEND_INTERVAL_MS || 3000);

const db = openDb(DB_PATH);
ensureInitialAdmin(db);

// ---------- 유틸 ----------
const readBody = (req, limit = 5_000_000) =>
  new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
const form = (raw) => Object.fromEntries(new URLSearchParams(raw));
const cookies = (req) =>
  Object.fromEntries((req.headers.cookie || '').split(';').map((s) => s.trim().split('=')).filter((p) => p[0]));
const send = (res, code, body, headers = {}) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', ...headers }); res.end(body); };
const redirect = (res, to, headers = {}) => { res.writeHead(303, { Location: to, ...headers }); res.end(); };

const audit = (user, action, detail = '') =>
  db.prepare(`INSERT INTO audit (at,user_id,action,detail) VALUES (?,?,?,?)`).run(Date.now(), user?.id ?? null, action, detail);
const isHttps = (req) => req.headers['x-forwarded-proto'] === 'https' || process.env.COOKIE_SECURE === '1';

const loginAttempts = new Map(); // ip -> {n, until}

function visibleDepartments(user) {
  const all = db.prepare(`SELECT * FROM departments ORDER BY name`).all();
  return user.role === 'super' ? all : all.filter((d) => user.departments.includes(d.id));
}
function loadCampaign(user, id) {
  const c = db.prepare(`SELECT k.*, d.name dept, g.name gateway FROM campaigns k
    JOIN departments d ON d.id=k.department_id JOIN gateways g ON g.id=k.gateway_id WHERE k.id=?`).get(id);
  return c && canAccessDepartment(user, c.department_id) ? c : null;
}

// ---------- 라우터 ----------
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;
  const method = req.method;

  // 문자 수신 웹훅 (로그인 불필요, URL 토큰 + HMAC)
  let m;
  if (method === 'POST' && (m = path.match(/^\/hook\/(\d+)\/([A-Za-z0-9_-]+)$/))) {
    const gw = db.prepare(`SELECT * FROM gateways WHERE id=?`).get(Number(m[1]));
    if (!gw || gw.hook_token !== m[2]) return send(res, 404, 'not found');
    const raw = await readBody(req, 100_000);
    if (!verifySignature(gw.signing_key, raw, req.headers['x-signature'], req.headers['x-timestamp']))
      return send(res, 401, 'bad signature');
    try {
      const evt = JSON.parse(raw);
      if (evt.event === 'sms:received' && evt.payload) {
        handleInbound(db, gw.id, {
          sender: evt.payload.sender ?? evt.payload.phoneNumber ?? '',
          message: evt.payload.message ?? ''
        });
      }
    } catch (e) { return send(res, 400, 'bad request'); }
    return send(res, 200, 'ok');
  }

  if (path === '/healthz') return send(res, 200, 'ok');

  // CSRF 방어: 브라우저가 보낸 POST는 Origin 호스트가 Host와 같아야 한다
  if (method === 'POST' && req.headers.origin) {
    let ok = false;
    try { ok = new URL(req.headers.origin).host === req.headers.host; } catch {}
    if (!ok) return send(res, 403, 'forbidden');
  }

  // 로그인
  if (path === '/login') {
    if (method === 'POST') {
      const ip = req.socket.remoteAddress;
      const a = loginAttempts.get(ip) || { n: 0, until: 0 };
      if (a.until > Date.now()) return send(res, 429, page(null, '로그인', '<p>시도 횟수 초과. 잠시 후 다시 시도하세요.</p>'));
      const f = form(await readBody(req));
      const u = db.prepare(`SELECT * FROM users WHERE username=? AND active=1`).get(f.username || '');
      if (u && verifyPassword(f.password || '', u.pass_hash)) {
        loginAttempts.delete(ip);
        audit({ id: u.id }, 'login');
        const token = createSession(db, u.id);
        return redirect(res, '/', { 'Set-Cookie': `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${isHttps(req) ? '; Secure' : ''}` });
      }
      a.n++; if (a.n >= 5) { a.until = Date.now() + 5 * 60000; a.n = 0; }
      loginAttempts.set(ip, a);
      return send(res, 401, page(null, '로그인', loginForm('아이디 또는 비밀번호가 올바르지 않습니다.')));
    }
    return send(res, 200, page(null, '로그인', loginForm()));
  }

  const user = getUser(db, cookies(req).sid);
  if (!user) return redirect(res, '/login');

  if (path === '/logout' && method === 'POST') {
    db.prepare(`DELETE FROM sessions WHERE token=?`).run(cookies(req).sid);
    return redirect(res, '/login', { 'Set-Cookie': 'sid=; Max-Age=0; Path=/' });
  }

  // 대시보드
  if (path === '/' && method === 'GET') {
    const deps = visibleDepartments(user).map((d) => d.id);
    const rows = deps.length
      ? db.prepare(`SELECT k.*, d.name dept,
            (SELECT COUNT(*) FROM candidates WHERE campaign_id=k.id) total,
            (SELECT COUNT(*) FROM candidates WHERE campaign_id=k.id AND status='attending') att,
            (SELECT COUNT(*) FROM candidates WHERE campaign_id=k.id AND status='absent') abs,
            (SELECT COUNT(*) FROM candidates WHERE campaign_id=k.id AND status IN ('sent','unclear')) wait
          FROM campaigns k JOIN departments d ON d.id=k.department_id
          WHERE k.department_id IN (${deps.map(() => '?').join(',')}) ORDER BY k.id DESC LIMIT 200`).all(...deps)
      : [];
    const body = `<h2>면접 참석 확인 캠페인</h2>
      <p><a class="btn" href="/campaigns/new">+ 새 캠페인</a></p>
      <table><tr><th>ID</th><th>부서</th><th>이름</th><th>상태</th><th>예약</th><th>전체</th><th>참석</th><th>불참</th><th>미응답/확인필요</th></tr>
      ${rows.map((r) => `<tr><td>${r.id}</td><td>${esc(r.dept)}</td><td><a href="/campaigns/${r.id}">${esc(r.name)}</a></td>
        <td>${esc(r.purged_at ? '파기됨' : r.status)}</td><td>${fmtTime(r.scheduled_at)}</td>
        <td>${r.total}</td><td>${r.att}</td><td>${r.abs}</td><td>${r.wait}</td></tr>`).join('')}
      </table>`;
    return send(res, 200, page(user, '대시보드', body));
  }

  // 새 캠페인
  if (path === '/campaigns/new') {
    const deps = visibleDepartments(user);
    const gws = db.prepare(`SELECT * FROM gateways`).all().filter((g) => deps.some((d) => d.id === g.department_id));
    if (method === 'GET') {
      if (!gws.length) return send(res, 200, page(user, '새 캠페인', '<p>등록된 게이트웨이(폰)가 없습니다. 관리 메뉴에서 먼저 등록하세요.</p>'));
      const body = `<h2>새 캠페인</h2>
      <form method="post" class="stack">
        <label>캠페인 이름 <input name="name" required placeholder="예: 10월 3주차 면접"></label>
        <label>발송 폰(게이트웨이) <select name="gateway_id">${gws.map((g) =>
          `<option value="${g.id}">${esc(deps.find((d) => d.id === g.department_id).name)} / ${esc(g.name)}</option>`).join('')}</select></label>
        <label>메시지 템플릿 <small>{사업장} {이름} {면접일시} 사용 가능</small>
          <textarea name="template" rows="4">${esc(DEFAULT_TEMPLATE)}</textarea></label>
        <label>개인정보 보관기간(일) <input name="retention_days" type="number" value="90" min="1" max="3650"></label>
        <label>지원자 명단 CSV <small>컬럼: 사업장, 이름, 전화번호, 면접일시</small>
          <input type="file" id="f" accept=".csv,.txt"></label>
        <textarea name="csv" id="csv" rows="6" placeholder="CSV를 붙여넣어도 됩니다" required></textarea>
        <button class="btn">생성</button>
      </form>
      <script>
      document.getElementById('f').addEventListener('change', async (e) => {
        const buf = await e.target.files[0].arrayBuffer();
        let t = new TextDecoder('utf-8').decode(buf);
        if (t.includes('\\uFFFD')) t = new TextDecoder('euc-kr').decode(buf); // 엑셀 CSV(CP949)
        document.getElementById('csv').value = t;
      });
      </script>`;
      return send(res, 200, page(user, '새 캠페인', body));
    }
    const f = form(await readBody(req));
    const gw = gws.find((g) => g.id === Number(f.gateway_id));
    if (!gw) return send(res, 403, page(user, '오류', '<p>권한이 없습니다.</p>'));
    const parsed = candidatesFromCsv(f.csv || '');
    if (parsed.errors.length) return send(res, 400, page(user, '오류', `<p>${parsed.errors.map(esc).join('<br>')}</p><p><a href="/campaigns/new">돌아가기</a></p>`));
    const r = createCampaign(db, {
      departmentId: gw.department_id, gatewayId: gw.id, name: f.name || '무제', template: f.template,
      retentionDays: Number(f.retention_days) || 90, userId: user.id, candidates: parsed.candidates
    });
    audit(user, 'campaign.create', `campaign=${r.campaignId} accepted=${r.accepted} rejected=${r.rejected.length}`);
    const rej = r.rejected.length
      ? `<p>제외된 행 ${r.rejected.length}건:</p><ul>${r.rejected.slice(0, 50).map((x) => `<li>${x.row}행: ${esc(x.reason)}</li>`).join('')}</ul>` : '';
    return send(res, 200, page(user, '생성 완료',
      `<p>지원자 ${r.accepted}명이 등록되었습니다.</p>${rej}<p><a class="btn" href="/campaigns/${r.campaignId}">캠페인으로 이동</a></p>`));
  }

  // 캠페인 상세 / 액션
  if ((m = path.match(/^\/campaigns\/(\d+)(?:\/(send|cancel|remind|export\.csv|set))?$/))) {
    const camp = loadCampaign(user, Number(m[1]));
    if (!camp) return send(res, 404, page(user, '없음', '<p>캠페인을 찾을 수 없습니다.</p>'));
    const action = m[2];

    if (method === 'POST' && action) {
      const f = form(await readBody(req));
      if (action === 'send') {
        const at = f.when ? new Date(f.when).getTime() : Date.now();
        if (!Number.isFinite(at)) return send(res, 400, page(user, '오류', '<p>시각 형식 오류</p>'));
        scheduleCampaign(db, camp.id, at);
        audit(user, 'campaign.send', `campaign=${camp.id} at=${new Date(at).toISOString()}`);
      } else if (action === 'cancel') { cancelCampaign(db, camp.id); audit(user, 'campaign.cancel', `campaign=${camp.id}`); }
      else if (action === 'remind') { const n = remindCampaign(db, camp.id); audit(user, 'campaign.remind', `campaign=${camp.id} n=${n}`); }
      else if (action === 'set') {
        const cand = db.prepare(`SELECT id FROM candidates WHERE id=? AND campaign_id=?`).get(Number(f.id), camp.id);
        if (cand) { setManualStatus(db, cand.id, f.status); audit(user, 'candidate.manual', `campaign=${camp.id} candidate=${cand.id} status=${f.status}`); }
      }
      return redirect(res, `/campaigns/${camp.id}${f.back || ''}`);
    }

    if (action === 'export.csv') {
      audit(user, 'campaign.export', `campaign=${camp.id}`);
      const rows = db.prepare(`SELECT * FROM candidates WHERE campaign_id=? ORDER BY site, id`).all(camp.id);
      const out = [['사업장', '이름', '전화번호', '면접일시', '상태', '답장', '발송시각', '응답시각']].concat(
        rows.map((r) => [r.site, r.name, r.phone, r.interview_at, STATUS_LABEL[r.status] || r.status, r.reply_text,
          fmtTime(r.sent_at), fmtTime(r.replied_at)]));
      return send(res, 200, toCsv(out), {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="campaign-${camp.id}.csv"`
      });
    }

    const siteFilter = url.searchParams.get('site') || '';
    const statusFilter = url.searchParams.get('status') || '';
    const stats = campaignStats(db, camp.id);
    const where = ['campaign_id=?']; const args = [camp.id];
    if (siteFilter) { where.push('site=?'); args.push(siteFilter); }
    if (statusFilter) { where.push('status=?'); args.push(statusFilter); }
    const cands = db.prepare(`SELECT * FROM candidates WHERE ${where.join(' AND ')} ORDER BY site, id LIMIT 500`).all(...args);
    const back = '?' + url.searchParams.toString();
    const body = `
      <h2>${esc(camp.name)} <small>#${camp.id} · ${esc(camp.dept)} · ${esc(camp.gateway)}</small></h2>
      <p>상태: <b>${esc(camp.purged_at ? '개인정보 파기됨' : camp.status)}</b> · 예약: ${fmtTime(camp.scheduled_at)} · 보관 ${camp.retention_days}일</p>
      ${camp.purged_at ? '' : `
      <div class="row">
        <form method="post" action="/campaigns/${camp.id}/send">
          <input type="datetime-local" name="when"> <button class="btn">${'예약/즉시 발송'}</button>
          <small>시각을 비우면 즉시 발송</small></form>
        <form method="post" action="/campaigns/${camp.id}/remind"><button class="btn">미응답자 리마인드 발송</button></form>
        <form method="post" action="/campaigns/${camp.id}/cancel"><button class="btn danger">발송 취소</button></form>
        <a class="btn" href="/campaigns/${camp.id}/export.csv">CSV 내보내기</a>
      </div>`}
      <h3>사업장별 현황</h3>
      <table><tr><th>사업장</th><th>전체</th><th>참석</th><th>불참</th><th>미응답</th><th>확인필요</th><th>실패</th><th>대기</th></tr>
      ${stats.map((s) => `<tr><td><a href="?site=${encodeURIComponent(s.site)}">${esc(s.site)}</a></td><td>${s.total}</td>
        <td>${s.attending || 0}</td><td>${s.absent || 0}</td><td>${s.sent || 0}</td><td>${s.unclear || 0}</td>
        <td>${s.failed || 0}</td><td>${s.pending || 0}</td></tr>`).join('')}</table>
      <h3>지원자 ${siteFilter ? `· ${esc(siteFilter)}` : ''} ${statusFilter ? `· ${esc(STATUS_LABEL[statusFilter])}` : ''}
        <small><a href="/campaigns/${camp.id}">필터 해제</a> ·
        ${['attending', 'absent', 'sent', 'unclear', 'failed'].map((s) =>
          `<a href="?${siteFilter ? `site=${encodeURIComponent(siteFilter)}&` : ''}status=${s}">${STATUS_LABEL[s]}</a>`).join(' · ')}</small></h3>
      <table><tr><th>사업장</th><th>이름</th><th>전화</th><th>상태</th><th>답장</th><th>수동 확정</th></tr>
      ${cands.map((c) => `<tr><td>${esc(c.site)}</td><td>${esc(c.name)}</td><td>${esc(c.phone)}</td>
        <td>${esc(STATUS_LABEL[c.status])}${c.manual ? ' (수동)' : ''}${c.error ? `<br><small>${esc(c.error)}</small>` : ''}</td>
        <td>${esc(c.reply_text)}</td>
        <td>${camp.purged_at ? '' : `<form method="post" action="/campaigns/${camp.id}/set" class="inline">
          <input type="hidden" name="id" value="${c.id}"><input type="hidden" name="back" value="${esc(back)}">
          <button name="status" value="attending">참석</button><button name="status" value="absent">불참</button></form>`}</td></tr>`).join('')}
      </table>${cands.length >= 500 ? '<p>최대 500건까지 표시됩니다. 필터를 사용하세요.</p>' : ''}`;
    return send(res, 200, page(user, camp.name, body));
  }

  // 관리 (super 전용)
  if (path === '/admin') {
    if (user.role !== 'super') return send(res, 403, page(user, '권한 없음', '<p>권한이 없습니다.</p>'));
    if (method === 'POST') {
      const f = form(await readBody(req));
      try {
        if (f.do === 'dept') db.prepare(`INSERT INTO departments (name) VALUES (?)`).run(f.name.trim());
        if (f.do === 'gw') db.prepare(
          `INSERT INTO gateways (department_id,name,base_url,username,password,send_path,signing_key,hook_token)
           VALUES (?,?,?,?,?,?,?,?)`).run(Number(f.department_id), f.name, f.base_url, f.username, f.password,
          f.send_path || '/message', f.signing_key || '', randomBytes(18).toString('base64url'));
        if (f.do === 'user') {
          const r = db.prepare(`INSERT INTO users (username,pass_hash,role) VALUES (?,?,?)`)
            .run(f.username.trim(), hashPassword(f.password), f.role === 'super' ? 'super' : 'admin');
          for (const d of [].concat(f.department_ids ? f.department_ids.split(',') : [])) {
            if (d.trim()) db.prepare(`INSERT OR IGNORE INTO user_departments VALUES (?,?)`).run(Number(r.lastInsertRowid), Number(d));
          }
        }
        if (f.do === 'hook') {
          const gw = db.prepare(`SELECT * FROM gateways WHERE id=?`).get(Number(f.gateway_id));
          await registerWebhook(gw, PUBLIC_BASE_URL);
        }
        audit(user, `admin.${f.do}`, f.do === 'user' ? `username=${f.username}` : `name=${f.name ?? f.gateway_id ?? ''}`);
      } catch (e) {
        return send(res, 400, page(user, '오류', `<p>${esc(e.message)}</p><p><a href="/admin">돌아가기</a></p>`));
      }
      return redirect(res, '/admin');
    }
    const deps = db.prepare(`SELECT * FROM departments ORDER BY name`).all();
    const gws = db.prepare(`SELECT g.*, d.name dept FROM gateways g JOIN departments d ON d.id=g.department_id`).all();
    const users = db.prepare(`SELECT u.*, (SELECT group_concat(department_id) FROM user_departments WHERE user_id=u.id) deps FROM users u`).all();
    const body = `<h2>관리</h2>
      <p>웹훅 공개 주소: <code>${esc(PUBLIC_BASE_URL)}</code> <small>(.env의 PUBLIC_BASE_URL — 폰이 이 주소로 접속할 수 있어야 하며 HTTPS 필요)</small></p>
      <h3>부서</h3>
      <ul>${deps.map((d) => `<li>#${d.id} ${esc(d.name)}</li>`).join('')}</ul>
      <form method="post" class="row"><input type="hidden" name="do" value="dept"><input name="name" placeholder="부서명" required><button class="btn">부서 추가</button></form>
      <h3>게이트웨이(폰)</h3>
      <table><tr><th>ID</th><th>부서</th><th>이름</th><th>주소</th><th>웹훅</th></tr>
      ${gws.map((g) => `<tr><td>${g.id}</td><td>${esc(g.dept)}</td><td>${esc(g.name)}</td><td>${esc(g.base_url)}</td>
        <td><form method="post"><input type="hidden" name="do" value="hook"><input type="hidden" name="gateway_id" value="${g.id}"><button>웹훅 등록</button></form></td></tr>`).join('')}</table>
      <form method="post" class="stack"><input type="hidden" name="do" value="gw">
        <select name="department_id">${deps.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select>
        <input name="name" placeholder="이름 (예: 인사팀 폰)" required>
        <input name="base_url" placeholder="http://192.168.0.20:8080" required>
        <input name="username" placeholder="앱에 표시된 사용자명" required>
        <input name="password" placeholder="앱에 표시된 비밀번호" required>
        <input name="send_path" placeholder="/message (기본값)">
        <input name="signing_key" placeholder="웹훅 Signing Key (선택)">
        <button class="btn">게이트웨이 추가</button></form>
      <h3>관리자 계정</h3>
      <table><tr><th>아이디</th><th>권한</th><th>담당 부서 ID</th></tr>
      ${users.map((u) => `<tr><td>${esc(u.username)}</td><td>${esc(u.role)}</td><td>${esc(u.deps || '')}</td></tr>`).join('')}</table>
      <form method="post" class="stack"><input type="hidden" name="do" value="user">
        <input name="username" placeholder="아이디" required><input name="password" type="password" placeholder="비밀번호(8자 이상)" minlength="8" required>
        <input name="department_ids" placeholder="담당 부서 ID (쉼표로 구분, 예: 1,2)">
        <select name="role"><option value="admin">일반 관리자</option><option value="super">전체 관리자</option></select>
        <button class="btn">계정 추가</button></form>`;
    return send(res, 200, page(user, '관리', body));
  }

  if (path === '/audit' && user.role === 'super') {
    const rows = db.prepare(`SELECT a.*, u.username FROM audit a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 300`).all();
    return send(res, 200, page(user, '감사 로그', `<h2>감사 로그 <small>최근 300건</small></h2><table><tr><th>시각</th><th>사용자</th><th>동작</th><th>내용</th></tr>${rows.map((r) => `<tr><td>${fmtTime(r.at)}</td><td>${esc(r.username || '')}</td><td>${esc(r.action)}</td><td>${esc(r.detail)}</td></tr>`).join('')}</table>`));
  }

  // 비밀번호 변경
  if (path === '/password') {
    if (method === 'POST') {
      const f = form(await readBody(req));
      const u = db.prepare(`SELECT * FROM users WHERE id=?`).get(user.id);
      if (!verifyPassword(f.current || '', u.pass_hash) || (f.next || '').length < 8)
        return send(res, 400, page(user, '비밀번호 변경', '<p>현재 비밀번호가 틀리거나 새 비밀번호가 8자 미만입니다.</p>'));
      db.prepare(`UPDATE users SET pass_hash=? WHERE id=?`).run(hashPassword(f.next), user.id);
      return redirect(res, '/');
    }
    return send(res, 200, page(user, '비밀번호 변경', `<form method="post" class="stack">
      <input type="password" name="current" placeholder="현재 비밀번호" required>
      <input type="password" name="next" placeholder="새 비밀번호(8자 이상)" required><button class="btn">변경</button></form>`));
  }

  return send(res, 404, page(user, '없음', '<p>페이지를 찾을 수 없습니다.</p>'));
}

function loginForm(err = '') {
  return `<form method="post" class="stack narrow"><h2>면접 참석 확인 시스템</h2>
    ${err ? `<p class="err">${esc(err)}</p>` : ''}
    <input name="username" placeholder="아이디" autofocus required>
    <input name="password" type="password" placeholder="비밀번호" required>
    <button class="btn">로그인</button></form>`;
}

const server = createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) send(res, 500, 'internal error');
  });
});

setInterval(() => processQueue(db, { intervalMs: SEND_INTERVAL_MS }).catch(console.error), 10_000);
setInterval(() => {
  db.prepare(`DELETE FROM sessions WHERE expires_at<?`).run(Date.now());
  const n = purgeExpired(db);
  if (n) console.log(`보관기간 만료 캠페인 ${n}건 파기`);
}, 3600_000);
purgeExpired(db);

server.listen(PORT, '0.0.0.0', () => console.log(`interview-sms listening on :${PORT}`));
