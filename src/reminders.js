// 면접 결과 기록과 자동 리마인드
// - 자동 리마인드: "참석"이라고 답한 사람에게 면접 당일 오전 8시(KST)에 한 번만 보낸다.
//   (그날 8시 이후에 참석 답장이 와도 면접 시각 전이면 바로 한 번 보낸다)
import { all, run, stmt } from './d1.js';
import { renderTemplate } from './core.js';

const KST = 9 * 3600000;
const HOUR = 3600000;
const DAY = 24 * HOUR;

export const OUTCOMES = { showed: '출석', noshow: '노쇼', passed: '합격', hired: '입사', rejected: '불합격' };

export const DEFAULT_REMIND_TEMPLATE = [
  '안녕하세요, {이름}님.',
  '오늘 {면접일시} 면접이 예정되어 있어 다시 안내드립니다.',
  '',
  '참석이 어려워지셨다면 "불참"이라고 답장해 주세요.',
  '감사합니다.'
].join('\n');

export async function setOutcome(db, candidateId, outcome) {
  if (outcome !== '' && !OUTCOMES[outcome]) throw new Error('invalid outcome');
  await run(db, `UPDATE candidates SET outcome=?, outcome_at=? WHERE id=?`, outcome, outcome ? Date.now() : null, candidateId);
}

// 면접일시 글자("10/20 14:00", "2026-10-20 14:00", "10월 20일 오후 2시 30분")를 시각(ms)으로 바꾼다. 못 읽으면 NaN.
export function parseInterviewAt(text, now = Date.now()) {
  const s = String(text || '').trim();
  const d = s.match(/(?:(\d{4})\s*[\/\-.년]\s*)?(\d{1,2})\s*[\/\-.월]\s*(\d{1,2})/);
  if (!d) return NaN;
  const rest = s.slice(d.index + d[0].length);
  const t = rest.match(/(오전|오후|AM|PM|am|pm)?\s*(\d{1,2})\s*(?::|시)\s*(\d{1,2})?/);
  if (!t) return NaN;
  let hour = Number(t[2]);
  const min = t[3] ? Number(t[3]) : 0;
  const ap = (t[1] || '').toLowerCase();
  if ((ap === '오후' || ap === 'pm') && hour < 12) hour += 12;
  if ((ap === '오전' || ap === 'am') && hour === 12) hour = 0;
  const month = Number(d[2]), day = Number(d[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || min > 59) return NaN;
  const nowKst = new Date(now + KST);
  let year = d[1] ? Number(d[1]) : nowKst.getUTCFullYear();
  let at = Date.UTC(year, month - 1, day, hour, min) - KST;
  if (!d[1] && at < now - 60 * DAY) at = Date.UTC(year + 1, month - 1, day, hour, min) - KST; // 연도가 없고 한참 지났으면 내년
  return at;
}

// 지금 보낼 때가 된 리마인드를 문자 큐(messages)에 넣는다. 반환: 넣은 건수
export async function queueAutoReminders(db, now = Date.now(), { limit = 200 } = {}) {
  const hour = new Date(now + KST).getUTCHours();
  if (hour < 8 || hour >= 21) return 0;
  const rows = await all(db,
    `SELECT ca.id, ca.site, ca.name, ca.phone, ca.interview_at, k.gateway_id, k.remind_template
       FROM candidates ca JOIN campaigns k ON k.id=ca.campaign_id
      WHERE ca.status='attending' AND ca.reminded_at IS NULL AND ca.interview_at!='' AND ca.phone!=''
        AND k.auto_remind=1 AND k.purged_at IS NULL AND k.status!='cancelled'
      ORDER BY ca.id DESC LIMIT ?`, 1000);
  let queued = 0;
  for (const c of rows) {
    if (queued >= limit) break;
    const at = parseInterviewAt(c.interview_at, now);
    if (!Number.isFinite(at)) continue;
    const sendFrom = Math.floor((at + KST) / DAY) * DAY - KST + 8 * HOUR; // 면접 당일 08:00
    if (now < sendFrom || now >= at) continue;
    // 한 번만: 먼저 표시를 남기고 성공한 호출만 큐에 넣는다
    const claim = await run(db, `UPDATE candidates SET reminded_at=? WHERE id=? AND reminded_at IS NULL`, now, c.id);
    if (claim.meta.changes !== 1) continue;
    const text = renderTemplate(c.remind_template || DEFAULT_REMIND_TEMPLATE, c);
    await db.batch([stmt(db,
      `INSERT INTO messages (gateway_id,phone,text,status,user_id,at,scheduled_at) VALUES (?,?,?,'scheduled',NULL,?,?)`,
      c.gateway_id, c.phone, text, now, now)]);
    queued++;
  }
  return queued;
}
