// 홈의 "이번 달 시스템이 대신한 일" 카드: 이번 달 처리량과 절약 시간(추정)
// 절약 시간은 실측이 아니라 아래 가정값으로 계산한 추정이다. 화면에도 계산식을 그대로 보여 준다.
import { first } from './d1.js';
import { esc, icon } from './views.js';
import { stat } from './ui.js';

const KST = 9 * 3600000;

// 건당 사람이 직접 할 때 걸리는 시간(분) 가정. 보수적으로 잡았다.
export const ASSUMPTIONS = { send: 1, reply: 1, remind: 2 };

export function kstMonthStart(now = Date.now()) {
  const d = new Date(now + KST);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - KST;
}

export async function monthStats(db, depIds, now = Date.now()) {
  const empty = { sent: 0, replies: 0, reminders: 0, absentAfterRemind: 0 };
  if (!depIds.length) return empty;
  const ph = depIds.map(() => '?').join(',');
  const from = kstMonthStart(now);
  const row = await first(db,
    `SELECT
       COALESCE(SUM(ca.sent_at>=? AND ca.status IN ('sent','attending','absent','unclear')),0) sent,
       COALESCE(SUM(ca.replied_at>=? AND ca.status IN ('attending','absent') AND ca.manual=0),0) replies,
       COALESCE(SUM(ca.reminded_at>=?),0) reminders,
       COALESCE(SUM(ca.reminded_at>=? AND ca.status='absent' AND ca.replied_at>=ca.reminded_at),0) absentAfterRemind
     FROM candidates ca JOIN campaigns k ON k.id=ca.campaign_id
     WHERE k.department_id IN (${ph})`, from, from, from, from, ...depIds);
  return { sent: row.sent, replies: row.replies, reminders: row.reminders, absentAfterRemind: row.absentAfterRemind };
}

export function estimateMinutes(s, a = ASSUMPTIONS) {
  return Math.round(s.sent * a.send + s.replies * a.reply + s.reminders * a.remind);
}

export function fmtMinutes(min) {
  if (min < 60) return `약 ${min}분`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `약 ${h}시간 ${m}분` : `약 ${h}시간`;
}

export function renderSavingsCard(s, a = ASSUMPTIONS) {
  if (!s.sent && !s.replies && !s.reminders) return '';
  const minutes = estimateMinutes(s, a);
  return `<section class="section">
    <div class="shead"><h2>이번 달 시스템이 대신한 일</h2><span class="muted">추정치예요</span></div>
    <div class="card">
      <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap">
        <span style="font-size:34px;font-weight:800;letter-spacing:-.03em;color:var(--blue)">${esc(fmtMinutes(minutes))}</span>
        <span class="muted">직접 연락하고 정리했다면 걸렸을 시간</span>
      </div>
      <div class="stats" style="margin-top:14px">
        ${stat({ value: s.sent, label: '한 번에 보낸 안내' })}
        ${stat({ value: s.replies, label: '자동으로 분류한 답장' })}
        ${stat({ value: s.reminders, label: '자동 리마인드' })}
        ${stat({ value: s.absentAfterRemind, label: '리마인드 뒤 미리 알려 온 불참' })}
      </div>
      <details style="margin-top:12px"><summary class="muted" style="cursor:pointer">${icon('info', 14)} 어떻게 계산했나요?</summary>
        <p class="muted" style="margin-top:8px;font-size:14px">안내 ${s.sent}건 × ${a.send}분 + 답장 ${s.replies}건 × ${a.reply}분 + 리마인드 ${s.reminders}건 × ${a.remind}분 = <b>${minutes}분</b><br>
        건당 시간은 사람이 직접 하는 경우를 가정한 값이고, 실제와 다를 수 있어요. 실제 측정은 시범 운영 기록으로 확인해요.</p>
      </details>
    </div>
  </section>`;
}
