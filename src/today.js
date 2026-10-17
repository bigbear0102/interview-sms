// 오늘 면접: 면접일시가 그날인 사람을 모든 면접 안내에서 모아 시간순으로 보여 주고, 출석·노쇼를 바로 기록한다.
// (면접 당일 할 일. 예전에는 안내마다 상세 화면 맨 아래 표에서 골라야 했다)
import { all, first } from './d1.js';
import { esc, icon } from './views.js';
import { fmtPhone, pageHeader, emptyState } from './ui.js';
import { parseInterviewAt, setOutcome, OUTCOMES } from './reminders.js';

const KST = 9 * 3600000;
const DAY = 86400000;
const DOW = ['일', '월', '화', '수', '목', '금', '토'];
const dayStartOf = (ms) => Math.floor((ms + KST) / DAY) * DAY - KST;
export const dayKey = (ms) => new Date(ms + KST).toISOString().slice(0, 10);
const dayLabel = (start) => { const d = new Date(start + KST); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${DOW[d.getUTCDay()]})`; };
const hhmm = (ms) => new Date(ms + KST).toISOString().slice(11, 16);

// 그날(KST) 면접인 사람. 불참·취소·개인정보 파기된 안내는 뺀다. 관리자가 아니면 자기 부서만.
export async function interviewsOn(db, user, day = Date.now()) {
  const start = dayStartOf(day);
  const scoped = user.role !== 'super';
  const deps = user.departments || [];
  if (scoped && !deps.length) return [];
  const rows = await all(db,
    `SELECT ca.id, ca.campaign_id, ca.site, ca.name, ca.phone, ca.interview_at, ca.status, ca.outcome, k.name camp,
        (SELECT id FROM applicants WHERE phone=ca.phone) applicant_id,
        (SELECT rr.stars FROM applicant_ratings rr JOIN applicants ap ON ap.id=rr.applicant_id WHERE ap.phone=ca.phone AND rr.user_id=?) my_stars
       FROM candidates ca JOIN campaigns k ON k.id=ca.campaign_id
      WHERE ca.interview_at!='' AND ca.status IN ('attending','unclear','sent') AND k.purged_at IS NULL AND k.status!='cancelled'
        AND k.created_at > ? ${scoped ? `AND k.department_id IN (${deps.map(() => '?').join(',')})` : ''}
      ORDER BY ca.id`, user.id ?? 0, start - 120 * DAY, ...(scoped ? deps : []));
  const out = [];
  for (const r of rows) {
    const at = parseInterviewAt(r.interview_at, start + 12 * 3600000);
    if (Number.isFinite(at) && at >= start && at < start + DAY) out.push({ ...r, at });
  }
  return out.sort((a, b) => a.at - b.at || a.name.localeCompare(b.name, 'ko'));
}

// 홈 할 일: 오늘 면접인 참석자 중 아직 출석·노쇼를 기록하지 않은 사람 수
export async function todayTodo(db, user, now = Date.now()) {
  const list = await interviewsOn(db, user, now);
  return { total: list.filter((r) => r.status === 'attending').length, left: list.filter((r) => r.status === 'attending' && !r.outcome).length };
}

export async function saveTodayOutcome(db, user, candidateId, outcome) {
  if (outcome !== '' && !OUTCOMES[outcome]) return false;
  const c = await first(db, `SELECT ca.id, k.department_id FROM candidates ca JOIN campaigns k ON k.id=ca.campaign_id WHERE ca.id=? AND k.purged_at IS NULL`, candidateId);
  if (!c || (user.role !== 'super' && !(user.departments || []).includes(c.department_id))) return false;
  await setOutcome(db, c.id, outcome);
  return true;
}

export function renderToday(list, { day = Date.now(), now = Date.now() } = {}) {
  const start = dayStartOf(day);
  const isToday = start === dayStartOf(now);
  const q = (ms) => `/interviews/today?d=${dayKey(ms)}`;
  const coming = list.filter((r) => r.status === 'attending');
  const unsure = list.filter((r) => r.status !== 'attending');
  const done = coming.filter((r) => r.outcome).length;

  const row = (r) => {
    const tel = `<a class="tel" href="tel:${esc(r.phone)}">${esc(fmtPhone(r.phone))}</a>`;
    const btn = (k, label, cls) => r.outcome === k
      ? `<button class="obtn ${cls} on" name="outcome" value="" aria-pressed="true" title="누르면 기록을 지워요">${icon('check', 16)}${label}</button>`
      : `<button class="obtn ${cls}" name="outcome" value="${k}" aria-pressed="false">${label}</button>`;
    return `<li class="trow${r.outcome ? ' rec' : ''}" id="c${r.id}">
      <div class="tm">${esc(hhmm(r.at))}</div>
      <div class="who"><b>${esc(r.name || '-')}</b>${r.status !== 'attending' ? ` <span class="badge ${r.status === 'unclear' ? 'review' : 'wait'}">${r.status === 'unclear' ? '확인 필요' : '답 없음'}</span>` : ''}
        <span class="sub">${tel} · ${esc(r.site)} · <a class="tcamp" href="/campaigns/${r.campaign_id}">${esc(r.camp)}</a></span></div>
      <form method="post" action="/interviews/outcome" class="ob">
        <input type="hidden" name="id" value="${r.id}"><input type="hidden" name="d" value="${dayKey(start)}">
        ${btn('showed', '출석', 'yes')}${btn('noshow', '노쇼', 'no')}
        ${r.outcome && !['showed', 'noshow'].includes(r.outcome) ? `<span class="badge ok">${esc(OUTCOMES[r.outcome])}</span>` : ''}
      </form>
      ${r.applicant_id && r.outcome !== 'noshow' ? `<form method="post" action="/applicants/${r.applicant_id}/rate" class="tstars" aria-label="${esc(r.name)} 내 별점">
        <input type="hidden" name="back" value="${esc(q(start))}">${[1, 2, 3, 4, 5].map((s) => `<button name="stars" value="${s}" class="starbtn${r.my_stars && s <= r.my_stars ? ' on' : ''}" aria-label="${s}점" title="별점 ${s}점">★</button>`).join('')}</form>` : ''}</li>`;
  };

  return `<style>
.daynav{display:flex;align-items:center;gap:8px;margin-bottom:16px;flex-wrap:wrap}
.daynav b{font-size:18px;min-width:96px;text-align:center}
.tlist{list-style:none;margin:0;padding:0;background:var(--surface);border:1px solid var(--line);border-radius:var(--r-l);overflow:hidden}
.trow{display:grid;grid-template-columns:64px minmax(0,1fr) auto;gap:4px 14px;align-items:center;padding:14px 16px;border-top:1px solid var(--line-soft)}
.trow:first-child{border-top:0}
.trow.rec{background:var(--surface-2)}
.trow .tm{font-size:20px;font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap}
.trow .who b{font-size:17px}
.trow .sub{display:block;color:var(--muted);font-size:14px}
.trow .tcamp{color:var(--muted);white-space:nowrap}
.tstars{grid-column:2/-1;display:flex;gap:0;margin-top:-4px}
.tstars .starbtn{background:none;border:0;padding:0 3px;min-height:32px;min-width:30px;font-size:20px;line-height:1;color:var(--line);cursor:pointer}
.tstars .starbtn.on{color:#f5a623}
.tstars:hover .starbtn{color:#f5a623}.tstars .starbtn:hover~.starbtn{color:var(--line)}
.ob{display:flex;gap:8px;align-items:center}
.obtn{min-width:76px;min-height:48px;border-radius:12px;font-size:16px;font-weight:700;background:var(--chip);color:var(--ink);border:2px solid transparent;display:inline-flex;gap:4px;align-items:center;justify-content:center}
.obtn.yes.on{background:var(--green-bg);color:var(--green-t);border-color:var(--green)}
.obtn.no.on{background:var(--red-bg);color:var(--red-t);border-color:var(--red)}
@media (max-width:640px){.trow{grid-template-columns:58px minmax(0,1fr)}.trow .tm{font-size:18px}.trow .ob{grid-column:1/-1}.obtn{flex:1}}
</style>
  ${pageHeader({ title: isToday ? '오늘 면접' : `${dayLabel(start)} 면접`,
    desc: '면접일시가 이날인 사람을 모든 면접 안내에서 모았어요. 면접이 끝나면 <b>출석</b> 또는 <b>노쇼</b>를 눌러 기록해요.',
    back: { href: '/campaigns', label: '면접 안내' } })}
  <nav class="daynav" aria-label="날짜 바꾸기">
    <a class="btn secondary small" href="${q(start - DAY)}">← 전날</a><b>${esc(dayLabel(start))}</b><a class="btn secondary small" href="${q(start + DAY)}">다음 날 →</a>
    ${isToday ? '' : `<a class="btn tertiary small" href="/interviews/today">오늘로</a>`}
    ${coming.length ? `<span class="muted" style="margin-left:auto">참석 예정 ${coming.length}명 · 기록 ${done}명</span>` : ''}
  </nav>
  ${coming.length ? `<ul class="tlist">${coming.map(row).join('')}</ul>`
    : emptyState({ title: isToday ? '오늘 면접 예정인 사람이 없어요' : '이날 면접 예정인 사람이 없어요', desc: '"참석"이라고 답했거나 일정을 고른 사람이 여기에 나와요. 면접일시를 "10/20 14:00"처럼 적은 안내만 모여요.' })}
  ${unsure.length ? `<section class="section"><div class="shead"><h2>참석 답장은 없지만 이날 면접인 사람</h2><span class="muted">${unsure.length}명 · 오면 출석으로 기록하세요</span></div>
    <ul class="tlist">${unsure.map(row).join('')}</ul></section>` : ''}`;
}
