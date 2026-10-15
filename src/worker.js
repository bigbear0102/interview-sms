// Cloudflare Worker 진입점: 화면(SSR) + 웹훅 + Cron 발송 큐
import { createSession, getUser, canAccessDepartment, ensureInitialAdmin, hashPassword, verifyPassword } from './auth.js';
import { candidatesFromCsv, toCsv } from './csv.js';
import { registerWebhook, verifySignature } from './gateway.js';
import { encryptText, decryptText, randomToken, sha256Hex } from './crypto.js';
import {
  DEFAULT_TEMPLATE, createCampaign, scheduleCampaign, cancelCampaign, remindCampaign,
  processQueue, handleInbound, setManualStatus, purgeExpired, campaignStats
} from './core.js';
import { all, first, run } from './d1.js';
import { page, esc, STATUS_LABEL, fmtTime, parseKstLocal } from './views.js';

const html = (body, status = 200, headers = {}) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store', ...headers } });
const redirect = (to, headers = {}) => new Response(null, { status: 303, headers: { Location: to, ...headers } });
const form = (raw) => Object.fromEntries(new URLSearchParams(raw));
const getCookie = (req, name) =>
  (req.headers.get('cookie') || '').split(';').map((s) => s.trim().split('=')).find((p) => p[0] === name)?.[1];

async function audit(db, user, action, detail = '') {
  await run(db, `INSERT INTO audit (at,user_id,action,detail) VALUES (?,?,?,?)`, Date.now(), user?.id ?? null, action, detail);
}

async function visibleDepartments(db, user) {
  const all_ = await all(db, `SELECT * FROM departments ORDER BY name`);
  return user.role === 'super' ? all_ : all_.filter((d) => user.departments.includes(d.id));
}

async function loadCampaign(db, user, id) {
  const c = await first(db, `SELECT k.*, d.name dept, g.name gateway FROM campaigns k
    JOIN departments d ON d.id=k.department_id JOIN gateways g ON g.id=k.gateway_id WHERE k.id=?`, id);
  return c && canAccessDepartment(user, c.department_id) ? c : null;
}

const loginForm = (err = '') => `<form method="post" class="stack narrow"><h2>면접 참석 확인 시스템</h2>
  ${err ? `<p class="err">${esc(err)}</p>` : ''}
  <input name="username" placeholder="아이디" autofocus required>
  <input name="password" type="password" placeholder="비밀번호" required>
  <button class="btn">로그인</button></form>`;

async function handle(request, env, ctx) {
  const db = env.DB;
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const publicBase = env.PUBLIC_BASE_URL || url.origin;
  let m;

  // 문자 수신 웹훅 (로그인 불필요, URL 토큰 + HMAC)
  if (method === 'POST' && (m = path.match(/^\/hook\/(\d+)\/([A-Za-z0-9_-]+)$/))) {
    const gw = await first(db, `SELECT * FROM gateways WHERE id=?`, Number(m[1]));
    if (!gw || gw.hook_token !== m[2]) return html('not found', 404);
    const raw = await request.text();
    if (!(await verifySignature(gw.signing_key, raw, request.headers.get('x-signature'), request.headers.get('x-timestamp'))))
      return html('bad signature', 401);
    let evt;
    try { evt = JSON.parse(raw); } catch { return html('bad request', 400); }
    if (evt.event === 'sms:received' && evt.payload) {
      await handleInbound(db, gw.id, {
        sender: evt.payload.sender ?? evt.payload.phoneNumber ?? '',
        message: evt.payload.message ?? ''
      });
    }
    return html('ok');
  }

  if (path === '/healthz') return html('ok');

  // CSRF 방어: 브라우저가 보낸 POST는 Origin 호스트가 현재 호스트와 같아야 한다
  if (method === 'POST') {
    const origin = request.headers.get('origin');
    if (origin) {
      let ok = false;
      try { ok = new URL(origin).host === url.host; } catch { /* ignore */ }
      if (!ok) return html('forbidden', 403);
    }
  }

  // 로그인
  if (path === '/login') {
    if (method === 'POST') {
      const ip = request.headers.get('cf-connecting-ip') || 'unknown';
      const fail = (await first(db, `SELECT * FROM login_fail WHERE ip=?`, ip)) || { n: 0, until: 0 };
      if (fail.until > Date.now()) return html(page(null, '로그인', '<p class="err narrow">시도 횟수 초과. 잠시 후 다시 시도하세요.</p>'), 429);
      await ensureInitialAdmin(db, env);
      const f = form(await request.text());
      const u = await first(db, `SELECT * FROM users WHERE username=? AND active=1`, f.username || '');
      if (u && (await verifyPassword(f.password || '', u.pass_hash))) {
        await run(db, `DELETE FROM login_fail WHERE ip=?`, ip);
        await audit(db, u, 'login');
        const token = await createSession(db, u.id);
        return redirect('/', { 'Set-Cookie': `sid=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=43200` });
      }
      const n = fail.n + 1;
      await run(db, `INSERT INTO login_fail (ip,n,until) VALUES (?,?,?)
        ON CONFLICT(ip) DO UPDATE SET n=excluded.n, until=excluded.until`,
        ip, n >= 5 ? 0 : n, n >= 5 ? Date.now() + 5 * 60000 : 0);
      return html(page(null, '로그인', loginForm('아이디 또는 비밀번호가 올바르지 않습니다.')), 401);
    }
    return html(page(null, '로그인', loginForm()));
  }

  const user = await getUser(db, getCookie(request, 'sid'));
  if (!user) return redirect('/login');

  if (path === '/logout' && method === 'POST') {
    await run(db, `DELETE FROM sessions WHERE token_hash=?`, await sha256Hex(getCookie(request, 'sid')));
    return redirect('/login', { 'Set-Cookie': 'sid=; Max-Age=0; Path=/; Secure; HttpOnly' });
  }

  // 대시보드
  if (path === '/' && method === 'GET') {
    const deps = (await visibleDepartments(db, user)).map((d) => d.id);
    const rows = deps.length
      ? await all(db, `SELECT k.*, d.name dept,
            (SELECT COUNT(*) FROM candidates WHERE campaign_id=k.id) total,
            (SELECT COUNT(*) FROM candidates WHERE campaign_id=k.id AND status='attending') att,
            (SELECT COUNT(*) FROM candidates WHERE campaign_id=k.id AND status='absent') abs,
            (SELECT COUNT(*) FROM candidates WHERE campaign_id=k.id AND status IN ('sent','unclear')) wait
          FROM campaigns k JOIN departments d ON d.id=k.department_id
          WHERE k.department_id IN (${deps.map(() => '?').join(',')}) ORDER BY k.id DESC LIMIT 200`, ...deps)
      : [];
    const body = `<h2>면접 참석 확인 캠페인</h2>
      <p><a class="btn" href="/campaigns/new">+ 새 캠페인</a></p>
      <table><tr><th>ID</th><th>부서</th><th>이름</th><th>상태</th><th>예약</th><th>전체</th><th>참석</th><th>불참</th><th>미응답/확인필요</th></tr>
      ${rows.map((r) => `<tr><td>${r.id}</td><td>${esc(r.dept)}</td><td><a href="/campaigns/${r.id}">${esc(r.name)}</a></td>
        <td>${esc(r.purged_at ? '파기됨' : r.status)}</td><td>${fmtTime(r.scheduled_at)}</td>
        <td>${r.total}</td><td>${r.att}</td><td>${r.abs}</td><td>${r.wait}</td></tr>`).join('')}
      </table>`;
    return html(page(user, '대시보드', body));
  }

  // 새 캠페인
  if (path === '/campaigns/new') {
    const deps = await visibleDepartments(db, user);
    const gws = (await all(db, `SELECT id,department_id,name FROM gateways`)).filter((g) => deps.some((d) => d.id === g.department_id));
    if (method === 'GET') {
      if (!gws.length) return html(page(user, '새 캠페인', '<p>등록된 게이트웨이(폰)가 없습니다. 관리 메뉴에서 먼저 등록하세요.</p>'));
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
        if (t.includes('\\uFFFD')) t = new TextDecoder('euc-kr').decode(buf);
        document.getElementById('csv').value = t;
      });
      </script>`;
      return html(page(user, '새 캠페인', body));
    }
    const f = form(await request.text());
    const gw = gws.find((g) => g.id === Number(f.gateway_id));
    if (!gw) return html(page(user, '오류', '<p>권한이 없습니다.</p>'), 403);
    const parsed = candidatesFromCsv(f.csv || '');
    if (parsed.errors.length) return html(page(user, '오류', `<p>${parsed.errors.map(esc).join('<br>')}</p><p><a href="/campaigns/new">돌아가기</a></p>`), 400);
    const r = await createCampaign(db, {
      departmentId: gw.department_id, gatewayId: gw.id, name: f.name || '무제', template: f.template,
      retentionDays: Number(f.retention_days) || 90, userId: user.id, candidates: parsed.candidates
    });
    await audit(db, user, 'campaign.create', `campaign=${r.campaignId} accepted=${r.accepted} rejected=${r.rejected.length}`);
    const rej = r.rejected.length
      ? `<p>제외된 행 ${r.rejected.length}건:</p><ul>${r.rejected.slice(0, 50).map((x) => `<li>${x.row}행: ${esc(x.reason)}</li>`).join('')}</ul>` : '';
    return html(page(user, '생성 완료',
      `<p>지원자 ${r.accepted}명이 등록되었습니다.</p>${rej}<p><a class="btn" href="/campaigns/${r.campaignId}">캠페인으로 이동</a></p>`));
  }

  // 캠페인 상세 / 액션
  if ((m = path.match(/^\/campaigns\/(\d+)(?:\/(send|cancel|remind|export\.csv|set))?$/))) {
    const camp = await loadCampaign(db, user, Number(m[1]));
    if (!camp) return html(page(user, '없음', '<p>캠페인을 찾을 수 없습니다.</p>'), 404);
    const action = m[2];

    if (method === 'POST' && action) {
      const f = form(await request.text());
      if (action === 'send') {
        const at = f.when ? parseKstLocal(f.when) : Date.now();
        if (!Number.isFinite(at)) return html(page(user, '오류', '<p>시각 형식 오류</p>'), 400);
        await scheduleCampaign(db, camp.id, at);
        await audit(db, user, 'campaign.send', `campaign=${camp.id} at=${new Date(at).toISOString()}`);
        if (at <= Date.now()) ctx.waitUntil(processQueue(env).catch(console.error));
      } else if (action === 'cancel') {
        await cancelCampaign(db, camp.id);
        await audit(db, user, 'campaign.cancel', `campaign=${camp.id}`);
      } else if (action === 'remind') {
        const n = await remindCampaign(db, camp.id);
        await audit(db, user, 'campaign.remind', `campaign=${camp.id} n=${n}`);
        if (n > 0) ctx.waitUntil(processQueue(env).catch(console.error));
      } else if (action === 'set') {
        const cand = await first(db, `SELECT id FROM candidates WHERE id=? AND campaign_id=?`, Number(f.id), camp.id);
        if (cand) {
          await setManualStatus(db, cand.id, f.status);
          await audit(db, user, 'candidate.manual', `campaign=${camp.id} candidate=${cand.id} status=${f.status}`);
        }
      }
      return redirect(`/campaigns/${camp.id}${f.back || ''}`);
    }

    if (action === 'export.csv') {
      await audit(db, user, 'campaign.export', `campaign=${camp.id}`);
      const rows = await all(db, `SELECT * FROM candidates WHERE campaign_id=? ORDER BY site, id`, camp.id);
      const out = [['사업장', '이름', '전화번호', '면접일시', '상태', '답장', '발송시각', '응답시각']].concat(
        rows.map((r) => [r.site, r.name, r.phone, r.interview_at, STATUS_LABEL[r.status] || r.status, r.reply_text,
          r.status === 'pending' ? '' : fmtTime(r.sent_at), fmtTime(r.replied_at)]));
      return new Response(toCsv(out), {
        headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="campaign-${camp.id}.csv"` }
      });
    }

    const siteFilter = url.searchParams.get('site') || '';
    const statusFilter = url.searchParams.get('status') || '';
    const stats = await campaignStats(db, camp.id);
    const where = ['campaign_id=?']; const args = [camp.id];
    if (siteFilter) { where.push('site=?'); args.push(siteFilter); }
    if (statusFilter) { where.push('status=?'); args.push(statusFilter); }
    const cands = await all(db, `SELECT * FROM candidates WHERE ${where.join(' AND ')} ORDER BY site, id LIMIT 500`, ...args);
    const back = '?' + url.searchParams.toString();
    const body = `
      <h2>${esc(camp.name)} <small>#${camp.id} · ${esc(camp.dept)} · ${esc(camp.gateway)}</small></h2>
      <p>상태: <b>${esc(camp.purged_at ? '개인정보 파기됨' : camp.status)}</b> · 예약: ${fmtTime(camp.scheduled_at)} · 보관 ${camp.retention_days}일</p>
      ${camp.purged_at ? '' : `
      <div class="row">
        <form method="post" action="/campaigns/${camp.id}/send">
          <input type="datetime-local" name="when"> <button class="btn">예약/즉시 발송</button>
          <small>시각을 비우면 즉시 발송 (한국시간)</small></form>
        <form method="post" action="/campaigns/${camp.id}/remind"><button class="btn">미응답자 리마인드 발송</button></form>
        <form method="post" action="/campaigns/${camp.id}/cancel"><button class="btn danger">발송 취소</button></form>
        <a class="btn" href="/campaigns/${camp.id}/export.csv">CSV 내보내기</a>
      </div>`}
      <h3>사업장별 현황</h3>
      <table><tr><th>사업장</th><th>전체</th><th>참석</th><th>불참</th><th>미응답</th><th>확인필요</th><th>실패</th><th>대기</th></tr>
      ${stats.map((s) => `<tr><td><a href="?site=${encodeURIComponent(s.site)}">${esc(s.site)}</a></td><td>${s.total}</td>
        <td>${s.attending || 0}</td><td>${s.absent || 0}</td><td>${s.sent || 0}</td><td>${s.unclear || 0}</td>
        <td>${s.failed || 0}</td><td>${(s.pending || 0) + (s.sending || 0)}</td></tr>`).join('')}</table>
      <h3>지원자 ${siteFilter ? `· ${esc(siteFilter)}` : ''} ${statusFilter ? `· ${esc(STATUS_LABEL[statusFilter] || statusFilter)}` : ''}
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
    return html(page(user, camp.name, body));
  }

  // 관리 (super 전용)
  if (path === '/admin') {
    if (user.role !== 'super') return html(page(user, '권한 없음', '<p>권한이 없습니다.</p>'), 403);
    if (method === 'POST') {
      const f = form(await request.text());
      try {
        if (f.do === 'dept') await run(db, `INSERT INTO departments (name) VALUES (?)`, f.name.trim());
        if (f.do === 'gw') {
          await run(db,
            `INSERT INTO gateways (department_id,name,base_url,username,password,send_path,signing_key,hook_token)
             VALUES (?,?,?,?,?,?,?,?)`, Number(f.department_id), f.name,
            (f.base_url || env.GATEWAY_URL || 'https://api.sms-gate.app/3rdparty/v1').trim(), f.username.trim(),
            await encryptText(env.ENCRYPTION_KEY, f.password), (f.send_path || '/messages').trim(),
            (f.signing_key || '').trim(), randomToken(18));
        }
        if (f.do === 'user') {
          const r = await run(db, `INSERT INTO users (username,pass_hash,role) VALUES (?,?,?)`,
            f.username.trim(), await hashPassword(f.password), f.role === 'super' ? 'super' : 'admin');
          for (const d of (f.department_ids || '').split(',')) {
            if (d.trim()) await run(db, `INSERT OR IGNORE INTO user_departments VALUES (?,?)`, Number(r.meta.last_row_id), Number(d));
          }
        }
        if (f.do === 'hook') {
          const gwRow = await first(db, `SELECT * FROM gateways WHERE id=?`, Number(f.gateway_id));
          await registerWebhook({ ...gwRow, password: await decryptText(env.ENCRYPTION_KEY, gwRow.password) }, publicBase);
        }
        await audit(db, user, `admin.${f.do}`, f.do === 'user' ? `username=${f.username}` : `name=${f.name ?? f.gateway_id ?? ''}`);
      } catch (e) {
        return html(page(user, '오류', `<p>${esc(e.message)}</p><p><a href="/admin">돌아가기</a></p>`), 400);
      }
      return redirect('/admin');
    }
    const deps = await all(db, `SELECT * FROM departments ORDER BY name`);
    const gws = await all(db, `SELECT g.id,g.name,g.base_url,g.send_path,g.hook_token,d.name dept FROM gateways g JOIN departments d ON d.id=g.department_id`);
    const users = await all(db, `SELECT u.*, (SELECT group_concat(department_id) FROM user_departments WHERE user_id=u.id) deps FROM users u`);
    const body = `<h2>관리</h2>
      <p>웹훅 공개 주소: <code>${esc(publicBase)}</code></p>
      <h3>부서</h3>
      <ul>${deps.map((d) => `<li>#${d.id} ${esc(d.name)}</li>`).join('')}</ul>
      <form method="post" class="row"><input type="hidden" name="do" value="dept"><input name="name" placeholder="부서명" required><button class="btn">부서 추가</button></form>
      <h3>게이트웨이(폰)</h3>
      <table><tr><th>ID</th><th>부서</th><th>이름</th><th>API 주소</th><th>웹훅</th></tr>
      ${gws.map((g) => `<tr><td>${g.id}</td><td>${esc(g.dept)}</td><td>${esc(g.name)}</td><td>${esc(g.base_url)}</td>
        <td><form method="post"><input type="hidden" name="do" value="hook"><input type="hidden" name="gateway_id" value="${g.id}"><button>웹훅 등록</button></form></td></tr>`).join('')}</table>
      <form method="post" class="stack"><input type="hidden" name="do" value="gw">
        <select name="department_id">${deps.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select>
        <input name="name" placeholder="이름 (예: 인사팀 폰)" required>
        <input name="base_url" value="${esc(env.GATEWAY_URL || 'https://api.sms-gate.app/3rdparty/v1')}" required>
        <input name="username" placeholder="앱 Cloud Server 화면의 Username" required>
        <input name="password" placeholder="앱 Cloud Server 화면의 Password" required>
        <input name="send_path" value="/messages">
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
    return html(page(user, '관리', body));
  }

  if (path === '/audit' && user.role === 'super') {
    const rows = await all(db, `SELECT a.*, u.username FROM audit a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 300`);
    return html(page(user, '감사 로그', `<h2>감사 로그 <small>최근 300건</small></h2><table><tr><th>시각</th><th>사용자</th><th>동작</th><th>내용</th></tr>${rows.map((r) =>
      `<tr><td>${fmtTime(r.at)}</td><td>${esc(r.username || '')}</td><td>${esc(r.action)}</td><td>${esc(r.detail)}</td></tr>`).join('')}</table>`));
  }

  // 비밀번호 변경
  if (path === '/password') {
    if (method === 'POST') {
      const f = form(await request.text());
      const u = await first(db, `SELECT * FROM users WHERE id=?`, user.id);
      if (!(await verifyPassword(f.current || '', u.pass_hash)) || (f.next || '').length < 8)
        return html(page(user, '비밀번호 변경', '<p>현재 비밀번호가 틀리거나 새 비밀번호가 8자 미만입니다.</p>'), 400);
      await run(db, `UPDATE users SET pass_hash=? WHERE id=?`, await hashPassword(f.next), user.id);
      await audit(db, user, 'password.change');
      return redirect('/');
    }
    return html(page(user, '비밀번호 변경', `<form method="post" class="stack">
      <input type="password" name="current" placeholder="현재 비밀번호" required>
      <input type="password" name="next" placeholder="새 비밀번호(8자 이상)" required><button class="btn">변경</button></form>`));
  }

  return html(page(user, '없음', '<p>페이지를 찾을 수 없습니다.</p>'), 404);
}

// 주기 작업: 발송 큐 처리 + 매 시 정각 파기/세션 정리 (Workers Cron, Node 서버 공용)
export async function runScheduled(env, whenMs = Date.now()) {
  await processQueue(env);
  if (new Date(whenMs).getUTCMinutes() === 0) {
    await run(env.DB, `DELETE FROM sessions WHERE expires_at<?`, Date.now());
    await run(env.DB, `DELETE FROM login_fail WHERE until<?`, Date.now());
    const n = await purgeExpired(env.DB);
    if (n) console.log(`보관기간 만료 캠페인 ${n}건 파기`);
  }
}

export async function handleRequest(request, env, ctx) {
  try {
    return await handle(request, env, ctx);
  } catch (e) {
    console.error(e);
    return html('internal error', 500);
  }
}

export default {
  fetch: handleRequest,
  // Cloudflare Cron Trigger (Workers 배포 시)
  scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduled(env, event.scheduledTime));
  }
};
