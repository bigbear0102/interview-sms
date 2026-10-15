// Cloudflare Worker 진입점: 화면(SSR) + 웹훅 + Cron 발송 큐
import { createSession, getUser, canAccessDepartment, ensureInitialAdmin, hashPassword, verifyPassword } from './auth.js';
import { candidatesFromCsv, toCsv } from './csv.js';
import { registerWebhook, verifySignature } from './gateway.js';
import { encryptText, decryptText, randomToken, sha256Hex } from './crypto.js';
import {
  DEFAULT_TEMPLATE, createCampaign, scheduleCampaign, cancelCampaign, remindCampaign,
  processQueue, handleInbound, setManualStatus, purgeExpired, campaignStats, sendDirect
} from './core.js';
import { all, first, run } from './d1.js';
import { normalizePhone } from './parser.js';
import { applyAdminAction, renderAdmin } from './admin.js';
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
    const gwCount = (await first(db, `SELECT COUNT(*) n FROM gateways WHERE active=1`)).n;
    const phoneBanner = gwCount
      ? '<div class="ok big">🟢 문자를 보낼 폰이 준비되어 있어요.</div>'
      : `<div class="warn big">🔴 문자를 보낼 폰이 아직 연결되지 않았어요. ${user.role === 'super' ? '<a href="/admin">여기를 눌러 폰을 연결하세요.</a>' : '전체 관리자에게 폰 연결을 부탁하세요.'}</div>`;
    const CAMP = { draft: '아직 안 보냄', scheduled: '보낼 시간을 기다리는 중', sending: '보내는 중', done: '모두 보냄', cancelled: '취소함' };
    const body = `<section class="hero">
        <h1>면접 안내,<br>문자 한 번이면 끝.</h1>
        <p>명단 파일을 올리면 참석 여부를 자동으로 모아서 보여 드려요.</p>
        <div class="cta"><a class="btn big" href="/campaigns/new">면접 안내 보내기</a><a class="btn big ghost" href="#results">보낸 결과 보기</a></div>
      </section>
      ${phoneBanner}
      <div class="bigbtns">
        <a class="bigbtn" href="/campaigns/new"><span class="n">1</span>면접 안내 문자 보내기<small>명단 파일을 올려서 한꺼번에 보내요</small></a>
        <a class="bigbtn" href="#results"><span class="n">2</span>보낸 결과 보기<small>누가 참석하고 불참하는지 봐요</small></a>
        <a class="bigbtn" href="/messages"><span class="n">3</span>문자 따로 보내기 · 받은 문자 보기<small>한 사람에게 보내거나 답장을 봐요</small></a>
      </div>
      <h3 id="results">지금까지 보낸 면접 안내</h3>
      ${rows.length ? `<table><tr><th>이름</th><th>상태</th><th>보낸 사람 수</th><th>참석</th><th>불참</th><th>답 없음·확인 필요</th></tr>
      ${rows.map((r) => `<tr><td><a href="/campaigns/${r.id}">${esc(r.name)}</a><br><small>${esc(r.dept)}</small></td>
        <td>${esc(r.purged_at ? '개인정보 지움' : CAMP[r.status] || r.status)}</td>
        <td>${r.total}</td><td><b>${r.att}</b></td><td><b>${r.abs}</b></td><td>${r.wait}</td></tr>`).join('')}</table>`
      : '<p>아직 보낸 면접 안내가 없어요. 위의 <b>1번</b>을 눌러 시작하세요.</p>'}`;
    return html(page(user, '대시보드', body));
  }

  // 새 캠페인
  if (path === '/campaigns/new') {
    const deps = await visibleDepartments(db, user);
    const gws = (await all(db, `SELECT id,department_id,name FROM gateways WHERE active=1`)).filter((g) => deps.some((d) => d.id === g.department_id));
    if (method === 'GET') {
      if (!gws.length) return html(page(user, '새 캠페인', `<div class="warn">문자를 보낼 폰이 아직 연결되지 않았습니다. ${user.role === 'super' ? '<a href="/admin">설정</a>에서 폰을 먼저 연결하세요.' : '전체 관리자에게 폰 연결을 요청하세요.'}</div>`));
      const today = fmtTime(Date.now()).slice(5, 10);
      const body = `<h2>면접 안내 문자 보내기</h2>
      <p class="lead">3가지만 하면 돼요. <b>1. 명단 파일 고르기</b> → <b>2. 문자 내용 확인</b> → <b>3. 올리기</b>. 올린 다음에 "지금 보내기"를 눌러야 문자가 나가니까 걱정하지 마세요.</p>
      <form method="post" class="stack">
        <input type="hidden" name="name" value="면접 안내 ${esc(today)}">
        <div class="step"><div class="num">1</div><div class="body">
          <h3>명단 파일 고르기</h3>
          <p>엑셀에 <b>사업장, 이름, 전화번호, 면접일시</b> 4가지를 적고 <b>CSV로 저장</b>한 파일이에요.</p>
          <p><a class="btn" href="/template.csv">연습용 양식 받기</a></p>
          <input type="file" id="f" accept=".csv,.txt" class="bigfile">
          <p id="fname"><small>아직 고른 파일이 없어요.</small></p>
          <details><summary>파일이 없으면 여기에 직접 붙여넣어도 돼요</summary>
            <textarea name="csv" id="csv" rows="6" placeholder="사업장,이름,전화번호,면접일시&#10;강남점,홍길동,010-1234-5678,10/20 14:00" required></textarea></details>
        </div></div>
        <div class="step"><div class="num">2</div><div class="body">
          <h3>보낼 문자 확인하기</h3>
          <p><small>{이름}, {사업장}, {면접일시} 자리에는 각 사람의 정보가 저절로 들어가요.</small></p>
          <textarea name="template" rows="5">${esc(DEFAULT_TEMPLATE)}</textarea>
        </div></div>
        <div class="step"><div class="num">3</div><div class="body">
          <h3>올리기</h3>
          ${gws.length > 1 ? `<label>어느 폰으로 보낼까요? <select name="gateway_id">${gws.map((g) =>
            `<option value="${g.id}">${esc(deps.find((d) => d.id === g.department_id).name)} / ${esc(g.name)}</option>`).join('')}</select></label>`
            : `<input type="hidden" name="gateway_id" value="${gws[0].id}"><p><small>보내는 폰: ${esc(gws[0].name)}</small></p>`}
          <button class="btn big">명단 올리기</button>
          <details><summary>더 설정하기 (안 해도 돼요)</summary>
            <label>개인정보를 몇 일 동안 보관할까요? <small>(지나면 이름과 번호가 저절로 지워져요)</small>
              <input name="retention_days" type="number" value="90" min="1" max="3650"></label></details>
        </div></div>
      </form>
      <script>
      document.getElementById('f').addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const buf = await file.arrayBuffer();
        let t = new TextDecoder('utf-8').decode(buf);
        if (t.includes('\uFFFD')) t = new TextDecoder('euc-kr').decode(buf);
        document.getElementById('csv').value = t;
        document.getElementById('fname').innerHTML = '✅ <b>' + file.name.replace(/[<>&]/g, '') + '</b> 파일을 불러왔어요.';
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
      ? `<div class="warn"><b>${r.rejected.length}명은 올리지 못했어요.</b> 아래 이유를 고쳐서 다시 올리거나, 그대로 두셔도 돼요.<ul>${r.rejected.slice(0, 50).map((x) => `<li>${x.row}번째 줄: ${esc(x.reason)}</li>`).join('')}</ul></div>` : '';
    return html(page(user, '올리기 완료',
      `<h2>명단을 올렸어요</h2><div class="ok big">✅ ${r.accepted}명을 불러왔어요.</div>${rej}
       <p class="lead">아직 문자는 나가지 않았어요. 다음 화면에서 <b>"지금 보내기"</b>를 누르면 문자가 나가요.</p>
       <p><a class="btn big" href="/campaigns/${r.campaignId}">다음: 보내기 화면으로</a></p>`));
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
    const totals = stats.reduce((t, s) => {
      for (const k of ['total', 'attending', 'absent', 'sent', 'unclear', 'failed', 'pending', 'sending']) t[k] = (t[k] || 0) + (s[k] || 0);
      return t;
    }, {});
    const waiting = (totals.pending || 0) + (totals.sending || 0);
    const STATE = {
      draft: ['warn', '아직 문자를 보내지 않았어요. 아래 초록색 버튼을 누르면 보내요.'],
      scheduled: ['ok', `${fmtTime(camp.scheduled_at)}에 보낼 예정이에요.`],
      sending: ['ok', `문자를 보내는 중이에요. (${totals.total - waiting}/${totals.total}명 보냄) 잠시 후 이 화면을 새로고침해 보세요.`],
      done: ['ok', '모두 보냈어요. 답장이 오면 아래 숫자가 바뀌어요.'],
      cancelled: ['warn', '보내기를 취소했어요.']
    };
    const [stateClass, stateText] = camp.purged_at ? ['ok', '개인정보 보관 기간이 지나 이름과 전화번호를 지웠어요. 숫자만 남아 있어요.'] : (STATE[camp.status] || ['ok', camp.status]);
    const canSend = !camp.purged_at && ['draft', 'scheduled'].includes(camp.status);
    const body = `
      <h2>${esc(camp.name)}</h2>
      <p><small>${esc(camp.dept)} · 보내는 폰: ${esc(camp.gateway)}</small></p>
      <div class="${stateClass} big">${esc(stateText)}</div>
      ${canSend ? `
      <div class="card">
        <form method="post" action="/campaigns/${camp.id}/send">
          <button class="btn big go">✉️ 지금 바로 보내기 (${totals.total}명)</button>
        </form>
        <details><summary>나중 시간에 보내고 싶어요</summary>
          <form method="post" action="/campaigns/${camp.id}/send" class="row">
            <input type="datetime-local" name="when" required> <button class="btn">이 시간에 보내기</button>
          </form><small>한국 시간 기준이에요.</small></details>
      </div>` : ''}
      <div class="counts">
        <div class="count yes"><b>${totals.attending || 0}</b>참석</div>
        <div class="count no"><b>${totals.absent || 0}</b>불참</div>
        <div class="count wait"><b>${totals.sent || 0}</b>답 없음</div>
        <div class="count check"><b>${totals.unclear || 0}</b>확인 필요</div>
        ${totals.failed ? `<div class="count bad"><b>${totals.failed}</b>못 보냄</div>` : ''}
      </div>
      ${camp.purged_at ? '' : `
      <div class="row">
        <form method="post" action="/campaigns/${camp.id}/remind"><button class="btn" title="답이 없거나 못 보낸 사람에게만 다시 보내요">답 없는 사람에게 다시 보내기</button></form>
        <a class="btn" href="/campaigns/${camp.id}/export.csv">엑셀로 저장하기</a>
        ${['scheduled', 'sending'].includes(camp.status) ? `<form method="post" action="/campaigns/${camp.id}/cancel"><button class="btn danger">보내기 멈추기</button></form>` : ''}
      </div>`}
      <h3>사업장별로 보기</h3>
      <table><tr><th>사업장</th><th>전체</th><th>참석</th><th>불참</th><th>답 없음</th><th>확인 필요</th><th>못 보냄</th><th>보내는 중</th></tr>
      ${stats.map((s) => `<tr><td><a href="?site=${encodeURIComponent(s.site)}">${esc(s.site)}</a></td><td>${s.total}</td>
        <td>${s.attending || 0}</td><td>${s.absent || 0}</td><td>${s.sent || 0}</td><td>${s.unclear || 0}</td>
        <td>${s.failed || 0}</td><td>${(s.pending || 0) + (s.sending || 0)}</td></tr>`).join('')}</table>
      <h3>사람별로 보기 ${siteFilter ? `· ${esc(siteFilter)}` : ''} ${statusFilter ? `· ${esc(STATUS_LABEL[statusFilter] || statusFilter)}` : ''}
        <small><a href="/campaigns/${camp.id}">전체 보기</a> ·
        ${['attending', 'absent', 'sent', 'unclear', 'failed'].map((s) =>
          `<a href="?${siteFilter ? `site=${encodeURIComponent(siteFilter)}&` : ''}status=${s}">${STATUS_LABEL[s]}</a>`).join(' · ')}</small></h3>
      <table><tr><th>사업장</th><th>이름</th><th>전화</th><th>상태</th><th>받은 답장</th><th>직접 정하기</th></tr>
      ${cands.map((c) => `<tr><td>${esc(c.site)}</td><td>${esc(c.name)}</td><td>${esc(c.phone)}</td>
        <td>${esc(STATUS_LABEL[c.status])}${c.manual ? ' (수동)' : ''}${c.error ? `<br><small>${esc(c.error)}</small>` : ''}</td>
        <td>${esc(c.reply_text)}</td>
        <td>${camp.purged_at ? '' : `<form method="post" action="/campaigns/${camp.id}/set" class="inline">
          <input type="hidden" name="id" value="${c.id}"><input type="hidden" name="back" value="${esc(back)}">
          <button name="status" value="attending">참석</button><button name="status" value="absent">불참</button></form>`}</td></tr>`).join('')}
      </table>${cands.length >= 500 ? '<p>최대 500건까지 표시됩니다. 필터를 사용하세요.</p>' : ''}`;
    return html(page(user, camp.name, body));
  }

  // 설정 (전체 관리자 전용): 폰 연결, 부서, 관리자 계정
  if (path === '/admin') {
    if (user.role !== 'super') return html(page(user, '권한 없음', '<p>권한이 없습니다.</p>'), 403);
    let result = null;
    if (method === 'POST') {
      const f = form(await request.text());
      result = await applyAdminAction(db, env, f, publicBase);
      await audit(db, user, 'admin.' + (f.do || '?'), result.ok ? 'ok' : 'fail');
    }
    return html(page(user, '설정', await renderAdmin(db, env, publicBase, result)));
  }

  // 지원자 명단 양식 내려받기
  if (path === '/template.csv') {
    const csv = toCsv([['사업장', '이름', '전화번호', '면접일시'], ['강남점', '홍길동', '010-1234-5678', '10/20 14:00'], ['서초점', '김철수', '010-2345-6789', '10/20 15:00']]);
    return new Response(csv, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="candidates-template.csv"; filename*=UTF-8''${encodeURIComponent('지원자명단-양식.csv')}` } });
  }

  if (path === '/audit' && user.role === 'super') {
    const rows = await all(db, `SELECT a.*, u.username FROM audit a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 300`);
    return html(page(user, '감사 로그', `<h2>감사 로그 <small>최근 300건</small></h2><table><tr><th>시각</th><th>사용자</th><th>동작</th><th>내용</th></tr>${rows.map((r) =>
      `<tr><td>${fmtTime(r.at)}</td><td>${esc(r.username || '')}</td><td>${esc(r.action)}</td><td>${esc(r.detail)}</td></tr>`).join('')}</table>`));
  }

  // 문자함: 임의 번호로 직접 발송 + 송수신 내역
  if (path === '/messages') {
    const deps = await visibleDepartments(db, user);
    const gws = (await all(db, `SELECT id,department_id,name FROM gateways WHERE active=1`)).filter((g) => deps.some((d) => d.id === g.department_id));
    if (!gws.length) return html(page(user, '문자함', '<p>사용 가능한 게이트웨이(폰)가 없습니다.</p>'));
    let notice = '';
    if (method === 'POST') {
      const f = form(await request.text());
      const gwRow = gws.find((g) => g.id === Number(f.gateway_id));
      const phones = String(f.phones || '').split(/[\s,;]+/).filter(Boolean);
      const text = String(f.text || '').trim();
      if (!gwRow || !phones.length || !text) {
        notice = '<p class="err">폰, 받는 번호, 내용을 모두 입력하세요.</p>';
      } else if (phones.length > 20) {
        notice = '<p class="err">한 번에 최대 20명까지 보낼 수 있습니다. 대량 발송은 캠페인을 사용하세요.</p>';
      } else {
        const full = await first(db, `SELECT * FROM gateways WHERE id=?`, gwRow.id);
        const gw = { ...full, password: await decryptText(env.ENCRYPTION_KEY, full.password) };
        const res = await sendDirect(db, gw, phones, text, user.id);
        await audit(db, user, 'message.send', `gateway=${gw.id} count=${res.length} ok=${res.filter((r) => r.ok).length}`);
        const ok = res.filter((r) => r.ok).length;
        notice = `<p>${ok}건 발송 요청 완료${res.length - ok ? `, <span class="err">${res.length - ok}건 실패</span>` : ''}.</p>` +
          res.filter((r) => !r.ok).map((r) => `<p class="err">${esc(r.phone)}: ${esc(r.error)}</p>`).join('');
      }
    }
    const ids = gws.map((g) => g.id);
    const ph = ids.map(() => '?').join(',');
    const filter = normalizePhone(url.searchParams.get('phone') || '');
    const phoneCond = filter ? ' AND phone=?' : '';
    const phoneArgs = filter ? [filter] : [];
    const rows = await all(db,
      `SELECT * FROM (
         SELECT 'out' dir, phone, text, status result, at, gateway_id FROM messages WHERE gateway_id IN (${ph})${phoneCond}
         UNION ALL
         SELECT 'in' dir, sender phone, message text, result, received_at at, gateway_id FROM inbound WHERE gateway_id IN (${ph})${filter ? ' AND sender=?' : ''}
       ) ORDER BY at DESC LIMIT 100`, ...ids, ...phoneArgs, ...ids, ...phoneArgs);
    const RES = { sent: '발송요청', failed: '실패', attending: '참석', absent: '불참', unclear: '확인필요', unmatched: '캠페인 외' };
    const toPhone = url.searchParams.get('to') || '';
    const gwSel = Number(url.searchParams.get('gw')) || gws[0].id;
    const body = `<h2>문자함</h2>${notice}
      <form method="post" class="stack">
        <label>보낼 폰 <select name="gateway_id">${gws.map((g) =>
          `<option value="${g.id}"${g.id === gwSel ? ' selected' : ''}>${esc(deps.find((d) => d.id === g.department_id).name)} / ${esc(g.name)}</option>`).join('')}</select></label>
        <label>받는 번호 <small>여러 명은 쉼표/줄바꿈으로 구분 (최대 20명)</small>
          <textarea name="phones" rows="2" placeholder="010-1234-5678">${esc(toPhone)}</textarea></label>
        <label>내용 <textarea name="text" rows="3" required></textarea></label>
        <button class="btn">문자 보내기</button>
      </form>
      <h3>송수신 내역 <small>최근 100건${filter ? ` · ${esc(filter)} <a href="/messages">전체 보기</a>` : ''}</small></h3>
      <table><tr><th>시각</th><th>구분</th><th>번호</th><th>내용</th><th>결과</th><th></th></tr>
      ${rows.map((r) => `<tr><td>${fmtTime(r.at)}</td><td>${r.dir === 'in' ? '수신' : '발신'}</td>
        <td><a href="/messages?phone=${encodeURIComponent(r.phone)}">${esc(r.phone)}</a></td>
        <td style="white-space:normal;min-width:200px">${esc(r.text)}</td><td>${esc(RES[r.result] || r.result)}</td>
        <td><a href="/messages?to=${encodeURIComponent(r.phone)}&gw=${r.gateway_id}">답장</a></td></tr>`).join('')}</table>`;
    return html(page(user, '문자함', body));
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
