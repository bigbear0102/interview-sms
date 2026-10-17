// 면접 결과 기록과 자동 리마인드
// - 자동 리마인드: "참석"이라고 답한 사람에게 면접 당일 오전 8시(KST)에 한 번만 보낸다.
//   (그날 8시 이후에 참석 답장이 와도 면접 시각 전이면 바로 한 번 보낸다)
// - 전날 리마인드(선택): 면접 전날 오후 5시에 한 번. 답이 없으면 한 번 더(선택). 결과 안내 문자.
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

export const DEFAULT_REMIND_PREV_TEMPLATE = [
  '안녕하세요, {이름}님.',
  '내일 {면접일시} 면접이 예정되어 있어 미리 안내드립니다.',
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
//  - 당일(auto_remind): 면접 당일 08:00 ~ 면접 시각 전
//  - 전날(remind_prev): 면접 전날 17:00 ~ 자정 전 (당일 리마인드를 이미 보냈으면 보내지 않음)
//  보내는 시간은 08~21시(KST)로 제한한다. 각 리마인드는 한 사람에게 한 번만 간다.
export async function queueAutoReminders(db, now = Date.now(), { limit = 200 } = {}) {
  const hour = new Date(now + KST).getUTCHours();
  if (hour < 8 || hour >= 21) return 0;
  const rows = await all(db,
    `SELECT ca.id, ca.site, ca.name, ca.phone, ca.interview_at, ca.reminded_at, ca.reminded_prev_at,
            k.gateway_id, k.remind_template, k.auto_remind, k.remind_prev
       FROM candidates ca JOIN campaigns k ON k.id=ca.campaign_id
      WHERE ca.status='attending' AND ca.reminded_at IS NULL AND ca.interview_at!='' AND ca.phone!=''
        AND (k.auto_remind=1 OR (k.remind_prev=1 AND ca.reminded_prev_at IS NULL))
        AND k.purged_at IS NULL AND k.status!='cancelled'
      ORDER BY ca.id DESC LIMIT ?`, 1000);
  let queued = 0;
  for (const c of rows) {
    if (queued >= limit) break;
    const at = parseInterviewAt(c.interview_at, now);
    if (!Number.isFinite(at) || now >= at) continue;
    const dayStart = Math.floor((at + KST) / DAY) * DAY - KST; // 면접 당일 00:00
    let col, tpl;
    if (c.auto_remind && now >= dayStart + 8 * HOUR) {
      col = 'reminded_at'; tpl = c.remind_template || DEFAULT_REMIND_TEMPLATE;
    } else if (c.remind_prev && !c.reminded_prev_at && now >= dayStart - 7 * HOUR && now < dayStart) {
      col = 'reminded_prev_at'; tpl = DEFAULT_REMIND_PREV_TEMPLATE;
    } else continue;
    // 한 번만: 먼저 표시를 남기고 성공한 호출만 큐에 넣는다
    const claim = await run(db, `UPDATE candidates SET ${col}=? WHERE id=? AND ${col} IS NULL`, now, c.id);
    if (claim.meta.changes !== 1) continue;
    await db.batch([stmt(db,
      `INSERT INTO messages (gateway_id,phone,text,status,user_id,at,scheduled_at) VALUES (?,?,?,'scheduled',NULL,?,?)`,
      c.gateway_id, c.phone, renderTemplate(tpl, c), now, now)]);
    queued++;
  }
  return queued;
}

// 답이 없으면 한 번 더 보내기(auto_followup): 처음 보낸 지 24시간이 지나도 답이 없는 사람에게 같은 안내를 한 번 더 보낸다.
// 면접이 그보다 가까우면 면접 3시간 전(단, 보낸 지 최소 2시간 뒤)에 보낸다. 면접 1시간 전부터는 보내지 않는다.
// 09~20시(KST)에만 보내고, 한 사람에게 한 번만(followed_at). 반환: 다시 보낼 대기로 돌린 건수
export async function queueFollowups(db, now = Date.now(), { limit = 200 } = {}) {
  const hour = new Date(now + KST).getUTCHours();
  if (hour < 9 || hour >= 21) return 0;
  const rows = await all(db,
    `SELECT ca.id, ca.campaign_id, ca.interview_at, ca.sent_at
       FROM candidates ca JOIN campaigns k ON k.id=ca.campaign_id
      WHERE ca.status='sent' AND ca.followed_at IS NULL AND ca.sent_at IS NOT NULL AND ca.sent_at>? AND ca.sent_at<=?
        AND k.auto_followup=1 AND k.purged_at IS NULL AND k.status IN ('done','sending')
      ORDER BY ca.id LIMIT ?`, now - 7 * DAY, now - 2 * HOUR, 1000);
  const touched = new Set();
  let n = 0;
  for (const c of rows) {
    if (n >= limit) break;
    let due = c.sent_at + DAY;
    const at = parseInterviewAt(c.interview_at, now);
    if (Number.isFinite(at)) {
      if (now >= at - HOUR) continue;
      due = Math.max(c.sent_at + 2 * HOUR, Math.min(due, at - 3 * HOUR));
    }
    if (now < due) continue;
    const r = await run(db, `UPDATE candidates SET status='pending', followed_at=?, attempts=0, next_retry_at=NULL, error='' WHERE id=? AND status='sent' AND followed_at IS NULL`, now, c.id);
    if (r.meta.changes === 1) { n++; touched.add(c.campaign_id); }
  }
  for (const id of touched) await run(db, `UPDATE campaigns SET status='sending' WHERE id=? AND status='done'`, id);
  return n;
}

// 결과 안내 문자: 결과(합격/입사/불합격)를 기록한 사람 중 아직 안내하지 않은 사람에게 보낸다. 반환: 넣은 건수
export const RESULT_TEMPLATES = {
  passed: ['안녕하세요, {이름}님.', '면접에 합격하셨음을 알려 드립니다.', '근무 안내는 담당자가 곧 연락드리겠습니다.', '감사합니다.'].join('\n'),
  hired: ['안녕하세요, {이름}님.', '함께하게 되어 반갑습니다.', '첫 출근 안내는 담당자가 따로 연락드리겠습니다.', '감사합니다.'].join('\n'),
  rejected: ['안녕하세요, {이름}님.', '면접에 참석해 주셔서 감사합니다.', '아쉽게도 이번에는 함께하지 못하게 되었습니다.', '좋은 기회로 다시 뵙기를 바랍니다.'].join('\n')
};
export async function queueResultMessages(db, camp, outcome, template, userId = null, now = Date.now()) {
  if (!RESULT_TEMPLATES[outcome] || camp.purged_at) return 0;
  const tpl = String(template || '').trim() || RESULT_TEMPLATES[outcome];
  const rows = await all(db,
    `SELECT id, site, name, phone, interview_at FROM candidates WHERE campaign_id=? AND outcome=? AND result_sent_at IS NULL AND phone!='' LIMIT 400`,
    camp.id, outcome);
  const stmts = [];
  for (const c of rows) {
    stmts.push(stmt(db, `UPDATE candidates SET result_sent_at=? WHERE id=? AND result_sent_at IS NULL`, now, c.id));
    stmts.push(stmt(db, `INSERT INTO messages (gateway_id,phone,text,status,user_id,at,scheduled_at) VALUES (?,?,?,'scheduled',?,?,?)`,
      camp.gateway_id, c.phone, renderTemplate(tpl, c), userId, now, now));
  }
  for (let i = 0; i < stmts.length; i += 40) await db.batch(stmts.slice(i, i + 40));
  return rows.length;
}
