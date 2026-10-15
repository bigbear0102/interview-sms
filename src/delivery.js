// 발송 결과 추적: 자동 재시도 정책, 전달 결과(이벤트/조회) 반영, 새 답장 알림, 안 읽은 문자
import { all, first, run } from './d1.js';
import { getMessage, unlockGateway } from './gateway.js';
import { sendMail, mailConfigured } from './mailer.js';
import { rateLimit } from './accounts.js';

export const MAX_ATTEMPTS = 3;                    // 처음 시도 포함 총 3번
const BACKOFF_MIN = [2, 10, 30];                  // 실패 후 다시 시도까지 기다리는 분

// 다시 시도해도 소용없는 오류(잘못된 번호, 인증/요청 오류)는 바로 실패 처리한다.
export function isRetryable(message) {
  const m = String(message || '');
  if (/\b(400|401|403|404|422)\b/.test(m)) return false;
  if (/invalid phone|invalid number|잘못된 번호|형식이 아니에요/i.test(m)) return false;
  return true;
}

// attemptsAfter: 이번 실패를 포함한 시도 횟수
export function planRetry(attemptsAfter, message, now = Date.now()) {
  if (attemptsAfter >= MAX_ATTEMPTS || !isRetryable(message)) return { retry: false };
  return { retry: true, at: now + BACKOFF_MIN[Math.min(attemptsAfter - 1, BACKOFF_MIN.length - 1)] * 60000 };
}

export const retryNote = (attemptsAfter, reason) => `다시 시도해요 (${attemptsAfter}/${MAX_ATTEMPTS}): ${String(reason).slice(0, 200)}`;

// ---- 전달 이벤트(웹훅 sms:sent / sms:delivered / sms:failed) 또는 조회 결과 반영 ----
// event: 'queued' | 'sent' | 'delivered' | 'failed'
export async function applyDeliveryEvent(db, { gwMsgId, event, reason = '', now = Date.now() }) {
  if (!gwMsgId) return { matched: false };
  const cand = await first(db, `SELECT * FROM candidates WHERE gw_msg_id=?`, String(gwMsgId));
  if (cand) {
    if (event === 'delivered') {
      await run(db, `UPDATE candidates SET delivery='delivered', delivered_at=? WHERE id=?`, now, cand.id);
    } else if (event === 'sent') {
      await run(db, `UPDATE candidates SET delivery='sent' WHERE id=? AND delivery IN ('','queued')`, cand.id);
    } else if (event === 'failed') {
      if (cand.status === 'sent' && cand.delivery !== 'delivered') {
        const attempts = cand.attempts + 1;
        const plan = planRetry(attempts, reason, now);
        if (plan.retry) {
          await run(db, `UPDATE candidates SET status='pending', attempts=?, next_retry_at=?, delivery='failed', error=? WHERE id=?`,
            attempts, plan.at, retryNote(attempts, reason || '전달에 실패했어요'), cand.id);
          await run(db, `UPDATE campaigns SET status='sending' WHERE id=? AND status='done'`, cand.campaign_id);
        } else {
          await run(db, `UPDATE candidates SET status='failed', attempts=?, delivery='failed', error=? WHERE id=?`,
            attempts, String(reason || '전달에 실패했어요').slice(0, 300), cand.id);
        }
      } else {
        await run(db, `UPDATE candidates SET delivery='failed' WHERE id=? AND delivery!='delivered'`, cand.id);
      }
    }
    return { matched: true, kind: 'candidate', id: cand.id };
  }

  const msg = await first(db, `SELECT * FROM messages WHERE gw_msg_id=?`, String(gwMsgId));
  if (msg) {
    if (event === 'delivered') {
      await run(db, `UPDATE messages SET delivery='delivered', delivered_at=? WHERE id=?`, now, msg.id);
    } else if (event === 'sent') {
      await run(db, `UPDATE messages SET delivery='sent' WHERE id=? AND delivery IN ('','queued')`, msg.id);
    } else if (event === 'failed' && msg.status === 'sent' && msg.delivery !== 'delivered') {
      const attempts = msg.attempts + 1;
      const plan = planRetry(attempts, reason, now);
      if (plan.retry) {
        await run(db, `UPDATE messages SET status='scheduled', scheduled_at=?, attempts=?, delivery='failed', error=? WHERE id=?`,
          plan.at, attempts, retryNote(attempts, reason || '전달에 실패했어요'), msg.id);
      } else {
        await run(db, `UPDATE messages SET status='failed', attempts=?, delivery='failed', error=?, at=? WHERE id=?`,
          attempts, String(reason || '전달에 실패했어요').slice(0, 300), now, msg.id);
      }
    }
    return { matched: true, kind: 'message', id: msg.id };
  }
  return { matched: false };
}

// 웹훅이 오지 않은 건을 직접 조회해서 보완한다. (한 번에 limit 건)
export async function pollDelivery(env, { now = Date.now(), limit = 10, fetchMessage = getMessage } = {}) {
  const db = env.DB;
  const from = now - 24 * 3600000, to = now - 3 * 60000;
  const rows = [
    ...(await all(db,
      `SELECT 'c' kind, ca.id, ca.gw_msg_id, k.gateway_id FROM candidates ca JOIN campaigns k ON k.id=ca.campaign_id
       WHERE ca.gw_msg_id != '' AND ca.delivery IN ('queued','sent') AND ca.status='sent' AND ca.sent_at BETWEEN ? AND ?
       ORDER BY ca.sent_at LIMIT ?`, from, to, limit)),
    ...(await all(db,
      `SELECT 'm' kind, id, gw_msg_id, gateway_id FROM messages
       WHERE gw_msg_id != '' AND delivery IN ('queued','sent') AND status='sent' AND at BETWEEN ? AND ?
       ORDER BY at LIMIT ?`, from, to, limit))
  ].slice(0, limit);

  const gws = new Map();
  let checked = 0;
  for (const r of rows) {
    try {
      if (!gws.has(r.gateway_id)) {
        const g = await first(db, `SELECT * FROM gateways WHERE id=?`, r.gateway_id);
        gws.set(r.gateway_id, g ? await unlockGateway(env, g) : null);
      }
      const gw = gws.get(r.gateway_id);
      if (!gw) continue;
      const info = await fetchMessage(gw, r.gw_msg_id);
      const state = String(info?.state || '').toLowerCase();
      const ev = state === 'delivered' ? 'delivered' : state === 'failed' ? 'failed' : state === 'sent' ? 'sent' : '';
      if (ev) {
        const reason = (info.recipients || []).map((x) => x.error).filter(Boolean)[0] || '';
        await applyDeliveryEvent(db, { gwMsgId: r.gw_msg_id, event: ev, reason, now });
      }
      checked++;
    } catch (e) {
      // 조회 실패는 다음 주기에 다시 시도한다
    }
  }
  return checked;
}

// ---- 새 답장 알림 ----
export async function notifyNewReply(env, gatewayId) {
  if (!mailConfigured(env)) return 0;
  const db = env.DB;
  const gw = await first(db, `SELECT g.name, g.department_id FROM gateways g WHERE g.id=?`, gatewayId);
  if (!gw) return 0;
  const users = await all(db,
    `SELECT DISTINCT u.id, u.email FROM users u
       LEFT JOIN user_departments ud ON ud.user_id=u.id
      WHERE u.notify_replies=1 AND u.active=1 AND u.email IS NOT NULL AND u.email_verified_at IS NOT NULL
        AND (u.role='super' OR ud.department_id=?)`, gw.department_id);
  let n = 0;
  for (const u of users) {
    // 같은 사람에게는 5분에 한 번만 (그 사이 온 답장은 화면의 안 읽은 표시로 확인)
    if (!(await rateLimit(db, `notify:${u.id}`, 1, 5 * 60000))) continue;
    const link = `${env.PUBLIC_BASE_URL || ''}/messages?dir=in`;
    const r = await sendMail(env, {
      to: u.email,
      subject: '[문자 관리] 새 답장이 도착했어요',
      text: `"${gw.name}" 폰으로 새 답장이 왔어요.\n\n확인하기: ${link}\n\n(개인정보 보호를 위해 메일에는 내용을 넣지 않아요. 알림이 필요 없으면 내 계정에서 끌 수 있어요.)`,
      html: `<p>"${gw.name.replace(/[<>&]/g, '')}" 폰으로 새 답장이 왔어요.</p><p><a href="${link}" style="display:inline-block;background:#0066cc;color:#fff;padding:12px 24px;border-radius:999px;text-decoration:none">확인하기</a></p><p style="color:#6e6e73;font-size:13px">개인정보 보호를 위해 메일에는 내용을 넣지 않아요. 알림이 필요 없으면 내 계정에서 끌 수 있어요.</p>`
    });
    if (r.ok) n++;
  }
  return n;
}

// ---- 안 읽은 받은 문자 ----
const scope = (user) => user.role === 'super'
  ? { sql: '', args: [] }
  : { sql: ` AND gateway_id IN (SELECT id FROM gateways WHERE department_id IN (${user.departments.map(() => '?').join(',') || 'NULL'}))`, args: user.departments };

export async function unreadCount(db, user) {
  if (user.role !== 'super' && !user.departments.length) return 0;
  const s = scope(user);
  return (await first(db, `SELECT COUNT(*) n FROM inbound WHERE read_at IS NULL${s.sql}`, ...s.args)).n;
}

export async function markAllRead(db, user) {
  if (user.role !== 'super' && !user.departments.length) return;
  const s = scope(user);
  await run(db, `UPDATE inbound SET read_at=? WHERE read_at IS NULL${s.sql}`, Date.now(), ...s.args);
}
