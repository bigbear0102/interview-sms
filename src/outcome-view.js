// 면접 안내 상세: 면접 결과 요약과 자동 리마인드 켜기/끄기
import { esc, icon } from './views.js';
import { stat } from './ui.js';

export function outcomeSection(camp, oc = {}) {
  const held = (oc.showed || 0) + (oc.noshow || 0);
  const rate = held ? Math.round(((oc.showed || 0) / held) * 100) + '%' : '-';
  const on = !!camp.auto_remind;
  const toggle = camp.purged_at ? '' : `<form method="post" action="/campaigns/${camp.id}/autoremind" class="tgl-row">
      <input type="hidden" name="on" value="${on ? 0 : 1}">
      <button class="tgl${on ? ' on' : ''}" role="switch" aria-checked="${on ? 'true' : 'false'}" aria-label="자동 리마인드 ${on ? '끄기' : '켜기'}"></button>
      <span><b>자동 리마인드</b> <span class="muted">면접 당일 오전 8시, 참석자에게 한 번 · <b>${on ? '켜짐' : '꺼짐'}</b>${on && oc.reminded ? ` · ${oc.reminded}명에게 보냄` : ''}</span></span>
    </form>`;
  const any = (oc.showed || 0) + (oc.noshow || 0) + (oc.passed || 0) + (oc.hired || 0) + (oc.rejected || 0);
  if (!any) {
    return `<section class="section"><div class="shead"><h2>면접 결과</h2></div>
      <p class="muted">아직 기록된 결과가 없어요. 아래 "사람별 현황"에서 출석·노쇼·합격·입사를 골라 기록하면 여기에 모여요.</p>
      ${toggle ? `<div style="margin-top:10px">${toggle}</div>` : ''}</section>`;
  }
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
