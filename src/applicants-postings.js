// 공고별 정리: 같은 알바몬 공고로 지원한 사람들을 한 번에 원가중심점·직무로 정리한다.
//  - 한 번 정하면 그 공고의 등록된 지원자 전체 + 수신함 대기 건에 적용하고, 앞으로 오는 같은 공고 메일에도 자동으로 붙인다.
import { first, run, all } from './d1.js';
import { esc, icon } from './views.js';
import { pageHeader, emptyState } from './ui.js';
import { peopleTabs, bracketName, suggestCostCenters } from './workspace.js';
export { bracketName, suggestCostCenters };
import { aiPostingSuggestion } from './ai-features.js';
import { inboxScope, pendingInboxCount, requestFetchByPosting } from './mail-intake.js';

const clip = (s, n) => String(s || '').trim().slice(0, n);

export async function postingGroups(db, viewer = null) {
  const sc = inboxScope(viewer);
  return all(db, `
    SELECT recruit_no, MAX(title) title, MAX(company) company, SUM(reg) reg, SUM(pend) pend, MAX(at) last_at,
           SUM(cc = '') blank, MAX(cc) cc, MAX(job) job
      FROM (
        SELECT recruit_no, posting_title title, company_raw company, 1 reg, 0 pend, created_at at, applied_to cc, job
          FROM applicant_applications WHERE recruit_no != ''
        UNION ALL
        SELECT recruit_no, job_title, company, 0, 1, received_at, cost_center, job
          FROM applicant_inbox WHERE status='pending' AND recruit_no != '' AND ${sc.sql}
      ) GROUP BY recruit_no ORDER BY last_at DESC LIMIT 300`, ...sc.args);
}

export async function unclassifiedCount(db) {
  const r = await first(db, `SELECT COUNT(DISTINCT recruit_no) n FROM applicant_applications WHERE recruit_no != '' AND applied_to = ''`);
  return r ? r.n : 0;
}

// 공고 하나를 정리한다. 반환: { ok, people } (people = 적용된 지원 건 + 수신함 건 수)
export async function classifyPosting(db, recruitNo, costCenter, job, userId, now = Date.now()) {
  const r = clip(recruitNo, 30), cc = clip(costCenter, 80), j = clip(job, 100);
  if (!r || !cc) return { ok: false, error: 'empty' };
  const total = (await first(db, `SELECT COUNT(*) n FROM cost_centers`)).n;
  if (total && !(await first(db, `SELECT 1 x FROM cost_centers WHERE name=?`, cc))) return { ok: false, error: 'cclist' };
  const a = await run(db, `UPDATE applicant_applications SET applied_to=?, job=? WHERE recruit_no=?`, cc, j, r);
  const b = await run(db, `UPDATE applicant_inbox SET cost_center=?, job=? WHERE recruit_no=? AND status='pending'`, cc, j, r);
  await run(db, `INSERT INTO inbox_cost_rules (recruit_no, cost_center, job, updated_by, updated_at) VALUES (?,?,?,?,?)
                 ON CONFLICT(recruit_no) DO UPDATE SET cost_center=excluded.cost_center, job=excluded.job, updated_by=excluded.updated_by, updated_at=excluded.updated_at`, r, cc, j, userId ?? null, now);
  // 분류가 끝났으니 이 공고 대기 건의 연락처 가져오기도 이어서 요청한다
  const fetchReq = await requestFetchByPosting(db, r);
  return { ok: true, people: (a.meta.changes || 0) + (b.meta.changes || 0), fetchReq };
}

const FLASH = { saved: '정리했어요.' };
const ERR = {
  empty: '원가중심점을 입력해 주세요.',
  cclist: '원가중심점 목록에 없는 이름이에요. 입력하면 나오는 목록에서 골라 주세요.'
};

export async function renderPostings(db, { tab = 'todo', viewer = null, flash = '', n = 0, err = '', pending = 0, fr = 0 } = {}) {
  const groups = await postingGroups(db, viewer);
  const todo = groups.filter((g) => g.blank > 0);
  const done = groups.filter((g) => g.blank === 0);
  const shown = tab === 'done' ? done : todo;
  const jobs = await all(db, `SELECT job v, COUNT(*) n FROM applicant_applications WHERE job != '' GROUP BY job ORDER BY n DESC, v LIMIT 100`);
  const when = (t) => (t ? new Date(Number(t) + 9 * 3600 * 1000).toISOString().slice(0, 10) : '');

  const cards = [];
  // 공고마다 제안·AI 추천을 동시에 읽는다
  const extra = await Promise.all(shown.map((g) => g.blank > 0
    ? Promise.all([suggestCostCenters(db, g.title), aiPostingSuggestion(db, g.recruit_no)]) : [[], null]));
  for (const [gi, g] of shown.entries()) {
    const [sug, ai] = extra[gi];
    const people = g.reg + g.pend;
    const lab = `g-${esc(g.recruit_no)}`;
    cards.push(`<section class="card posting" id="${lab}" style="margin-bottom:12px;overflow-wrap:anywhere;min-width:0">
      <div style="display:flex;gap:8px;justify-content:space-between;flex-wrap:wrap;align-items:baseline">
        <b style="min-width:0">${esc(g.title || '(공고 제목 없음)')}</b>
        <span class="badge ${g.blank > 0 ? 'wait' : 'ok'}">${g.blank > 0 ? '정리 필요' : '정리 끝'}</span>
      </div>
      <p class="muted" style="font-size:13px;margin:4px 0 10px">공고번호 ${esc(g.recruit_no)}${g.company ? ' · ' + esc(g.company) : ''} · 지원자 <b>${people}명</b>${g.pend ? ` (수신함 대기 ${g.pend}명 포함)` : ''}${g.last_at ? ' · 최근 지원 ' + esc(when(g.last_at)) : ''}</p>
      <form method="post" action="/applicants/postings/save" class="posting-form" style="display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr));align-items:end">
        <input type="hidden" name="recruit_no" value="${esc(g.recruit_no)}">
        <input type="hidden" name="tab" value="${tab === 'done' ? 'done' : 'todo'}">
        <label style="display:grid;gap:4px"><span style="font-size:13px">원가중심점</span>
          <input name="cost_center" data-cc-search value="${esc(g.blank > 0 ? '' : g.cc)}" placeholder="글자를 입력하면 목록이 나와요" maxlength="80" autocomplete="off" required></label>
        <label style="display:grid;gap:4px"><span style="font-size:13px">직무 <small class="muted">(선택)</small></span>
          <input name="job" list="dl-pjob" value="${esc(g.job || '')}" placeholder="예: 주차관리" maxlength="100" autocomplete="off"></label>
        <button class="btn" style="width:100%">${people}명에게 적용</button>
      </form>
      ${ai ? `<div style="margin-top:8px;font-size:13px" class="muted">AI 추천: <button type="button" class="small secondary" data-fill="${esc(ai.cost_center)}" data-fill-job="${esc(ai.job || '')}" style="margin:0 4px 4px 0">${esc(ai.cost_center)}${ai.job ? ` · ${esc(ai.job)}` : ''}</button>${ai.note ? `<small>${esc(ai.note)}</small>` : ''} <small>— 눌러서 채운 뒤 "적용"을 눌러야 정해져요</small></div>` : ''}
      ${sug.length ? `<div style="margin-top:8px;font-size:13px" class="muted">제안: ${sug.map((s) => `<button type="button" class="small secondary" data-fill="${esc(s)}" style="margin:0 4px 4px 0">${esc(s)}</button>`).join('')}</div>` : ''}
    </section>`);
  }

  const tabLink = (key, label, count) => `<a href="/applicants/postings${key === 'done' ? '?tab=done' : ''}"${tab === key ? ' aria-current="page"' : ''}>${label} <span class="n">${count}</span></a>`;
  const notice = flash === 'saved'
    ? `<div class="notice ok">${icon('check')}<div><b>${Number(n) || 0}명</b>에게 적용했어요. 앞으로 같은 공고로 오는 지원도 자동으로 정리돼요.${Number(fr) ? ` 대기 중인 <b>${Number(fr)}명</b>의 연락처 가져오기도 요청했어요(확장 프로그램이 켜져 있으면 1분 안에 채워져요).` : ''}${todo.length ? ` 남은 공고 <b>${todo.length}개</b>` : ' 정리할 공고가 모두 끝났어요.'}</div></div>` : '';
  const errBox = ERR[err] ? `<div class="notice warn" role="alert">${icon('alert')}<div>${esc(ERR[err])}</div></div>` : '';

  return `${pageHeader({ title: '공고 정리', desc: '같은 공고로 지원한 사람들을 한 번에 정리해요. 공고마다 한 번만 입력하면 그 공고의 모든 지원자에게 적용돼요.' })}
    ${peopleTabs('postings', pending, todo.length)}
    ${notice}${errBox}
    <div class="tabs">${tabLink('todo', '정리 필요', todo.length)}${tabLink('done', '정리 끝', done.length)}</div>
    <datalist id="dl-pjob">${jobs.map((j) => `<option value="${esc(j.v)}">`).join('')}</datalist>
    ${cards.length ? cards.join('') : emptyState({ title: tab === 'done' ? '정리가 끝난 공고가 아직 없어요' : '정리할 공고가 없어요', desc: tab === 'done' ? '' : '알바몬 지원 메일로 들어온 지원자가 있으면 공고별로 여기에 모여요.' })}`;
}

export async function handlePostings(c) {
  const { url, path, method, db, user, readForm, html, redirect, pg, audit, request } = c;
  if (!path.startsWith('/applicants/postings')) return null;
  const viewer = { id: user.id, isSuper: user.role === 'super' };
  const pending = await pendingInboxCount(db, viewer).catch(() => 0);
  if (path === '/applicants/postings' && method === 'GET') {
    const sp = url.searchParams;
    return html(pg('공고 정리', await renderPostings(db, {
      tab: sp.get('tab') === 'done' ? 'done' : 'todo', viewer, flash: sp.get('ok') || '', n: sp.get('n') || 0, fr: sp.get('fr') || 0, err: sp.get('err') || '', pending
    }), 'applicants'));
  }
  if (path === '/applicants/postings/save' && method === 'POST') {
    const f = await readForm(request);
    const tab = f.tab === 'done' ? '?tab=done' : '';
    const back = /^\/applicants\/\d+$/.test(String(f.back || '')) ? f.back : '';   // 지원자 상세에서 눌렀으면 거기로 돌아간다
    const r = await classifyPosting(db, f.recruit_no, f.cost_center, f.job, user.id);
    if (!r.ok) return redirect(back ? `${back}?err=cclist` : `/applicants/postings${tab}${tab ? '&' : '?'}err=${r.error}`);
    await audit(db, user, 'applicant.posting_classify', `n=${r.people}`);
    if (back) return redirect(`${back}?ok=posting&n=${r.people}&fr=${r.fetchReq}`);
    return redirect(`/applicants/postings${tab}${tab ? '&' : '?'}ok=saved&n=${r.people}&fr=${r.fetchReq}`);
  }
  return null;
}
