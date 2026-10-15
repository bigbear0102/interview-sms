// 업무 로직: 캠페인 생성, 발송 큐, 수신 답장 처리, 보관기간 파기
import { parseReply, normalizePhone, isValidMobile } from './parser.js';
import { sendSms } from './gateway.js';

export const DEFAULT_TEMPLATE =
  '[{사업장}] {이름}님, 면접 안내드립니다. 일시: {면접일시}. 참석 가능하시면 "참석", 어려우시면 "불참"이라고 답장해 주세요.';

export function renderTemplate(tpl, c) {
  return tpl
    .replaceAll('{사업장}', c.site)
    .replaceAll('{이름}', c.name || '지원자')
    .replaceAll('{면접일시}', c.interview_at || '추후 안내');
}

// candidates: [{site,name,phone,interview_at}]
export function createCampaign(db, { departmentId, gatewayId, name, template, retentionDays, userId, candidates }) {
  const now = Date.now();
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
  const ins = db.prepare(
    `INSERT INTO campaigns (department_id, gateway_id, name, template, retention_days, created_by, created_at)
     VALUES (?,?,?,?,?,?,?)`
  ).run(departmentId, gatewayId, name, template || DEFAULT_TEMPLATE, retentionDays || 90, userId, now);
  const campaignId = Number(ins.lastInsertRowid);
  const stmt = db.prepare(
    `INSERT INTO candidates (campaign_id, site, name, phone, interview_at) VALUES (?,?,?,?,?)`
  );
  db.exec('BEGIN');
  try {
    for (const c of accepted) stmt.run(campaignId, c.site, c.name || '', c.phone, c.interview_at || '');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { campaignId, accepted: accepted.length, rejected };
}

// 발송 예약(또는 즉시: at=Date.now())
export function scheduleCampaign(db, campaignId, at) {
  db.prepare(`UPDATE campaigns SET scheduled_at=?, status='scheduled' WHERE id=? AND status IN ('draft','scheduled')`)
    .run(at, campaignId);
}

export function cancelCampaign(db, campaignId) {
  db.prepare(`UPDATE campaigns SET status='cancelled' WHERE id=? AND status IN ('draft','scheduled','sending')`)
    .run(campaignId);
}

// 미응답(sent)·실패(failed) 지원자를 다시 발송 대기로 되돌림 (리마인드)
export function remindCampaign(db, campaignId, { includeFailed = true } = {}) {
  const statuses = includeFailed ? `('sent','failed')` : `('sent')`;
  const r = db.prepare(`UPDATE candidates SET status='pending', error='' WHERE campaign_id=? AND status IN ${statuses}`)
    .run(campaignId);
  db.prepare(`UPDATE campaigns SET status='scheduled', scheduled_at=? WHERE id=?`).run(Date.now(), campaignId);
  return r.changes;
}

let running = false;
// 예약 시각이 된 캠페인을 발송한다. 한 번에 하나의 루프만 돈다.
export async function processQueue(db, { intervalMs = 3000, send = sendSms, log = console } = {}) {
  if (running) return;
  running = true;
  try {
    db.prepare(`UPDATE campaigns SET status='sending' WHERE status='scheduled' AND scheduled_at<=?`).run(Date.now());
    const campaigns = db.prepare(`SELECT * FROM campaigns WHERE status='sending'`).all();
    for (const camp of campaigns) {
      const gw = db.prepare(`SELECT * FROM gateways WHERE id=?`).get(camp.gateway_id);
      const pending = db.prepare(`SELECT * FROM candidates WHERE campaign_id=? AND status='pending' ORDER BY id`).all(camp.id);
      for (const c of pending) {
        const cur = db.prepare(`SELECT status FROM campaigns WHERE id=?`).get(camp.id);
        if (cur.status !== 'sending') break; // 취소됨
        const text = renderTemplate(camp.template, c);
        try {
          await send(gw, c.phone, text);
          db.prepare(`UPDATE candidates SET status='sent', sent_at=?, message_text=?, error='' WHERE id=?`)
            .run(Date.now(), text, c.id);
        } catch (e) {
          db.prepare(`UPDATE candidates SET status='failed', error=? WHERE id=?`).run(String(e.message).slice(0, 300), c.id);
          log.error?.(`발송 실패 candidate=${c.id}: ${e.message}`);
        }
        await new Promise((r) => setTimeout(r, intervalMs));
      }
      const left = db.prepare(`SELECT COUNT(*) n FROM candidates WHERE campaign_id=? AND status='pending'`).get(camp.id).n;
      if (left === 0) db.prepare(`UPDATE campaigns SET status='done' WHERE id=? AND status='sending'`).run(camp.id);
    }
  } finally {
    running = false;
  }
}

// 수신 문자 처리. 같은 폰(게이트웨이)이 보낸 가장 최근 안내 건에 매칭한다.
export function handleInbound(db, gatewayId, { sender, message, receivedAt }) {
  const phone = normalizePhone(sender);
  const now = Date.now();
  const cand = db.prepare(
    `SELECT c.* FROM candidates c JOIN campaigns k ON k.id=c.campaign_id
     WHERE k.gateway_id=? AND c.phone=? AND c.status IN ('sent','attending','absent','unclear') AND k.purged_at IS NULL
     ORDER BY c.sent_at DESC LIMIT 1`
  ).get(gatewayId, phone);
  if (!cand) {
    db.prepare(`INSERT INTO inbound (gateway_id,sender,message,received_at,result) VALUES (?,?,?,?,?)`)
      .run(gatewayId, phone, message, now, 'unmatched');
    return { matched: false };
  }
  const result = parseReply(message);
  if (cand.manual) {
    // 관리자가 이미 확정한 건은 원문만 기록
    db.prepare(`UPDATE candidates SET reply_text=?, replied_at=? WHERE id=?`).run(message, now, cand.id);
  } else {
    db.prepare(`UPDATE candidates SET status=?, reply_text=?, replied_at=? WHERE id=?`).run(result, message, now, cand.id);
  }
  db.prepare(`INSERT INTO inbound (gateway_id,sender,message,received_at,candidate_id,result) VALUES (?,?,?,?,?,?)`)
    .run(gatewayId, phone, message, now, cand.id, result);
  return { matched: true, candidateId: cand.id, result };
}

export function setManualStatus(db, candidateId, status) {
  if (!['attending', 'absent', 'unclear', 'sent'].includes(status)) throw new Error('invalid status');
  db.prepare(`UPDATE candidates SET status=?, manual=1 WHERE id=?`).run(status, candidateId);
}

// 보관기간이 지난 캠페인의 개인정보를 파기하고 통계(사업장, 상태)만 남긴다.
export function purgeExpired(db, now = Date.now()) {
  const due = db.prepare(
    `SELECT id FROM campaigns WHERE purged_at IS NULL AND status IN ('done','cancelled','draft','scheduled')
       AND COALESCE(scheduled_at, created_at) + retention_days * 86400000 <= ?`
  ).all(now);
  for (const { id } of due) {
    db.prepare(`UPDATE candidates SET name='', phone='', message_text='', reply_text='', interview_at='' WHERE campaign_id=?`).run(id);
    db.prepare(`DELETE FROM inbound WHERE candidate_id IN (SELECT id FROM candidates WHERE campaign_id=?)`).run(id);
    db.prepare(`UPDATE campaigns SET purged_at=?, template='' WHERE id=?`).run(now, id);
  }
  // 매칭되지 않은 수신 문자도 90일 후 삭제
  db.prepare(`DELETE FROM inbound WHERE candidate_id IS NULL AND received_at < ?`).run(now - 90 * 86400000);
  return due.length;
}

export function campaignStats(db, campaignId) {
  const rows = db.prepare(
    `SELECT site, status, COUNT(*) n FROM candidates WHERE campaign_id=? GROUP BY site, status`
  ).all(campaignId);
  const bySite = new Map();
  for (const r of rows) {
    if (!bySite.has(r.site)) bySite.set(r.site, { site: r.site, total: 0 });
    const s = bySite.get(r.site);
    s[r.status] = r.n;
    s.total += r.n;
  }
  return [...bySite.values()].sort((a, b) => a.site.localeCompare(b.site, 'ko'));
}
