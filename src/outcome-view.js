// 면접 안내 상세: 면접 결과 요약과 자동 리마인드 켜기/끄기
import { esc, icon } from './views.js';
import { stat } from './ui.js';

export function outcomeSection(camp, oc = {}) {
  const held = (oc.showed || 0) + (oc.noshow || 0);
  const rate = held ? Math.round(((oc.showed || 0) / held) * 100) + '%' : '-';
  const on = !!camp.auto_remind;
  const toggle = camp.purged_at ? '' : `<form method="post" action="/campaigns/${camp.id}/autoremind" class="inline" style="margin-top:8px">
      <input type="hidden" name="on" value="${on ? 0 : 1}">
      <span class="muted">${icon('clock', 14)} 자동 리마인드(면접 전날, 참석자에게 한 번): <b>${on ? '켜짐' : '꺼짐'}</b>${on && oc.reminded ? ` · ${oc.reminded}명에게 보냄` : ''}</span>
      <button class="secondary small">${on ? '끄기' : '켜기'}</button></form>`;
  return `<section class="section">
    <div class="shead"><h2>면접 결과</h2><span class="muted">사람별 표에서 결과를 골라 기록해요</span></div>
    <div class="stats">
      ${stat({ value: oc.showed || 0, label: '출석', tone: 'yes' })}
      ${stat({ value: oc.noshow || 0, label: '노쇼', tone: 'no' })}
      ${stat({ value: oc.passed || 0, label: '합격' })}
      ${stat({ value: oc.hired || 0, label: '입사' })}
    </div>
    <p class="muted" style="margin-top:8px">출석률 ${esc(rate)} <small>(출석 ÷ 출석·노쇼 기록 ${held}명)</small>${oc.rejected ? ` · 불합격 ${oc.rejected}명` : ''}</p>
    ${toggle}
  </section>`;
}
