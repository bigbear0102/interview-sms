// "AI로 지원자 찾기": 담당자가 문장으로 물으면("안양 사무 추천해줘") 조건을 뽑아 지원자를 찾고, 담당자 별점 높은 순으로 보여 준다.
// - AI 에는 담당자가 쓴 문장만 보낸다. 지원자 정보는 보내지 않는다(검색·순서는 시스템이 DB 에서 한다).
// - AI 는 조건만 정한다. 추천 순서는 담당자 별점 → 별점 수 → 최근 지원. AI 가 사람을 평가하지 않는다.
// - 검색은 제한 없이: 지역·직무·학력·경력·주소·나이·성별 등(2026-10-18 사용자 결정: 회사 내부 시스템, 법률 자문을 받았고
//   조건을 고르는 판단과 책임은 담당자에게 있음). 나이·성별은 알바몬 지원 메일에 있는 값(applicant_inbox.age, gender)으로 거른다.
//   혼인·임신 여부는 시스템에 정보가 없어 거를 수 없다(따로 모으지 않는다).
// - AI 가 꺼져 있거나 실패하면 문장의 낱말로 그대로 찾는다.
import { all } from './d1.js';
import { esc, icon, fmtTime } from './views.js';
import { fmtPhone, pageHeader, emptyState } from './ui.js';
import { askJson, aiEnabled } from './ai.js';
import { starBadge, RATING_CSS } from './applicant-ratings.js';
import { peopleTabs } from './workspace.js';

const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

const SYSTEM = `채용 담당자가 지원자를 찾는 문장을 검색 조건으로 바꾼다. JSON 한 개만 출력한다.
형식: {"areas":[],"jobs":[],"keywords":[],"minStars":숫자 또는 null,"includeBlacklist":false,"ageMin":숫자 또는 null,"ageMax":숫자 또는 null,"gender":"남|여" 또는 null,"limit":숫자 또는 null,"ignored":[]}
- areas: 지역·지점·현장·고객사 이름(예: 안양, 강남점, 아마노). 원문 낱말 그대로, "시/구/점" 같은 꼬리는 빼도 된다.
- jobs: 직무(예: 사무, 주차관리, 물류, 상담). 원문 낱말 그대로.
- keywords: 그 밖의 검색어(학력·경력·주소·회사 등, 예: 대졸, 경력, 운전). "추천", "찾아줘", "사람", "지원자" 같은 말은 넣지 않는다.
- "별점 4점 이상", "평가 좋은" → minStars(좋은=4). "5명" → limit. "블랙리스트 포함" → includeBlacklist true.
- 나이: "20대" → ageMin 20, ageMax 29. "30세 이상" → ageMin 30. "25살 이하" → ageMax 25. "성인만" → ageMin 19. 숫자가 없는 말("젊은")은 ignored 에.
- 성별: 남자·남성 → "남", 여자·여성 → "여".
- 결혼·임신처럼 시스템에 정보가 없는 조건은 ignored 에 적는다.
- 원문에 없는 조건을 만들지 않는다.`;

const STOP = /^(블랙리스트|포함|포함해서|추천|추천해|추천해줘|추천해주세요|찾아|찾아줘|찾아주세요|알려줘|보여줘|사람|사람들|지원자|지원자들|인원|좀|해줘|주세요|중에|중에서|있는|에서|으로|로)$/;
// 나이·성별은 낱말로 직접 읽는다(AI 보다 확실하게). 결혼·임신은 정보가 없어 거를 수 없다.
const NOINFO = /(결혼|미혼|기혼|임신|출산)/g;
const AGE_GENDER = /(\d{1,2})\s*대(?!학)(?:\s*(초반|중반|후반))?|(\d{1,2})\s*(?:세|살)\s*(이상|이하|미만|초과|부터|까지)?|성인만|성인|미성년자?\s*제외|청소년\s*제외|남자분?|남성|여자분?|여성/g;
export function ageGenderOf(q) {
  const out = { ageMin: null, ageMax: null, gender: null };
  const t = String(q);
  for (const m of t.matchAll(AGE_GENDER)) {
    const w = m[0];
    if (m[1]) {
      const d = Number(m[1]); let lo = d, hi = d + 9;
      if (m[2] === '초반') hi = d + 3; else if (m[2] === '중반') { lo = d + 3; hi = d + 6; } else if (m[2] === '후반') lo = d + 7;
      out.ageMin = Math.max(out.ageMin ?? 0, lo); out.ageMax = Math.min(out.ageMax ?? 200, hi);
    } else if (m[3]) {
      const n = Number(m[3]), op = m[4] || '';
      if (op === '이상' || op === '부터') out.ageMin = n; else if (op === '초과') out.ageMin = n + 1;
      else if (op === '이하' || op === '까지') out.ageMax = n; else if (op === '미만') out.ageMax = n - 1;
      else { out.ageMin = n; out.ageMax = n; }
    } else if (/성인|미성년|청소년/.test(w)) out.ageMin = Math.max(out.ageMin ?? 0, 19);
    else out.gender = /남/.test(w) ? '남' : '여';
  }
  return out;
}

// AI 없이: 낱말로
export function plainFilters(q) {
  const ignored = [...new Set((String(q).match(NOINFO) || []).map((x) => x.trim()))];
  const words = String(q).replace(NOINFO, ' ').replace(AGE_GENDER, ' ').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/)
    .map((w) => w.replace(/(을|를|이|가|은|는|의|에|만|도)$/u, '')).filter((w) => w.length >= 2 && !STOP.test(w) && !/^(미성년자?|청소년|제외|초반|중반|후반)$/.test(w));
  return { areas: [], jobs: [], keywords: words.slice(0, 3), minStars: null, includeBlacklist: /블랙/.test(q), ...ageGenderOf(q), limit: null, ignored };
}

// AI 답을 검사해 안전한 조건으로
export function cleanFilters(j, q) {
  const list = (v, n) => (Array.isArray(v) ? v : []).map((x) => clip(x, 20)).filter((x) => x.length >= 1 && !STOP.test(x)).slice(0, n);
  const f = {
    areas: list(j.areas, 3), jobs: list(j.jobs, 3), keywords: list(j.keywords, 3),
    minStars: Number.isInteger(j.minStars) && j.minStars >= 1 && j.minStars <= 5 ? j.minStars : null,
    includeBlacklist: j.includeBlacklist === true && /블랙/.test(q),
    ageMin: Number.isInteger(j.ageMin) && j.ageMin > 0 && j.ageMin < 100 ? j.ageMin : null,
    ageMax: Number.isInteger(j.ageMax) && j.ageMax > 0 && j.ageMax < 100 ? j.ageMax : null,
    gender: j.gender === '남' || j.gender === '여' ? j.gender : null,
    limit: Number.isInteger(j.limit) && j.limit >= 1 ? Math.min(j.limit, 100) : null,
    ignored: list(j.ignored, 5)
  };
  // "사무직", "물류업무" → "사무", "물류"(지원 건에는 짧게 적혀 있는 일이 많다)
  f.jobs = f.jobs.map((w) => (w.length > 2 ? w.replace(/(직원|직|업무|일)$/u, '') : w));
  // 나이·성별은 원문에서 직접 읽은 값이 있으면 그것을 쓴다(AI 가 틀려도), 검색어에서는 뺀다
  const ag = ageGenderOf(q);
  if (ag.ageMin !== null || ag.ageMax !== null) { f.ageMin = ag.ageMin; f.ageMax = ag.ageMax; }
  if (ag.gender) f.gender = ag.gender;
  const isAG = (w) => new RegExp(AGE_GENDER.source).test(w) || /^(젊은|나이|연령)$/.test(w);
  const isNo = (w) => new RegExp(NOINFO.source).test(w);
  for (const k of ['areas', 'jobs', 'keywords']) {
    f[k] = f[k].filter((w) => { if (isNo(w) && !f.ignored.includes(w)) f.ignored.push(w); return !isAG(w) && !isNo(w); });
  }
  for (const m of String(q).match(NOINFO) || []) if (!f.ignored.includes(m.trim())) f.ignored.push(m.trim());
  f.ignored = f.ignored.filter((w) => !isAG(w) || !(ag.ageMin !== null || ag.ageMax !== null || ag.gender));
  return f;
}

const hasCond = (f) => !!(f.areas.length || f.jobs.length || f.keywords.length || f.minStars || f.ageMin !== null || f.ageMax !== null || f.gender);

export async function interpret(env, q) {
  if (aiEnabled(env)) {
    const j = await askJson(env, { system: SYSTEM, user: `문장: ${clip(q, 200)}`, maxTokens: 800 }).catch(() => null);
    if (j && !j.error) {
      const f = cleanFilters(j, q);
      if (hasCond(f)) return { ...f, by: 'ai' };
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
  if (!hasCond(f)) return { rows: [], total: 0 };
  // 나이·성별: 알바몬 지원 메일에 그 값이 있는 사람만(모르는 사람은 빠진다)
  const ageMin = f.ageMin ?? null, ageMax = f.ageMax ?? null;
  if (ageMin !== null || ageMax !== null || f.gender) {
    const c = [];
    if (ageMin !== null) { c.push('i.age >= ?'); args.push(ageMin); }
    if (ageMax !== null) { c.push('i.age <= ?'); args.push(ageMax); }
    if (f.gender) { c.push('i.gender = ?'); args.push(f.gender); }
    where.push(`EXISTS (SELECT 1 FROM applicant_inbox i WHERE i.phone=a.phone AND i.phone != '' AND ${c.join(' AND ')})`);
  }
  if (!f.includeBlacklist) where.push(`NOT EXISTS (SELECT 1 FROM blacklist b WHERE b.applicant_id=a.id AND b.status='active')`);
  const having = f.minStars ? ` WHERE COALESCE(avg_stars, 0) >= ${Number(f.minStars)}` : '';
  const inner = `SELECT a.id, a.name, a.phone,
      (SELECT ROUND(AVG(stars), 1) FROM applicant_ratings WHERE applicant_id=a.id) avg_stars,
      (SELECT COUNT(*) FROM applicant_ratings WHERE applicant_id=a.id) n_stars,
      (SELECT MAX(created_at) FROM applicant_applications WHERE applicant_id=a.id) last_at,
      EXISTS (SELECT 1 FROM blacklist b WHERE b.applicant_id=a.id AND b.status='active') bl,
      (SELECT age FROM applicant_inbox i WHERE i.phone=a.phone AND i.phone != '' AND i.age IS NOT NULL ORDER BY i.received_at DESC LIMIT 1) age,
      (SELECT gender FROM applicant_inbox i WHERE i.phone=a.phone AND i.phone != '' AND i.gender != '' ORDER BY i.received_at DESC LIMIT 1) gender
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
  if (f.ageMin !== null || f.ageMax !== null) parts.push(`나이 <b>${f.ageMin ?? ''}${f.ageMin !== null && f.ageMax !== null ? '~' : f.ageMin !== null ? '세 이상' : ''}${f.ageMax !== null ? `${f.ageMax}세${f.ageMin === null ? ' 이하' : ''}` : ''}</b>`);
  if (f.gender) parts.push(`성별 <b>${f.gender}</b>`);
  parts.push(f.includeBlacklist ? '블랙리스트 포함' : '블랙리스트 제외');
  return parts.join(' · ');
}

export function renderAsk({ q = '', f = null, result = null, pending = 0, todo = 0, ai = false }) {
  const examples = ['안양 사무 추천해줘', '주차관리 별점 4점 이상', '강남 물류 20대 남자'];
  const answer = !q ? '' : !f || !hasCond(f)
    ? `<div class="bubble ai">무엇을 찾을지 알 수 없었어요. 지역이나 직무를 넣어 다시 물어봐 주세요. (예: 안양 사무)</div>`
    : `<div class="bubble ai">
        <p>${describe(f)} 조건으로 찾았어요. ${result.total ? `<b>${result.total}명</b> 중 ${result.rows.length < result.total ? `상위 ${result.rows.length}명을 ` : ''}담당자 별점 높은 순으로 보여 드려요.` : '맞는 지원자가 없어요.'}</p>
        ${f.ignored.length ? `<p class="notice info" style="margin-top:8px">${icon('info')}<span><b>${f.ignored.map(esc).join(', ')}</b> 조건은 시스템에 정보가 없어서 거르지 못했어요.${f.ignored.some((w) => /젊|나이|연령/.test(w)) ? ' 나이는 "20대", "30세 이상"처럼 숫자로 적어 주세요.' : ''}</span></p>` : ''}
        ${f.ageMin !== null || f.ageMax !== null || f.gender ? '<p class="muted" style="font-size:13px;margin-top:6px">나이·성별은 알바몬 지원 메일에 적힌 값으로 걸러요. 그 정보가 없는 지원자(직접 등록 등)는 결과에서 빠져요.</p>' : ''}
        ${f.by === 'plain' ? `<p class="muted" style="font-size:13px;margin-top:6px">${ai ? 'AI가 응답하지 않아' : 'AI가 꺼져 있어'} 입력한 낱말로 찾았어요.</p>` : ''}
        ${result.rows.length ? `<form method="get" action="/campaigns/new" class="asklist" id="askform">
          <ul>${result.rows.map((r) => `<li>
            <label class="pick"><input type="checkbox" value="${r.id}" class="askchk" aria-label="${esc(r.name)} 선택"></label>
            <div class="who"><a href="/applicants/${r.id}"><b>${esc(r.name)}</b></a> <span class="muted">${esc(fmtPhone(r.phone))}${r.gender || r.age ? ` · ${esc([r.gender, r.age ? r.age + '세' : ''].filter(Boolean).join(' '))}` : ''}</span> ${r.n_stars ? starBadge(r.avg_stars, r.n_stars) : '<span class="muted" style="font-size:13px">별점 없음</span>'}${r.bl ? ' <span class="badge no">블랙리스트</span>' : ''}
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
  <form method="get" action="/applicants/ask" class="askbox" role="search" data-busy="AI로 지원자 찾는 중">
    <input name="q" value="${esc(q)}" placeholder="예: 안양 사무 추천해줘" maxlength="200" aria-label="찾는 조건" autocomplete="off" ${q ? '' : 'autofocus'}>
    <button class="btn">찾기</button></form>
  <div class="askex">${examples.map((e) => `<a class="chipbtn" data-busy="AI로 지원자 찾는 중" href="/applicants/ask?q=${encodeURIComponent(e)}">${esc(e)}</a>`).join('')}</div>
  ${q ? `<div class="bubble me">${esc(q)}</div>${answer}` : emptyState({ title: '찾는 조건을 적어 보세요', desc: '지역·직무·학력·경력·주소·나이·성별·별점 등 무엇이든 적어 보세요. AI는 조건만 정하고, 순서는 담당자들이 준 별점으로 정해요. 지원자 정보는 AI에 보내지 않아요.' })}
  <script>(function(){var f=document.getElementById('askform');if(!f)return;var go=document.getElementById('askgo'),ids=document.getElementById('askids');
    f.addEventListener('change',function(){var v=Array.prototype.slice.call(f.querySelectorAll('.askchk:checked')).map(function(c){return c.value;});ids.value=v.join(',');go.disabled=!v.length;go.textContent=v.length?'선택한 '+v.length+'명으로 면접 안내 만들기':'선택한 사람으로 면접 안내 만들기';});})();</script>`;
}
