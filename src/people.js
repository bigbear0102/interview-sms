// 지원자 이력: 같은 전화번호의 면접 안내 기록을 한 사람으로 묶어 보여 준다. (별도 저장 없이 candidates 를 집계)
// 개인정보 보관 기간이 지나 파기된 기록(번호 없음)은 포함되지 않는다.
import { all } from './d1.js';
import { esc, icon } from './views.js';
import { fmtPhone, pageHeader, tableWrap, emptyState } from './ui.js';
import { normalizePhone } from './parser.js';

const ph = (n) => Array.from({ length: n }, () => '?').join(',');

export async function renderPeople(db, deps, q = '') {
  const depIds = deps.map((d) => d.id);
  const term = String(q || '').trim();
  let rows = [];
  if (depIds.length) {
    const where = [`k.department_id IN (${ph(depIds.length)})`, `ca.phone!=''`];
    const args = [...depIds];
    if (term) {
      const digits = normalizePhone(term);
      where.push(`(ca.name LIKE ? OR ca.phone = ? OR ca.site LIKE ?)`);
      args.push(`%${term}%`, digits || term, `%${term}%`);
    }
    rows = await all(db,
      `SELECT ca.phone phone, MAX(ca.name) name, COUNT(*) invited,
         SUM(ca.status IN ('attending')) attending, SUM(ca.status='absent') absent,
         SUM(ca.outcome='showed') showed, SUM(ca.outcome='noshow') noshow,
         SUM(ca.outcome='passed') passed, SUM(ca.outcome='hired') hired,
         MAX(ca.sent_at) last_at, GROUP_CONCAT(DISTINCT ca.site) sites
       FROM candidates ca JOIN campaigns k ON k.id=ca.campaign_id
       WHERE ${where.join(' AND ')}
       GROUP BY ca.phone ORDER BY noshow DESC, last_at DESC LIMIT 300`, ...args);
  }
  const body = rows.length ? tableWrap(`<table class="cards"><thead><tr><th>이름</th><th>전화번호</th><th class="num">안내</th><th class="num">참석 답장</th><th class="num">출석</th><th class="num">노쇼</th><th class="num">합격</th><th class="num">입사</th><th>사업장</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td>${esc(r.name)}${r.noshow >= 2 ? ' <b style="color:var(--red)">노쇼 반복</b>' : ''}</td><td class="nowrap" data-label="전화번호">${esc(fmtPhone(r.phone))}</td>
      <td class="num" data-label="안내">${r.invited}회</td><td class="num" data-label="참석 답장">${r.attending}</td><td class="num" data-label="출석">${r.showed}</td>
      <td class="num" data-label="노쇼">${r.noshow}</td><td class="num" data-label="합격">${r.passed}</td><td class="num" data-label="입사">${r.hired}</td><td data-label="사업장">${esc(String(r.sites || '').split(',').join(', '))}</td></tr>`).join('')}
    </tbody></table>`)
    : emptyState({ title: term ? '찾는 사람이 없어요' : '아직 기록이 없어요', desc: '면접 안내를 보내면 사람별 이력이 여기에 쌓여요.' });
  return `${pageHeader({ title: '지원자 이력', back: { href: '/campaigns', label: '면접 안내' },
    desc: '같은 전화번호의 면접 안내를 한 사람으로 묶어 보여 줘요. 노쇼가 많은 사람이 위에 나와요. 개인정보 보관 기간이 지난 기록은 빠져요.' })}
    <form method="get" style="display:flex;gap:8px;margin-bottom:16px;max-width:420px"><input name="q" value="${esc(term)}" placeholder="이름, 전화번호, 사업장" aria-label="검색">
      <button class="secondary" style="flex:none">찾기</button></form>
    <div class="card" style="padding:0">${body}</div>`;
}
