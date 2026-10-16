// 연락처 가져오기 에이전트(담당자 PC에서 도는 프로그램)가 부르는 API
//  - 로그인 대신 에이전트 토큰(Authorization: Bearer ag_...)으로 인증한다.
//  - GET  /api/agent/inbox                 처리할 요청 목록(한 번에 최대 5건)
//  - POST /api/agent/inbox/:id/result      { ok, phone, note } 결과 저장
import { first, run } from './d1.js';
import { verifyAgentToken, agentQueue, saveFetchResult, getAutoRegister } from './mail-intake.js';

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
});

// deps: { saveApplicant, addEvent } (applicants.js)
export async function handleAgentApi(request, env, url, deps) {
  const db = env.DB;
  const auth = request.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!(await verifyAgentToken(db, token))) return json({ error: 'unauthorized' }, 401);

  const path = url.pathname;
  const method = request.method;

  if (path === '/api/agent/inbox' && method === 'GET') {
    return json({ items: await agentQueue(db, 5) });
  }

  const m = path.match(/^\/api\/agent\/inbox\/(\d+)\/result$/);
  if (m && method === 'POST') {
    const id = Number(m[1]);
    let body = {};
    try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
    const r = await saveFetchResult(db, id, { ok: !!body.ok, phone: body.phone, note: body.note });
    if (!r.ok && r.reason === 'gone') return json({ error: 'gone' }, 404);
    let registered = false;
    if (r.ok && (await getAutoRegister(db))) {
      const item = await first(db, `SELECT * FROM applicant_inbox WHERE id=?`, id);
      if (item && item.status === 'pending') {
        const s = await deps.saveApplicant(db, { name: item.name, phone: r.phone, applied_to: item.company, job: item.job_title }, null, 'mail');
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
