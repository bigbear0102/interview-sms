// 업무 로직: 캠페인 생성, 발송 큐, 수신 답장 처리, 보관기간 파기 (Cloudflare D1)
import { parseReply, normalizePhone, isValidMobile } from './parser.js';
import { sendSms, unlockGateway } from './gateway.js';
import { all, first, run, stmt } from './d1.js';

export const DEFAULT_TEMPLATE =
  '[{사업장}] {이름}님, 면접 안내드립니다. 일시: {면접일시}. 참석 가능하시면 "참석", 어려우시면 "불참"이라고 답장해 주세요.';

export function renderTemplate(tpl, c) {
  return tpl
    .replaceAll('{사업장}', c.site)
    .replaceAll('{이름}', c.name || '지원자')
    .replaceAll('{면접일시}', c.interview_at || '추후 안내');
}

// candidates: [{site,name,phone,interview_at}]
export async function createCampaign(db, { departmentId, gatewayId, name, template, retentionDays, userId, candidates }) {
  const seen = new Set();
  const rejected = [];
  const accepted = [];
  candidates.forEach((c, i) => {
    const phone = normalizePhone(c.phone);
    const site = (c.site || '').trim();
    if (!site) return rejected.push({ row: i + 2, reason: '사업장 없음' });
    if (!isValidMobile(phone)) return rejected.push({ row: i + 2, reason: `휴대폰 번호 오류(${c.phone})` });
    const key = `${site}|${phone}`;
    if (seen.has(key)) return rejected.push({ row: i + 2, reason: '중복' });
    seen.add(key);
    accepted.push({ ...c, site, phone });
  });
  const ins = await run(db,
    `INSERT INTO campaigns (department_id, gateway_id, name, template, retention_days, created_by, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    departmentId, gatewayId, name, template || DEFAULT_TEMPLATE, retentionDays || 90, userId ?? null, Date.now());
  const campaignId = Number(ins.meta.last_row_id);

  // D1 은 쿼리당 바인딩 100개 제한 → 행 19개(5컬럼)씩 묶어 한 번의 batch 로 실행
  const ROWS = 19;
  const stmts = [];
  for (let i = 0; i < accepted.length; i += ROWS) {
    const chunk = accepted.slice(i, i + ROWS);
    const sql = `INSERT INTO candidates (campaign_id, site, name, phone, interview_at) VALUES ${chunk.map(() => '(?,?,?,?,?)').join(',')}`;
    stmts.push(stmt(db, sql, ...chunk.flatMap((c) => [campaignId, c.site, c.name || '', c.phone, c.interview_at || ''])));
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
         (SELECT id FROM candidates WHERE campaign_id=? AND status='pending' ORDER BY id LIMIT ?)`,
      claimTs, camp.id, budget);
    const claimed = await all(db,
      `SELECT * FROM candidates WHERE campaign_id=? AND status='sending' AND sent_at=? ORDER BY id`, camp.id, claimTs);
    if (claimed.length) {
      const gwRow = await first(db, `SELECT * FROM gateways WHERE id=?`, camp.gateway_id);
      const gw = await unlockGateway(env, gwRow);
      const updates = [];
      for (const c of claimed) {
        const text = renderTemplate(camp.template, c);
        try {
          await send(gw, c.phone, text);
          updates.push(stmt(db, `UPDATE candidates SET status='sent', sent_at=?, message_text=?, error='' WHERE id=?`, Date.now(), text, c.id));
        } catch (e) {
          updates.push(stmt(db, `UPDATE candidates SET status='failed', error=? WHERE id=?`, String(e.message).slice(0, 300), c.id));
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
  return sentCount;
}

// 수신 문자 처리. 같은 폰(게이트웨이)이 보낸 가장 최근 안내 건에 매칭한다.
export async function handleInbound(db, gatewayId, { sender, message }) {
  const phone = normalizePhone(sender);
  const now = Date.now();
  const cand = await first(db,
    `SELECT c.* FROM candidates c JOIN campaigns k ON k.id=c.campaign_id
     WHERE k.gateway_id=? AND c.phone=? AND c.status IN ('sent','attending','absent','unclear') AND k.purged_at IS NULL
     ORDER BY c.sent_at DESC LIMIT 1`, gatewayId, phone);
  if (!cand) {
    await run(db, `INSERT INTO inbound (gateway_id,sender,message,received_at,result) VALUES (?,?,?,?,?)`,
      gatewayId, phone, message, now, 'unmatched');
    return { matched: false };
  }
  const result = parseReply(message);
  if (cand.manual) {
    // 관리자가 이미 확정한 건은 원문만 기록
    await run(db, `UPDATE candidates SET reply_text=?, replied_at=? WHERE id=?`, message, now, cand.id);
  } else {
    await run(db, `UPDATE candidates SET status=?, reply_text=?, replied_at=? WHERE id=?`, result, message, now, cand.id);
  }
  await run(db, `INSERT INTO inbound (gateway_id,sender,message,received_at,candidate_id,result) VALUES (?,?,?,?,?,?)`,
    gatewayId, phone, message, now, cand.id, result);
  return { matched: true, candidateId: cand.id, result };
}

export async function setManualStatus(db, candidateId, status) {
  if (!['attending', 'absent', 'unclear', 'sent'].includes(status)) throw new Error('invalid status');
  await run(db, `UPDATE candidates SET status=?, manual=1 WHERE id=?`, status, candidateId);
}

// 보관기간이 지난 캠페인의 개인정보를 파기하고 통계(사업장, 상태)만 남긴다.
export async function purgeExpired(db, now = Date.now()) {
  const due = await all(db,
    `SELECT id FROM campaigns WHERE purged_at IS NULL AND status IN ('done','cancelled','draft','scheduled')
       AND COALESCE(scheduled_at, created_at) + retention_days * 86400000 <= ?`, now);
  for (const { id } of due) {
    await db.batch([
      stmt(db, `DELETE FROM inbound WHERE candidate_id IN (SELECT id FROM candidates WHERE campaign_id=?)`, id),
      stmt(db, `UPDATE candidates SET name='', phone='', message_text='', reply_text='', interview_at='' WHERE campaign_id=?`, id),
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
