// 업무 로직: 캠페인 생성, 발송 큐, 수신 답장 처리, 보관기간 파기 (Cloudflare D1)
import { parseReply, parseSlotReply, isRescheduleRequest, normalizePhone, isValidMobile } from './parser.js';
import { sendSms, unlockGateway } from './gateway.js';
import { planRetry, retryNote } from './delivery.js';
import { all, first, run, stmt } from './d1.js';

// 면접 안내 기본 문구. 사업장 이름은 넣지 않는다. (줄바꿈은 그대로 문자에 반영된다)
export const DEFAULT_TEMPLATE = [
  '안녕하세요, {이름}님.',
  '면접 일정을 안내드립니다.',
  '',
  '일시: {면접일시}',
  '',
  '참석 가능하시면 "참석", 어려우시면 "불참"이라고 답장해 주세요.',
  '감사합니다.'
].join('\n');

// 문자 본문 정리: 줄바꿈 통일, 줄 끝 공백 제거, 연속 공백 1칸, 빈 줄은 최대 1줄, 앞뒤 공백 제거
export function cleanMessage(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t\u3000]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 일정 고르기 문구. {일정목록} 자리에 "1) 10/21(화) 14:00" 줄이 들어간다.
export const SLOT_TEMPLATE = [
  '안녕하세요, {이름}님.',
  '지원해 주셔서 감사합니다. 면접 일정을 골라 주세요.',
  '',
  '{일정목록}',
  '',
  '원하시는 번호를 답장해 주세요. (예: 1)',
  '모두 어려우시면 "불참"이라고 답장해 주세요.'
].join('\n');

// 일정을 고른 사람에게 바로 보내는 확정 문자
export const SLOT_CONFIRM_TEMPLATE = [
  '{이름}님, 면접 일정이 {면접일시}(으)로 정해졌어요.',
  '참석이 어려워지시면 "불참"이라고 답장해 주세요.'
].join('\n');

// 일정 변경 요청에 새 일정으로 다시 안내할 때 쓰는 문구
export const RESCHEDULE_TEMPLATE = [
  '안녕하세요, {이름}님.',
  '요청하신 대로 면접 일정을 다시 안내드립니다.',
  '',
  '일시: {면접일시}',
  '',
  '참석 가능하시면 "참석", 어려우시면 "불참"이라고 답장해 주세요.',
  '감사합니다.'
].join('\n');

export const slotsOf = (camp) => String(camp?.slots || '').split('\n').map((x) => x.trim()).filter(Boolean);
export const slotList = (slots) => slots.map((x, i) => `${i + 1}) ${x}`).join('\n');

export function renderTemplate(tpl, c, slots = []) {
  return cleanMessage(String(tpl ?? '')
    .replaceAll('{일정목록}', slotList(slots))
    .replaceAll('{사업장}', c.site || '')
    .replaceAll('{이름}', c.name || '지원자')
    .replaceAll('{면접일시}', c.interview_at || '추후 안내'));
}

// candidates: [{site,name,phone,interview_at}]
export async function createCampaign(db, { departmentId, gatewayId, name, template, retentionDays, userId, candidates, defaultSite = '', autoRemind = false, remindPrev = false, autoFollowup = false, slots = [] }) {
  const seen = new Set();
  const rejected = [];
  const accepted = [];
  const slotText = (slots || []).map((x) => String(x).trim()).filter(Boolean).slice(0, 9).join('\n');
  candidates.forEach((c, i) => {
    const phone = normalizePhone(c.phone);
    const site = (c.site || '').trim() || String(defaultSite || '').trim();
    if (!site) return rejected.push({ row: i + 2, reason: '사업장 없음' });
    if (!isValidMobile(phone)) return rejected.push({ row: i + 2, reason: `휴대폰 번호 오류(${c.phone})` });
    const key = `${site}|${phone}`;
    if (seen.has(key)) return rejected.push({ row: i + 2, reason: '중복' });
    seen.add(key);
    accepted.push({ ...c, site, phone });
  });
  const ins = await run(db,
    `INSERT INTO campaigns (department_id, gateway_id, name, template, retention_days, created_by, created_at, auto_remind, remind_prev, auto_followup, slots)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    departmentId, gatewayId, name, String(template || '').replace(/\r\n?/g, '\n').trim() || (slotText ? SLOT_TEMPLATE : DEFAULT_TEMPLATE), retentionDays || 90, userId ?? null, Date.now(),
    autoRemind ? 1 : 0, remindPrev ? 1 : 0, autoFollowup ? 1 : 0, slotText);
  const campaignId = Number(ins.meta.last_row_id);

  // D1 은 쿼리당 바인딩 100개 제한 → 행 19개(5컬럼)씩 묶어 한 번의 batch 로 실행
  const ROWS = 19;
  const stmts = [];
  for (let i = 0; i < accepted.length; i += ROWS) {
    const chunk = accepted.slice(i, i + ROWS);
    const sql = `INSERT INTO candidates (campaign_id, site, name, phone, interview_at) VALUES ${chunk.map(() => '(?,?,?,?,?)').join(',')}`;
    stmts.push(stmt(db, sql, ...chunk.flatMap((c) => [campaignId, c.site, c.name || '', c.phone, slotText ? '' : (c.interview_at || '')])));
  }
  for (let i = 0; i < stmts.length; i += 40) await db.batch(stmts.slice(i, i + 40));
  return { campaignId, accepted: accepted.length, rejected };
}

export const scheduleCampaign = (db, campaignId, at) =>
  run(db, `UPDATE campaigns SET scheduled_at=?, status='scheduled' WHERE id=? AND status IN ('draft','scheduled')`, at, campaignId);

// 예약을 취소하고 '아직 안 보냄' 상태로 되돌린다
export const unscheduleCampaign = (db, campaignId) =>
  run(db, `UPDATE campaigns SET scheduled_at=NULL, status='draft' WHERE id=? AND status='scheduled'`, campaignId);

export const cancelCampaign = (db, campaignId) =>
  run(db, `UPDATE campaigns SET status='cancelled' WHERE id=? AND status IN ('draft','scheduled','sending')`, campaignId);

// 미응답(sent)·실패(failed) 지원자를 다시 발송 대기로 되돌린다 (리마인드)
export async function remindCampaign(db, campaignId, { includeFailed = true } = {}) {
  const statuses = includeFailed ? `('sent','failed')` : `('sent')`;
  const r = await run(db, `UPDATE candidates SET status='pending', error='' WHERE campaign_id=? AND status IN ${statuses}`, campaignId);
  if (r.meta.changes > 0) await run(db, `UPDATE campaigns SET status='scheduled', scheduled_at=? WHERE id=?`, Date.now(), campaignId);
  return r.meta.changes;
}

// 예약 시각이 된 캠페인을 발송한다. Workers 의 서브리퀘스트 한도 때문에 호출 1회당 batchSize 건만 처리하고,
// 나머지는 다음 Cron(매 분) 호출이 이어받는다.
export async function processQueue(env, { batchSize = Number(env.SEND_BATCH || 25), send = sendSms, log = console } = {}) {
  const db = env.DB;
  const now = Date.now();
  // 선점 후 5분 넘게 sending 으로 남은 건(중단된 호출)은 다시 대기로 되돌린다
  await run(db, `UPDATE candidates SET status='pending' WHERE status='sending' AND sent_at<?`, now - 300000);
  await run(db, `UPDATE campaigns SET status='sending' WHERE status='scheduled' AND scheduled_at<=?`, now);
  const campaigns = await all(db, `SELECT * FROM campaigns WHERE status='sending' ORDER BY id`);
  let budget = batchSize;
  let sentCount = 0;

  for (const camp of campaigns) {
    if (budget <= 0) break;
    const claimTs = Date.now();
    await run(db,
      `UPDATE candidates SET status='sending', sent_at=? WHERE id IN
         (SELECT id FROM candidates WHERE campaign_id=? AND status='pending' AND (next_retry_at IS NULL OR next_retry_at<=?) ORDER BY id LIMIT ?)`,
      claimTs, camp.id, claimTs, budget);
    const claimed = await all(db,
      `SELECT * FROM candidates WHERE campaign_id=? AND status='sending' AND sent_at=? ORDER BY id`, camp.id, claimTs);
    if (claimed.length) {
      const gwRow = await first(db, `SELECT * FROM gateways WHERE id=?`, camp.gateway_id);
      const gw = await unlockGateway(env, gwRow);
      const updates = [];
      for (const c of claimed) {
        const text = renderTemplate(c.template_override || camp.template, c, slotsOf(camp));
        try {
          const resp = await send(gw, c.phone, text);
          updates.push(stmt(db,
            `UPDATE candidates SET status='sent', sent_at=?, message_text=?, error='', gw_msg_id=?, delivery='queued', next_retry_at=NULL WHERE id=?`,
            Date.now(), text, String(resp?.id || ''), c.id));
        } catch (e) {
          const attempts = (c.attempts || 0) + 1;
          const plan = planRetry(attempts, e.message);
          if (plan.retry) {
            updates.push(stmt(db, `UPDATE candidates SET status='pending', attempts=?, next_retry_at=?, error=? WHERE id=?`,
              attempts, plan.at, retryNote(attempts, e.message), c.id));
          } else {
            updates.push(stmt(db, `UPDATE candidates SET status='failed', attempts=?, error=? WHERE id=?`,
              attempts, String(e.message).slice(0, 300), c.id));
          }
          log.error?.(`발송 실패 candidate=${c.id}: ${e.message}`);
        }
        sentCount++;
      }
      budget -= claimed.length;
      await db.batch(updates);
    }
    const left = (await first(db,
      `SELECT COUNT(*) n FROM candidates WHERE campaign_id=? AND status IN ('pending','sending')`, camp.id)).n;
    if (left === 0) await run(db, `UPDATE campaigns SET status='done' WHERE id=? AND status='sending'`, camp.id);
  }
  // ---- 직접 보내는 문자(문자 보내기 화면): 예약/대기 건을 이어서 처리한다 ----
  if (budget > 0) {
    await run(db, `UPDATE messages SET status='scheduled' WHERE status='sending' AND at<?`, Date.now() - 300000);
    const due = await all(db,
      `SELECT * FROM messages WHERE status='scheduled' AND scheduled_at<=? ORDER BY scheduled_at, id LIMIT ?`, Date.now(), budget);
    const gwCache = new Map();
    for (const m of due) {
      // 선점: 다른 호출이 먼저 가져갔으면 건너뛴다
      const claim = await run(db, `UPDATE messages SET status='sending', at=? WHERE id=? AND status='scheduled'`, Date.now(), m.id);
      if (claim.meta.changes !== 1) continue;
      try {
        if (!gwCache.has(m.gateway_id)) {
          const row = await first(db, `SELECT * FROM gateways WHERE id=?`, m.gateway_id);
          gwCache.set(m.gateway_id, row ? await unlockGateway(env, row) : null);
        }
        const gw = gwCache.get(m.gateway_id);
        if (!gw) throw new Error('폰 정보를 찾을 수 없어요.');
        const resp = await send(gw, m.phone, m.text);
        await run(db, `UPDATE messages SET status='sent', at=?, error='', gw_msg_id=?, delivery='queued' WHERE id=?`, Date.now(), String(resp?.id || ''), m.id);
      } catch (e) {
        const attempts = (m.attempts || 0) + 1;
        const plan = planRetry(attempts, e.message);
        if (plan.retry) {
          await run(db, `UPDATE messages SET status='scheduled', scheduled_at=?, attempts=?, error=? WHERE id=?`,
            plan.at, attempts, retryNote(attempts, e.message), m.id);
        } else {
          await run(db, `UPDATE messages SET status='failed', at=?, attempts=?, error=? WHERE id=?`, Date.now(), attempts, String(e.message).slice(0, 300), m.id);
        }
        log.error?.(`직접 발송 실패 message=${m.id}: ${e.message}`);
      }
      sentCount++;
    }
  }
  return sentCount;
}

// 수신 문자 처리. 같은 폰(게이트웨이)이 보낸 가장 최근 안내 건에 매칭한다.
export async function handleInbound(db, gatewayId, { sender, message }) {
  const phone = normalizePhone(sender);
  const now = Date.now();
  // 되돌아온 문자: 우리가 30분 안에 이 번호로 보낸 문자와 내용이 같으면 답장이 아니다.
  // (문자 보내는 폰 자기 번호로 보냈을 때 그 문자가 그대로 수신된다. 안내 문구 속 "불참"으로 잘못 집계되지 않게)
  const body = cleanMessage(message);
  if (body) {
    const echo = await first(db,
      `SELECT 1 FROM candidates c JOIN campaigns k ON k.id=c.campaign_id
        WHERE k.gateway_id=? AND c.phone=? AND c.message_text=? AND c.sent_at>?
       UNION ALL
       SELECT 1 FROM messages WHERE gateway_id=? AND phone=? AND text=? AND at>? LIMIT 1`,
      gatewayId, phone, body, now - 30 * 60000, gatewayId, phone, body, now - 30 * 60000);
    if (echo) {
      await run(db, `INSERT INTO inbound (gateway_id,sender,message,received_at,result) VALUES (?,?,?,?,?)`,
        gatewayId, phone, message, now, 'echo');
      return { matched: false, echo: true };
    }
  }
  const cand = await first(db,
    `SELECT c.*, k.slots camp_slots, k.gateway_id camp_gateway FROM candidates c JOIN campaigns k ON k.id=c.campaign_id
     WHERE k.gateway_id=? AND c.phone=? AND c.status IN ('sent','attending','absent','unclear') AND k.purged_at IS NULL
     ORDER BY c.sent_at DESC LIMIT 1`, gatewayId, phone);
  if (!cand) {
    await run(db, `INSERT INTO inbound (gateway_id,sender,message,received_at,result) VALUES (?,?,?,?,?)`,
      gatewayId, phone, message, now, 'unmatched');
    return { matched: false };
  }
  // 일정 고르기 안내(이 사람에게 따로 다시 안내한 경우 제외)는 번호로 일정을 정한다
  const slots = cand.template_override ? [] : slotsOf({ slots: cand.camp_slots });
  let result, slotText = '';
  if (slots.length) {
    const r = parseSlotReply(message, slots.length);
    result = r.result;
    if (r.slot) slotText = slots[r.slot - 1];
    else if (r.positive && cand.interview_at && cand.status === 'attending') result = 'attending'; // 이미 고른 사람의 "네"
  } else {
    result = parseReply(message);
  }
  const kind = isRescheduleRequest(message) ? 'reschedule' : '';
  // 일정 변경 요청은 불참이 아니라 담당자가 확인할 일이다("죄송한데 다음 주로 미룰 수 있을까요?")
  if (kind && result === 'absent' && !slotText) result = 'unclear';
  if (cand.manual && (result === 'absent' || kind) && cand.status !== 'absent') {
    // 담당자가 직접 정한 건이라도 취소("못 가요")·일정 변경 요청이 오면 놓치지 않게 "확인 필요"로 올린다(리마인드도 멈춤)
    await run(db, `UPDATE candidates SET status='unclear', manual=0, reply_text=?, replied_at=?, reply_kind=? WHERE id=?`, message, now, kind, cand.id);
    result = 'unclear';
  } else if (cand.manual) {
    // 관리자가 이미 확정한 건은 원문만 기록
    await run(db, `UPDATE candidates SET reply_text=?, replied_at=?, reply_kind=? WHERE id=?`, message, now, kind, cand.id);
  } else if (slotText) {
    const changed = slotText !== cand.interview_at;
    await run(db,
      `UPDATE candidates SET status='attending', interview_at=?, reply_text=?, replied_at=?, reply_kind=?${changed ? ', reminded_at=NULL, reminded_prev_at=NULL' : ''} WHERE id=?`,
      slotText, message, now, kind, cand.id);
    // 고른 일정을 바로 확정 안내한다(문자 큐). 같은 일정을 다시 보내 온 경우는 보내지 않는다.
    if (changed) {
      await run(db, `INSERT INTO messages (gateway_id,phone,text,status,user_id,at,scheduled_at) VALUES (?,?,?,'scheduled',NULL,?,?)`,
        cand.camp_gateway, cand.phone, renderTemplate(SLOT_CONFIRM_TEMPLATE, { ...cand, interview_at: slotText }), now, now);
    }
  } else {
    await run(db, `UPDATE candidates SET status=?, reply_text=?, replied_at=?, reply_kind=? WHERE id=?`, result, message, now, kind, cand.id);
  }
  await run(db, `INSERT INTO inbound (gateway_id,sender,message,received_at,candidate_id,result) VALUES (?,?,?,?,?,?)`,
    gatewayId, phone, message, now, cand.id, result);
  return { matched: true, candidateId: cand.id, result, slot: slotText, kind };
}

export async function setManualStatus(db, candidateId, status) {
  if (!['attending', 'absent', 'unclear', 'sent'].includes(status)) throw new Error('invalid status');
  await run(db, `UPDATE candidates SET status=?, manual=1 WHERE id=?`, status, candidateId);
}

// 일정 고르기: 담당자가 직접 일정을 정한다(전화로 정한 경우 등). 확정 문자는 보내지 않는다.
export async function setSlotManual(db, candidateId, slotText) {
  await run(db, `UPDATE candidates SET status='attending', interview_at=?, manual=1, reminded_at=NULL, reminded_prev_at=NULL WHERE id=?`,
    String(slotText || '').trim().slice(0, 60), candidateId);
}

// 일정 변경 요청 → 새 일정으로 이 사람에게만 다시 안내한다. 아직 안 보낸 안내면 일시만 바꾼다.
// 반환: 'queued' | 'updated' | 'invalid'
export async function rescheduleCandidate(db, camp, candidateId, when, now = Date.now()) {
  const at = String(when || '').trim().slice(0, 60);
  if (!at || camp.status === 'cancelled' || camp.purged_at) return 'invalid';
  if (camp.status === 'draft' || camp.status === 'scheduled') {
    await run(db, `UPDATE candidates SET interview_at=? WHERE id=? AND campaign_id=?`, at, candidateId, camp.id);
    return 'updated';
  }
  const r = await run(db,
    `UPDATE candidates SET interview_at=?, status='pending', manual=0, reply_kind='', reminded_at=NULL, reminded_prev_at=NULL, followed_at=NULL,
       template_override=?, attempts=0, next_retry_at=NULL, error='' WHERE id=? AND campaign_id=? AND status NOT IN ('pending','sending')`,
    at, RESCHEDULE_TEMPLATE, candidateId, camp.id);
  if (!r.meta.changes) return 'invalid';
  await run(db, `UPDATE campaigns SET status='sending' WHERE id=? AND status='done'`, camp.id);
  return 'queued';
}

// 보관기간이 지난 캠페인의 개인정보를 파기하고 통계(사업장, 상태)만 남긴다.
export async function purgeExpired(db, now = Date.now()) {
  const due = await all(db,
    `SELECT id FROM campaigns WHERE purged_at IS NULL AND status IN ('done','cancelled','draft','scheduled')
       AND COALESCE(scheduled_at, created_at) + retention_days * 86400000 <= ?`, now);
  for (const { id } of due) {
    await db.batch([
      stmt(db, `DELETE FROM inbound WHERE candidate_id IN (SELECT id FROM candidates WHERE campaign_id=?)`, id),
      stmt(db, `UPDATE candidates SET name='', phone='', message_text='', reply_text='', interview_at='', template_override='' WHERE campaign_id=?`, id),
      stmt(db, `UPDATE campaigns SET purged_at=?, template='' WHERE id=?`, now, id)
    ]);
  }
  // 매칭되지 않은 수신 문자도 90일 후 삭제
  await run(db, `DELETE FROM inbound WHERE candidate_id IS NULL AND received_at < ?`, now - 90 * 86400000);
  // 직접 발송 기록도 90일 후 삭제
  await run(db, `DELETE FROM messages WHERE at < ?`, now - 90 * 86400000);
  return due.length;
}

export async function campaignStats(db, campaignId) {
  const rows = await all(db,
    `SELECT site, status, COUNT(*) n FROM candidates WHERE campaign_id=? GROUP BY site, status`, campaignId);
  const bySite = new Map();
  for (const r of rows) {
    if (!bySite.has(r.site)) bySite.set(r.site, { site: r.site, total: 0 });
    const s = bySite.get(r.site);
    s[r.status] = r.n;
    s.total += r.n;
  }
  return [...bySite.values()].sort((a, b) => a.site.localeCompare(b.site, 'ko'));
}

// 문자 보내기 화면: 받는 사람마다 큐에 넣는다. at 이 지금이면 곧바로, 미래면 그 시각에 발송된다.
// 반환: { queued, rejected: [{phone, reason}] }
export async function queueDirect(db, { gatewayId, phones, text: rawText, userId, at = Date.now() }) {
  const text = cleanMessage(rawText);
  const seen = new Set();
  const rejected = [];
  const stmts = [];
  const now = Date.now();
  for (const raw of phones) {
    const phone = normalizePhone(raw);
    if (!isValidMobile(phone)) { rejected.push({ phone: raw, reason: '휴대폰 번호 형식이 아니에요' }); continue; }
    if (seen.has(phone)) { rejected.push({ phone: raw, reason: '같은 번호가 두 번 있어요' }); continue; }
    seen.add(phone);
    stmts.push(stmt(db,
      `INSERT INTO messages (gateway_id,phone,text,status,user_id,at,scheduled_at) VALUES (?,?,?,'scheduled',?,?,?)`,
      gatewayId, phone, text, userId ?? null, now, at));
  }
  for (let i = 0; i < stmts.length; i += 40) await db.batch(stmts.slice(i, i + 40));
  return { queued: stmts.length, rejected };
}

// 예약 취소 (아직 보내지 않은 건만). allowedGatewayIds 안의 건만 취소한다.
export async function cancelDirect(db, id, allowedGatewayIds) {
  if (!allowedGatewayIds.length) return 0;
  const r = await run(db,
    `UPDATE messages SET status='cancelled' WHERE id=? AND status='scheduled' AND gateway_id IN (${allowedGatewayIds.map(() => '?').join(',')})`,
    Number(id), ...allowedGatewayIds);
  return r.meta.changes;
}

// 캠페인과 무관하게 임의 번호로 문자를 보낸다. gw.password 는 복호화된 상태여야 한다.
export async function sendDirect(db, gw, phones, text, userId, send = sendSms) {
  const results = [];
  const stmts = [];
  for (const raw of phones) {
    const phone = normalizePhone(raw);
    if (!isValidMobile(phone)) { results.push({ phone: raw, ok: false, error: '휴대폰 번호 형식 오류' }); continue; }
    try {
      await send(gw, phone, text);
      results.push({ phone, ok: true });
      stmts.push(stmt(db, `INSERT INTO messages (gateway_id,phone,text,status,user_id,at) VALUES (?,?,?,?,?,?)`, gw.id, phone, text, 'sent', userId ?? null, Date.now()));
    } catch (e) {
      const error = String(e.message).slice(0, 300);
      results.push({ phone, ok: false, error });
      stmts.push(stmt(db, `INSERT INTO messages (gateway_id,phone,text,status,error,user_id,at) VALUES (?,?,?,?,?,?,?)`, gw.id, phone, text, 'failed', error, userId ?? null, Date.now()));
    }
  }
  if (stmts.length) await db.batch(stmts);
  return results;
}
