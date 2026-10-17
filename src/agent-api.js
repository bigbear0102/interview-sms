// 연락처 가져오기 에이전트(담당자 PC에서 도는 프로그램)가 부르는 API
//  - 로그인 대신 에이전트 토큰(Authorization: Bearer ag_...)으로 인증한다.
//  - GET  /api/agent/inbox                 처리할 요청 목록(한 번에 최대 5건)
//  - POST /api/agent/inbox/:id/result      { ok, phone, note, resume? } 결과 저장(resume: 이력서 화면 전체, v1.9)
//  - GET  /api/agent/me                    이 키의 주인
//  - POST /api/agent/mail                  { html } 그룹웨어 메일 본문을 해석해 내 수신함에 저장
//  - GET  /api/agent/albamon-accounts      등록된 알바몬 계정(관리자 키·공용 키만, 비밀번호 포함)
//  - POST /api/agent/albamon-status        { account_id, error } 계정 로그인 실패 등 기록
import { first, run } from './d1.js';
import { accountsForAgent, noteAccountResult, MULTI_ACCOUNT_ENABLED } from './albamon-accounts.js';
import { verifyAgentToken, agentQueue, saveFetchResult, getAutoRegister, parseAlbamonApply, saveParsed } from './mail-intake.js';

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
});

// deps: { saveApplicant, addEvent } (applicants.js)
export async function handleAgentApi(request, env, url, deps) {
  const db = env.DB;
  const auth = request.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const who = await verifyAgentToken(db, token);
  if (!who) return json({ error: 'unauthorized' }, 401);
  const uid = who.userId;

  const path = url.pathname;
  const method = request.method;

  if (path === '/api/agent/inbox' && method === 'GET') {
    // 알바몬 계정이 등록돼 있고 관리자 확장이면 모든 담당자의 요청을 처리한다(계정을 바꿔 가며 열 수 있으므로)
    let everyone = false;
    if (uid != null && url.searchParams.get('all') === '1') {
      const role = (await first(db, `SELECT role FROM users WHERE id=? AND active=1`, uid))?.role;
      everyone = MULTI_ACCOUNT_ENABLED && role === 'super' && !!(await first(db, `SELECT 1 x FROM albamon_accounts WHERE active=1 LIMIT 1`));
    }
    // 확장 버전(v1.9.1 부터 보냄): 이력서만 읽기를 아는 확장인지
    const v = String(request.headers.get('x-ext-version') || '').split('.').map((x) => parseInt(x, 10) || 0);
    const resumeOk = v.length === 3 && (v[0] > 1 || (v[0] === 1 && (v[1] > 9 || (v[1] === 9 && v[2] >= 1))));
    return json({ items: await agentQueue(db, Number(url.searchParams.get('limit')) || 5, uid, { all: everyone, resumeOk }) });
  }

  if (path === '/api/agent/albamon-accounts' && method === 'GET') {
    // 비밀번호가 들어 있으므로 관리자에게 연결된 확장(또는 공용 키)만 받는다
    const role = uid == null ? 'super' : (await first(db, `SELECT role FROM users WHERE id=? AND active=1`, uid))?.role;
    if (role !== 'super' || !MULTI_ACCOUNT_ENABLED) return json({ accounts: [], allowed: false });
    return json({ accounts: await accountsForAgent(db, env), allowed: true });
  }
  if (path === '/api/agent/albamon-status' && method === 'POST') {
    let body = {};
    try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
    await noteAccountResult(db, body.account_id, { ok: false, error: String(body.error || '').slice(0, 190) });
    return json({ ok: true });
  }

  if (path === '/api/agent/me' && method === 'GET') {
    const u = uid == null ? null : await first(db, `SELECT name FROM users WHERE id=?`, uid);
    return json({ ok: true, shared: uid == null, name: u ? u.name || '' : '' });
  }

  // 확장 프로그램이 그룹웨어에서 읽은 알바몬 지원 메일 본문(HTML 표)을 보낸다. 해석은 서버의 검증된 해석기로 한다.
  if (path === '/api/agent/mail' && method === 'POST') {
    let body = {};
    try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
    const html = String(body.html || '');
    if (!html || html.length > 400000) return json({ error: 'bad_size' }, 413);
    const p = parseAlbamonApply(html);
    if (!p) return json({ ok: false, reason: 'not_albamon' });
    if (!p.name) return json({ ok: false, reason: 'no_name' });
    const r = await saveParsed(db, p, Date.now(), uid, String(body.account || '').toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 60));
    return json({ ok: true, duplicate: !!r.duplicate });
  }

  const m = path.match(/^\/api\/agent\/inbox\/(\d+)\/result$/);
  if (m && method === 'POST') {
    const id = Number(m[1]);
    let body = {};
    try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
    // 관리자 확장(여러 알바몬 계정으로 모든 담당자 건을 처리)은 다른 담당자 건의 결과도 저장할 수 있다
    const isAdmin = uid != null && (await first(db, `SELECT role FROM users WHERE id=? AND active=1`, uid))?.role === 'super';
    const r = await saveFetchResult(db, id, { ok: !!body.ok, phone: body.phone, note: body.note, resume: body.resume || null }, Date.now(), isAdmin ? null : uid);
    if (!r.ok && r.reason === 'gone') return json({ error: 'gone' }, 404);
    // 어느 알바몬 계정으로 열었는지: 성공이면 그 공고를 그 계정 것으로 배운다
    if (r.ok && body.account_id) {
      const it = await first(db, `SELECT recruit_no FROM applicant_inbox WHERE id=?`, id);
      await noteAccountResult(db, body.account_id, { ok: true, recruitNo: it ? it.recruit_no : '' });
    }
    let registered = false;
    if (r.ok && !r.resumeOnly && (await getAutoRegister(db))) {
      const item = await first(db, `SELECT * FROM applicant_inbox WHERE id=?`, id);
      if (item && item.status === 'pending') {
        const s = await deps.saveApplicant(db, { name: item.name, phone: r.phone, applied_to: item.cost_center, job: item.job, recruit_no: item.recruit_no, posting_title: item.job_title, company_raw: item.company }, uid, 'mail');
        if (s.ok) {
          const now = Date.now();
          await run(db, `UPDATE applicant_inbox SET status='registered', applicant_id=?, handled_at=? WHERE id=?`, s.id, now, id);
          await deps.addEvent(db, s.id, 'apply', '알바몬 지원 메일에서 자동 등록(연락처 가져오기)', null, now);
          registered = true;
        }
      }
    }
    return json({ ok: r.ok, registered, resume: !!r.resume });
  }
  return json({ error: 'not_found' }, 404);
}
