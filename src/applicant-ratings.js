// 지원자 별점: 담당자마다 1~5점 하나. 평균은 목록·"AI 지원자 찾기" 순서에 쓴다.
// - 별점은 사람(담당자)이 준다. AI 가 별점을 매기거나 지원자를 평가하지 않는다.
// - 누가 몇 점 줬는지 상세 화면에 보이고, 바꾸면 변경 기록에 남는다.
import { all, first, run } from './d1.js';
import { esc } from './views.js';

export const starText = (n) => '★★★★★'.slice(0, Math.round(n)) + '☆☆☆☆☆'.slice(0, 5 - Math.round(n));

// stars: 1~5, 0 이면 내 별점 지우기. 반환: true(바뀜)
export async function setRating(db, applicantId, userId, stars, now = Date.now()) {
  const s = Number(stars);
  if (!Number.isInteger(s) || s < 0 || s > 5 || !userId) return false;
  const cur = await first(db, `SELECT stars FROM applicant_ratings WHERE applicant_id=? AND user_id=?`, applicantId, userId);
  if ((cur ? cur.stars : 0) === s) return false;
  if (s === 0) await run(db, `DELETE FROM applicant_ratings WHERE applicant_id=? AND user_id=?`, applicantId, userId);
  else await run(db, `INSERT INTO applicant_ratings (applicant_id, user_id, stars, updated_at) VALUES (?,?,?,?)
      ON CONFLICT(applicant_id, user_id) DO UPDATE SET stars=excluded.stars, updated_at=excluded.updated_at`, applicantId, userId, s, now);
  await run(db, `INSERT INTO applicant_events (applicant_id, action, detail, user_id, at) VALUES (?,?,?,?,?)`,
    applicantId, 'rate', s ? `별점 ${s}점${cur ? ` (전: ${cur.stars}점)` : ''}` : '내 별점 지움', userId, now);
  return true;
}

export async function ratingsOf(db, applicantId) {
  return all(db, `SELECT r.user_id, r.stars, r.updated_at, COALESCE(NULLIF(u.name,''), u.username) who
      FROM applicant_ratings r LEFT JOIN users u ON u.id=r.user_id WHERE r.applicant_id=? ORDER BY r.updated_at DESC`, applicantId);
}

// 평균(소수 한 자리)과 개수
export function summarize(list) {
  if (!list.length) return { avg: 0, n: 0 };
  return { avg: Math.round((list.reduce((a, r) => a + r.stars, 0) / list.length) * 10) / 10, n: list.length };
}

// 목록용 작은 표시: ★4.3 (3)
export function starBadge(avg, n) {
  if (!n) return '';
  return `<span class="stars" title="담당자 ${n}명 평균 ${avg}점" aria-label="별점 평균 ${avg}점, ${n}명"><span aria-hidden="true">★</span>${Number(avg).toFixed(1)}<small> (${n})</small></span>`;
}

// 상세 화면 패널: 내 별점 고르기 + 평균 + 담당자별
export function ratingPanel(applicantId, list, userId, back = '') {
  const mine = list.find((r) => r.user_id === userId);
  const { avg, n } = summarize(list);
  const btns = [1, 2, 3, 4, 5].map((s) => `<button name="stars" value="${s}" class="starbtn${mine && s <= mine.stars ? ' on' : ''}" aria-label="${s}점" aria-pressed="${mine && mine.stars === s ? 'true' : 'false'}" title="${s}점">★</button>`).join('');
  return `<section class="panel rating"><h2>별점</h2>
    <form method="post" action="/applicants/${applicantId}/rate" class="starform" aria-label="내 별점">${back ? `<input type="hidden" name="back" value="${esc(back)}">` : ''}
      <span class="lbl">내 별점</span><span class="starrow">${btns}</span>${mine ? '<button name="stars" value="0" class="tertiary small" style="margin-left:4px">지우기</button>' : ''}</form>
    <p class="muted" style="font-size:14px;margin:8px 0 0">${n ? `평균 <b style="color:var(--ink)">${avg}점</b> · 담당자 ${n}명` : '아직 아무도 별점을 주지 않았어요.'}</p>
    ${n ? `<ul class="ratelist">${list.map((r) => `<li><span>${esc(r.who || '담당자')}</span><span class="st" aria-label="${r.stars}점">${starText(r.stars)}</span></li>`).join('')}</ul>` : ''}
    <p class="muted" style="font-size:12px;margin-top:8px">면접·근무에서 본 사실을 기준으로 주세요. 나이·성별 같은 이유로 점수를 주면 안 돼요.</p>
  </section>`;
}

export const RATING_CSS = `<style>
.rating .starform{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.rating .lbl{font-size:14px;color:var(--muted);margin-right:4px}
.rating .starrow{display:inline-flex;gap:2px}
.starbtn{background:none;border:0;padding:2px 3px;min-height:40px;min-width:36px;font-size:26px;line-height:1;color:var(--line);cursor:pointer}
.starbtn.on{color:#f5a623}
.starrow:hover .starbtn{color:#f5a623}
.starrow .starbtn:hover~.starbtn{color:var(--line)}
.starbtn:focus-visible{outline:2px solid var(--focus);border-radius:6px}
.ratelist{list-style:none;margin:8px 0 0;padding:0;display:grid;gap:4px;font-size:14px}
.ratelist li{display:flex;justify-content:space-between;gap:8px}
.ratelist .st,.stars{color:#f5a623;white-space:nowrap}
.stars{font-weight:700;font-size:14px;font-variant-numeric:tabular-nums}
.stars small{color:var(--muted);font-weight:400}
</style>`;
