// 연락처 가져오기 에이전트(담당자 PC에서 도는 프로그램)가 부르는 API
//  - 로그인 대신 에이전트 토큰(Authorization: Bearer ag_...)으로 인증한다.
//  - GET  /api/agent/inbox                 처리할 요청 목록(한 번에 최대 5건)
//  - POST /api/agent/inbox/:id/result      { ok, phone, note } 결과 저장
//  - GET  /api/agent/me                    이 키의 주인
//  - POST /api/agent/mail                  { html } 그룹웨어 메일 본문을 해석해 내 수신함에 저장
import { first, run } from './d1.js';
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
    return json({ items: await agentQueue(db, 5, uid) });
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
    const r = await saveFetchResult(db, id, { ok: !!body.ok, phone: body.phone, note: body.note }, Date.now(), uid);
    if (!r.ok && r.reason === 'gone') return json({ error: 'gone' }, 404);
    let registered = false;
    if (r.ok && (await getAutoRegister(db))) {
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
    return json({ ok: r.ok, registered });
  }
  return json({ error: 'not_found' }, 404);
}
