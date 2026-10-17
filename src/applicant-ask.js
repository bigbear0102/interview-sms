// "AI로 지원자 찾기": 담당자가 문장으로 물으면("안양 사무 추천해줘") 조건을 뽑아 지원자를 찾고, 담당자 별점 높은 순으로 보여 준다.
// - AI 에는 담당자가 쓴 문장만 보낸다. 지원자 정보는 보내지 않는다(검색·순서는 시스템이 DB 에서 한다).
// - AI 는 조건만 정한다. 추천 순서는 담당자 별점 → 별점 수 → 최근 지원. AI 가 사람을 평가하지 않는다.
// - 검색은 제한 없이: 지역·직무·학력·경력·주소 등 무엇이든 찾는다(2026-10-18 사용자 결정).
//   단, 나이·성별·혼인·임신으로 고르는 것은 채용에서 법으로 금지(남녀고용평등법 7조, 고령자고용법 4조의4)라 빼고 알려 준다.
//   청소년(19세 미만) 제외는 근로 보호 목적이라 "성인만"으로 쓸 수 있다.
// - AI 가 꺼져 있거나 실패하면 문장의 낱말로 그대로 찾는다.
import { all } from './d1.js';
import { esc, icon, fmtTime } from './views.js';
import { fmtPhone, pageHeader, emptyState } from './ui.js';
import { askJson, aiEnabled } from './ai.js';
import { starBadge, RATING_CSS } from './applicant-ratings.js';
import { peopleTabs } from './workspace.js';

const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

const SYSTEM = `채용 담당자가 지원자를 찾는 문장을 검색 조건으로 바꾼다. JSON 한 개만 출력한다.
형식: {"areas":[],"jobs":[],"keywords":[],"minStars":숫자 또는 null,"includeBlacklist":false,"adultsOnly":false,"limit":숫자 또는 null,"ignored":[]}
- areas: 지역·지점·현장·고객사 이름(예: 안양, 강남점, 아마노). 원문 낱말 그대로, "시/구/점" 같은 꼬리는 빼도 된다.
- jobs: 직무(예: 사무, 주차관리, 물류, 상담). 원문 낱말 그대로.
- keywords: 그 밖의 검색어(학력·경력·주소·회사 등, 예: 대졸, 경력, 운전). "추천", "찾아줘", "사람", "지원자" 같은 말은 넣지 않는다.
- "별점 4점 이상", "평가 좋은" → minStars(좋은=4). "5명" → limit. "블랙리스트 포함" → includeBlacklist true.
- "성인만", "미성년자 제외" → adultsOnly true.
- 나이(20대, 30살, 젊은)·성별(남자, 여자)·결혼·임신 조건은 검색어로 쓰지 않고 ignored 에 그 말을 적는다(법으로 금지).
- 원문에 없는 조건을 만들지 않는다.`;

const STOP = /^(블랙리스트|포함|포함해서|추천|추천해|추천해줘|추천해주세요|찾아|찾아줘|찾아주세요|알려줘|보여줘|사람|사람들|지원자|지원자들|인원|좀|해줘|주세요|중에|중에서|있는|에서|으로|로)$/;
// 채용에서 법으로 금지된 기준(나이·성별·혼인·임신)만 막는다
const PROTECTED = /(\d+\s*대(?!학)|\d+\s*살|\d+\s*세\s*(?:이상|이하|미만|초과)|나이|연령|젊은|남자|여자|남성|여성|남자분|여자분|결혼|미혼|기혼|임신)/g;
const ADULT = /(성인만|성인|미성년자?\s*제외|청소년\s*제외)/;

// AI 없이: 낱말로
export function plainFilters(q) {
  const ignored = [...new Set((String(q).match(PROTECTED) || []).map((x) => x.trim()))];
  const words = String(q).replace(PROTECTED, ' ').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/)
    .map((w) => w.replace(/(을|를|이|가|은|는|의|에|만|도)$/u, '')).filter((w) => w.length >= 2 && !STOP.test(w));
  const adultsOnly = ADULT.test(q);
  return { areas: [], jobs: [], keywords: words.filter((w) => !ADULT.test(w) && !/^(미성년자?|청소년|제외)$/.test(w)).slice(0, 3), minStars: null, includeBlacklist: /블랙/.test(q), adultsOnly, limit: null, ignored };
}

// AI 답을 검사해 안전한 조건으로
export function cleanFilters(j, q) {
  const list = (v, n) => (Array.isArray(v) ? v : []).map((x) => clip(x, 20)).filter((x) => x.length >= 1 && !STOP.test(x)).slice(0, n);
  const f = {
    areas: list(j.areas, 3), jobs: list(j.jobs, 3), keywords: list(j.keywords, 3),
    minStars: Number.isInteger(j.minStars) && j.minStars >= 1 && j.minStars <= 5 ? j.minStars : null,
    includeBlacklist: j.includeBlacklist === true && /블랙/.test(q),
    adultsOnly: j.adultsOnly === true || ADULT.test(q),
    limit: Number.isInteger(j.limit) && j.limit >= 1 ? Math.min(j.limit, 100) : null,
    ignored: list(j.ignored, 5)
  };
  // "사무직", "물류업무" → "사무", "물류"(지원 건에는 짧게 적혀 있는 일이 많다)
  f.jobs = f.jobs.map((w) => (w.length > 2 ? w.replace(/(직원|직|업무|일)$/u, '') : w));
  // 법으로 금지된 기준은 AI 가 놓쳐도 코드가 막는다(검색어에서 빼고 ignored 로)
  for (const k of ['areas', 'jobs', 'keywords']) {
    f[k] = f[k].filter((w) => { const bad = new RegExp(PROTECTED.source).test(w); if (bad && !f.ignored.includes(w)) f.ignored.push(w); return !bad; });
  }
  for (const m of String(q).match(PROTECTED) || []) if (!f.ignored.includes(m.trim())) f.ignored.push(m.trim());
  return f;
}

export async function interpret(env, q) {
  if (aiEnabled(env)) {
    const j = await askJson(env, { system: SYSTEM, user: `문장: ${clip(q, 200)}`, maxTokens: 800 }).catch(() => null);
    if (j && !j.error) {
      const f = cleanFilters(j, q);
      if (f.areas.length || f.jobs.length || f.keywords.length || f.minStars || f.adultsOnly) return { ...f, by: 'ai' };
    }
  }
  return { ...plainFilters(q), by: 'plain' };
}

// 조건 하나(낱말)가 지원 건 또는 받은 지원 메일의 어느 칸에 있으면 맞음
const APP_AREA = ['x.applied_to', 'x.posting_title', 'x.company_raw'];
const INB_AREA = ['i.address', 'i.job_title', 'i.company', 'i.cost_center'];
const APP_JOB = ['x.job', 'x.posting_title'];
const INB_JOB = ['i.job_title', 'i.job'];
function termSql(term, appCols, inbCols, args) {
  const like = `%${term.replace(/[%_]/g, '')}%`;
  appCols.forEach(() => args.push(like));
  inbCols.forEach(() => args.push(like));
  return `(EXISTS (SELECT 1 FROM applicant_applications x WHERE x.applicant_id=a.id AND (${appCols.map((c) => `${c} LIKE ?`).join(' OR ')}))
     OR EXISTS (SELECT 1 FROM applicant_inbox i WHERE i.phone=a.phone AND i.phone != '' AND (${inbCols.map((c) => `${c} LIKE ?`).join(' OR ')})))`;
}

// 반환: { rows, total }
export async function searchApplicants(db, f) {
  const where = [], args = [];
  const group = (terms, appCols, inbCols) => { if (terms.length) where.push(`(${terms.map((t) => termSql(t, appCols, inbCols, args)).join(' OR ')})`); };
  group(f.areas, APP_AREA, INB_AREA);
  group(f.jobs, APP_JOB, INB_JOB);
  for (const k of f.keywords) where.push(termSql(k, [...APP_AREA, 'x.job'], [...INB_AREA, 'i.job', 'i.education', 'i.career'], args));
  if (!where.length && !f.minStars && !f.adultsOnly) return { rows: [], total: 0 };
  if (f.adultsOnly) where.push(`NOT EXISTS (SELECT 1 FROM applicant_inbox i WHERE i.phone=a.phone AND i.phone != '' AND i.age IS NOT NULL AND i.age < 19)`);
  if (!f.includeBlacklist) where.push(`NOT EXISTS (SELECT 1 FROM blacklist b WHERE b.applicant_id=a.id AND b.status='active')`);
  const having = f.minStars ? ` WHERE COALESCE(avg_stars, 0) >= ${Number(f.minStars)}` : '';
  const inner = `SELECT a.id, a.name, a.phone,
      (SELECT ROUND(AVG(stars), 1) FROM applicant_ratings WHERE applicant_id=a.id) avg_stars,
      (SELECT COUNT(*) FROM applicant_ratings WHERE applicant_id=a.id) n_stars,
      (SELECT MAX(created_at) FROM applicant_applications WHERE applicant_id=a.id) last_at,
      EXISTS (SELECT 1 FROM blacklist b WHERE b.applicant_id=a.id AND b.status='active') bl
    FROM applicants a WHERE ${where.length ? where.join(' AND ') : '1=1'}`;
  const total = (await all(db, `SELECT COUNT(*) n FROM (${inner})${having}`, ...args))[0].n;
  const rows = await all(db, `SELECT * FROM (${inner})${having}
      ORDER BY COALESCE(avg_stars, 0) DESC, n_stars DESC, COALESCE(last_at, 0) DESC, id DESC LIMIT ?`, ...args, f.limit || 10);
  if (!rows.length) return { rows, total };
  // 보여 줄 사실: 최근 지원 건, 면접 결과(출석·노쇼 횟수)
  const ids = rows.map((r) => r.id), phones = rows.map((r) => r.phone);
  const apps = await all(db, `SELECT applicant_id, applied_to, job, posting_title FROM applicant_applications
      WHERE applicant_id IN (${ids.map(() => '?').join(',')}) ORDER BY id DESC`, ...ids);
  const outs = await all(db, `SELECT phone, SUM(outcome IN ('showed','passed','hired')) showed, SUM(outcome='noshow') noshow
      FROM candidates WHERE phone IN (${phones.map(() => '?').join(',')}) GROUP BY phone`, ...phones);
  for (const r of rows) {
    r.apps = apps.filter((x) => x.applicant_id === r.id).slice(0, 2);
    const o = outs.find((x) => x.phone === r.phone);
    r.showed = o ? o.showed : 0; r.noshow = o ? o.noshow : 0;
  }
  return { rows, total };
}

function describe(f) {
  const parts = [];
  if (f.areas.length) parts.push(`지역·현장 <b>${f.areas.map(esc).join(', ')}</b>`);
  if (f.jobs.length) parts.push(`직무 <b>${f.jobs.map(esc).join(', ')}</b>`);
  if (f.keywords.length) parts.push(`검색어 <b>${f.keywords.map(esc).join(', ')}</b>`);
  if (f.minStars) parts.push(`별점 <b>${f.minStars}점 이상</b>`);
  if (f.adultsOnly) parts.push('<b>청소년(19세 미만) 제외</b>');
  parts.push(f.includeBlacklist ? '블랙리스트 포함' : '블랙리스트 제외');
  return parts.join(' · ');
}

export function renderAsk({ q = '', f = null, result = null, pending = 0, todo = 0, ai = false }) {
  const examples = ['안양 사무 추천해줘', '주차관리 별점 4점 이상', '강남 물류 경력 성인만'];
  const answer = !q ? '' : !f || (!f.areas.length && !f.jobs.length && !f.keywords.length && !f.minStars && !f.adultsOnly)
    ? `<div class="bubble ai">무엇을 찾을지 알 수 없었어요. 지역이나 직무를 넣어 다시 물어봐 주세요. (예: 안양 사무)</div>`
    : `<div class="bubble ai">
        <p>${describe(f)} 조건으로 찾았어요. ${result.total ? `<b>${result.total}명</b> 중 ${result.rows.length < result.total ? `상위 ${result.rows.length}명을 ` : ''}담당자 별점 높은 순으로 보여 드려요.` : '맞는 지원자가 없어요.'}</p>
        ${f.ignored.length ? `<p class="notice warn" style="margin-top:8px">${icon('alert')}<span><b>${f.ignored.map(esc).join(', ')}</b> 조건은 빼고 찾았어요. 채용에서 나이·성별·결혼으로 고르는 것은 법으로 금지되어 있어요(남녀고용평등법·고령자고용법, 벌금 대상). 청소년을 빼려면 "성인만"이라고 적어 주세요.</span></p>` : ''}
        ${f.by === 'plain' ? `<p class="muted" style="font-size:13px;margin-top:6px">${ai ? 'AI가 응답하지 않아' : 'AI가 꺼져 있어'} 입력한 낱말로 찾았어요.</p>` : ''}
        ${result.rows.length ? `<form method="get" action="/campaigns/new" class="asklist" id="askform">
          <ul>${result.rows.map((r) => `<li>
            <label class="pick"><input type="checkbox" value="${r.id}" class="askchk" aria-label="${esc(r.name)} 선택"></label>
            <div class="who"><a href="/applicants/${r.id}"><b>${esc(r.name)}</b></a> <span class="muted">${esc(fmtPhone(r.phone))}</span> ${r.n_stars ? starBadge(r.avg_stars, r.n_stars) : '<span class="muted" style="font-size:13px">별점 없음</span>'}${r.bl ? ' <span class="badge no">블랙리스트</span>' : ''}
              <div class="facts">${r.apps.map((x) => esc([x.applied_to, x.job, x.posting_title].filter(Boolean).join(' · '))).join('<br>') || '<span class="muted">지원 건 없음</span>'}</div>
              ${r.showed || r.noshow ? `<div class="facts">면접 출석 ${r.showed}번${r.noshow ? ` · <b style="color:var(--red-t)">노쇼 ${r.noshow}번</b>` : ''}</div>` : ''}
              ${r.last_at ? `<div class="facts muted">최근 지원 ${esc(fmtTime(r.last_at).slice(0, 10))}</div>` : ''}</div></li>`).join('')}</ul>
          <input type="hidden" name="ids" id="askids">
          <button class="btn" id="askgo" disabled>선택한 사람으로 면접 안내 만들기</button></form>` : ''}
      </div>`;
  return `${RATING_CSS}<style>
.askbox{display:flex;gap:8px;margin:4px 0 8px}.askbox input{flex:1;min-width:0}
.askex{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px}
.bubble{border-radius:16px;padding:14px 16px;margin:10px 0;max-width:820px;overflow-wrap:anywhere}
.bubble.me{background:var(--blue);color:#fff;margin-left:auto;width:fit-content;max-width:80%}
.bubble.ai{background:var(--surface);border:1px solid var(--line)}
.asklist ul{list-style:none;margin:12px 0;padding:0;display:grid;gap:0}
.asklist li{display:flex;gap:10px;padding:12px 0;border-top:1px solid var(--line-soft)}
.asklist .pick input{width:20px;height:20px;min-height:0;margin-top:2px}
.asklist .who{min-width:0;flex:1}
.asklist .facts{font-size:14px;margin-top:4px}
</style>
  ${pageHeader({ title: 'AI로 지원자 찾기', desc: '찾는 조건을 말하듯 적으면, 맞는 지원자를 담당자 별점 높은 순으로 보여 줘요.' })}
  ${peopleTabs('ask', pending, todo)}
  <form method="get" action="/applicants/ask" class="askbox" role="search">
    <input name="q" value="${esc(q)}" placeholder="예: 안양 사무 추천해줘" maxlength="200" aria-label="찾는 조건" autocomplete="off" ${q ? '' : 'autofocus'}>
    <button class="btn">찾기</button></form>
  <div class="askex">${examples.map((e) => `<a class="chipbtn" href="/applicants/ask?q=${encodeURIComponent(e)}">${esc(e)}</a>`).join('')}</div>
  ${q ? `<div class="bubble me">${esc(q)}</div>${answer}` : emptyState({ title: '찾는 조건을 적어 보세요', desc: '지역·직무·학력·경력·주소·별점 등 무엇이든 적어 보세요. AI는 조건만 정하고, 순서는 담당자들이 준 별점으로 정해요. 지원자 정보는 AI에 보내지 않아요.' })}
  <script>(function(){var f=document.getElementById('askform');if(!f)return;var go=document.getElementById('askgo'),ids=document.getElementById('askids');
    f.addEventListener('change',function(){var v=Array.prototype.slice.call(f.querySelectorAll('.askchk:checked')).map(function(c){return c.value;});ids.value=v.join(',');go.disabled=!v.length;go.textContent=v.length?'선택한 '+v.length+'명으로 면접 안내 만들기':'선택한 사람으로 면접 안내 만들기';});})();</script>`;
}
