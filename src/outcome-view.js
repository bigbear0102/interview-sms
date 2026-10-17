// 면접 안내 상세: 자동으로 보내는 문자(전날·당일 리마인드, 답 없으면 한 번 더) 켜기/끄기,
// 면접 결과 요약, 결과 안내 문자 보내기
import { esc, icon } from './views.js';
import { stat } from './ui.js';

const toggleRow = (camp, action, on, title, desc) => `<form method="post" action="/campaigns/${camp.id}/${action}" class="tgl-row">
      <input type="hidden" name="on" value="${on ? 0 : 1}">
      <button class="tgl${on ? ' on' : ''}" role="switch" aria-checked="${on ? 'true' : 'false'}" aria-label="${esc(title)} ${on ? '끄기' : '켜기'}"></button>
      <span><b>${esc(title)}</b> <span class="muted">${desc} · <b>${on ? '켜짐' : '꺼짐'}</b></span></span>
    </form>`;

const RESULT_LABEL = { passed: '합격', hired: '입사', rejected: '불합격' };

export function outcomeSection(camp, oc = {}, resultTemplates = {}) {
  const held = (oc.showed || 0) + (oc.noshow || 0);
  const rate = held ? Math.round(((oc.showed || 0) / held) * 100) + '%' : '-';
  const live = !camp.purged_at && camp.status !== 'cancelled';
  const autos = live ? `<div class="card" style="margin-top:16px">
      <h3 style="margin-bottom:4px">자동으로 보내는 문자</h3>
      <p class="muted" style="font-size:14px">면접일시를 "10/20 14:00"처럼 적은 사람에게만 시각을 맞춰 보내요. 밤에는 보내지 않아요.</p>
      ${toggleRow(camp, 'remindprev', !!camp.remind_prev, '전날 알림', `면접 전날 오후 5시, 참석자에게 한 번${oc.reminded_prev ? ` · ${oc.reminded_prev}명에게 보냄` : ''}`)}
      ${toggleRow(camp, 'autoremind', !!camp.auto_remind, '당일 알림', `면접 당일 오전 8시, 참석자에게 한 번${oc.reminded ? ` · ${oc.reminded}명에게 보냄` : ''}`)}
      ${toggleRow(camp, 'followup', !!camp.auto_followup, '답 없으면 한 번 더', `하루 뒤(면접이 가까우면 3시간 전) 같은 안내를 한 번 더${oc.followed ? ` · ${oc.followed}명에게 보냄` : ''}`)}
    </div>` : '';

  // 결과 안내 문자: 결과를 기록했고 아직 안내하지 않은 사람이 있을 때만
  const todo = Object.keys(RESULT_LABEL).filter((k) => oc[`todo_${k}`] > 0);
  const resultCard = live && todo.length ? `<div class="card" style="margin-top:16px">
      <h3 style="margin-bottom:4px">결과 안내 문자</h3>
      <p class="muted" style="font-size:14px;margin-bottom:12px">결과를 기록한 사람 중 아직 안내하지 않은 사람에게 보내요. 한 사람에게 결과마다 한 번만 가요.</p>
      ${todo.map((k) => `<details style="margin-top:8px"><summary><b>${RESULT_LABEL[k]} ${oc[`todo_${k}`]}명</b>에게 보내기</summary>
        <form method="post" action="/campaigns/${camp.id}/result" class="stack" style="margin-top:8px" data-confirm="${RESULT_LABEL[k]} ${oc[`todo_${k}`]}명에게 결과 안내 문자를 보낼까요?">
          <input type="hidden" name="outcome" value="${k}">
          <textarea name="template" rows="5" aria-label="${RESULT_LABEL[k]} 안내 문구">${esc(resultTemplates[k] || '')}</textarea>
          <div><button class="btn">${icon('send', 18)}${RESULT_LABEL[k]} ${oc[`todo_${k}`]}명에게 보내기</button></div>
        </form></details>`).join('')}
    </div>` : '';

  const any = (oc.showed || 0) + (oc.noshow || 0) + (oc.passed || 0) + (oc.hired || 0) + (oc.rejected || 0);
  if (!any) {
    return `<section class="section"><div class="shead"><h2>면접 결과</h2></div>
      <p class="muted">아직 기록된 결과가 없어요. 아래 "사람별 현황"에서 출석·노쇼·합격·입사를 골라 기록하면 여기에 모여요.</p>
      ${autos}</section>`;
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
    ${resultCard}
    ${autos}
  </section>`;
}
