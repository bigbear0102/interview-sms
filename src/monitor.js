// 운영 감시: 폰 상태 점검 + 장애 알림 메일, 오류 기록 + 오류 급증 알림
import { all, first, run } from './d1.js';
import { checkGateway, unlockGateway } from './gateway.js';
import { sendMail, mailConfigured } from './mailer.js';
import { rateLimit } from './accounts.js';
import { fmtWhen } from './ui.js';

const MIN = 60000;
export const THRESHOLDS = { okMin: 15, downMin: 120, failWindowMin: 30, failCount: 3 };

// 서버 응답 + 최근 실패 수로 상태를 정한다.
//   ok    : 최근 15분 안에 폰이 응답함
//   warn  : 15분~2시간 응답 없음 (대기 중일 수 있음 — 문자를 보낼 때 폰이 깨어난다)
//   down  : 2시간 넘게 응답 없음 / 서버 연결 실패 / 최근 30분 발송 실패 3건 이상
export function classify({ reachable, error, count, lastSeenMs }, failures = 0, now = Date.now(), stuck = 0) {
  let health, note;
  if (!reachable) { health = 'down'; note = `문자 서버에 연결하지 못했어요 (${error || '알 수 없음'})`; }
  else if (!count) { health = 'down'; note = '서버에 등록된 폰이 없어요. 폰 앱이 Online인지 확인해 주세요.'; }
  else if (!lastSeenMs) { health = 'warn'; note = '폰의 마지막 응답 시각을 알 수 없어요.'; }
  else {
    const min = Math.floor((now - lastSeenMs) / MIN);
    if (min <= THRESHOLDS.okMin) { health = 'ok'; note = ''; }
    else if (min <= THRESHOLDS.downMin) { health = 'warn'; note = `폰이 ${min}분째 응답이 없어요. 대기 중일 수 있어요.`; }
    else { health = 'down'; note = `폰이 ${Math.floor(min / 60)}시간 넘게 응답이 없어요. 폰이 꺼졌거나 앱이 멈췄는지 확인해 주세요.`; }
  }
  if (failures >= THRESHOLDS.failCount && health !== 'down') {
    health = 'down';
    note = `최근 ${THRESHOLDS.failWindowMin}분 동안 문자 ${failures}건을 보내지 못했어요. ${note}`.trim();
  }
  if (stuck > 0 && health !== 'down') {
    health = 'down';
    note = `문자 ${stuck}건을 문자 서버는 받았지만 폰이 10분 넘게 보내지 않았어요. 폰 앱의 Cloud server가 켜져 있는지, 인터넷과 절전 설정을 확인해 주세요.`;
  }
  return { health, note };
}

async function adminEmails(db) {
  return (await all(db, `SELECT email FROM users WHERE role='super' AND active=1 AND email IS NOT NULL AND email_verified_at IS NOT NULL`)).map((r) => r.email);
}

async function notifyAdmins(db, env, subject, text) {
  if (!mailConfigured(env)) return 0;
  let n = 0;
  for (const to of await adminEmails(db)) {
    const r = await sendMail(env, { to, subject, text, html: `<pre style="font:14px/1.6 sans-serif;white-space:pre-wrap">${text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</pre>` });
    if (r.ok) n++;
  }
  return n;
}

// 모든 사용 중인 폰을 점검하고 상태를 저장한다. 반환: 점검 결과 목록
export async function monitorPhones(env, now = Date.now(), check = checkGateway) {
  const db = env.DB;
  const rows = await all(db,
    `SELECT g.*, d.name dept FROM gateways g JOIN departments d ON d.id=g.department_id WHERE g.active=1`);
  const out = [];
  for (const row of rows) {
    let result;
    try {
      result = await check(await unlockGateway(env, row));
    } catch (e) {
      result = { reachable: false, error: String(e.message || e).slice(0, 100) };
    }
    const since = now - THRESHOLDS.failWindowMin * MIN;
    const failures =
      (await first(db, `SELECT COUNT(*) n FROM messages WHERE gateway_id=? AND status='failed' AND at>=?`, row.id, since)).n +
      (await first(db,
        `SELECT COUNT(*) n FROM candidates ca JOIN campaigns k ON k.id=ca.campaign_id
         WHERE k.gateway_id=? AND ca.status='failed' AND ca.sent_at>=?`, row.id, since)).n;
    const lastSeenMs = result.lastSeen ? new Date(result.lastSeen).getTime() : null;
    const stuckFrom = now - 24 * 3600000, stuckTo = now - 10 * MIN;
    const stuck =
      (await first(db, `SELECT COUNT(*) n FROM messages WHERE gateway_id=? AND status='sent' AND delivery='queued' AND at BETWEEN ? AND ?`, row.id, stuckFrom, stuckTo)).n +
      (await first(db,
        `SELECT COUNT(*) n FROM candidates ca JOIN campaigns k ON k.id=ca.campaign_id
         WHERE k.gateway_id=? AND ca.status='sent' AND ca.delivery='queued' AND ca.sent_at BETWEEN ? AND ?`, row.id, stuckFrom, stuckTo)).n;
    const { health, note } = classify({ ...result, lastSeenMs }, failures, now, stuck);

    await run(db, `UPDATE gateways SET health=?, health_note=?, health_checked_at=?, last_seen_at=COALESCE(?, last_seen_at) WHERE id=?`,
      health, note, now, lastSeenMs, row.id);

    // 알림: 새로 down 이 되었거나 6시간이 지나도 계속 down 이면 한 번 보낸다. 복구되면 복구 알림.
    let alerted = false;
    if (health === 'down' && (row.health !== 'down' || !row.alerted_at || now - row.alerted_at > 6 * 3600000)) {
      const upcoming = (await first(db,
        `SELECT (SELECT COUNT(*) FROM campaigns WHERE gateway_id=? AND status='scheduled' AND scheduled_at<=?)
              + (SELECT COUNT(*) FROM messages WHERE gateway_id=? AND status='scheduled' AND scheduled_at<=?) n`,
        row.id, now + 24 * 3600000, row.id, now + 24 * 3600000)).n;
      const sent = await notifyAdmins(db, env, `[문자 관리] 문자 보내는 폰 확인이 필요해요 (${row.name})`,
        `"${row.name}" (${row.dept}) 폰 상태: 확인 필요\n\n${note}\n\n` +
        `${upcoming ? `⚠ 24시간 안에 보낼 예약이 ${upcoming}건 있어요. 폰이 꺼져 있으면 나가지 않아요.\n\n` : ''}` +
        `확인 방법\n1. 폰이 켜져 있고 인터넷에 연결되어 있는지 확인\n2. SMSGate 앱을 열어 서비스가 시작(Online) 상태인지 확인\n3. ${env.PUBLIC_BASE_URL || ''}/admin 에서 "연결 확인"`);
      alerted = sent > 0;
      if (alerted) await run(db, `UPDATE gateways SET alerted_at=? WHERE id=?`, now, row.id);
    } else if (health === 'ok' && row.health === 'down' && row.alerted_at) {
      await notifyAdmins(db, env, `[문자 관리] 폰이 다시 정상이에요 (${row.name})`, `"${row.name}" (${row.dept}) 폰이 다시 응답하고 있어요. 조치하지 않아도 돼요.`);
      await run(db, `UPDATE gateways SET alerted_at=NULL WHERE id=?`, row.id);
    }
    out.push({ id: row.id, name: row.name, health, note, alerted });
  }
  return out;
}

// ---- 오류 기록 ----
export async function recordError(env, scope, err, path = '') {
  try {
    const message = String(err?.message || err).slice(0, 300);
    console.error(`[${scope}] ${path} ${message}`);
    await run(env.DB, `INSERT INTO error_log (at,scope,path,message) VALUES (?,?,?,?)`, Date.now(), scope, String(path).slice(0, 120), message);
    // 10분 안에 5건 이상이면 관리자에게 알린다 (1시간에 한 번)
    const n = (await first(env.DB, `SELECT COUNT(*) n FROM error_log WHERE at>=?`, Date.now() - 10 * MIN)).n;
    if (n >= 5 && (await rateLimit(env.DB, 'alert:errors', 1, 3600000))) {
      const last = await all(env.DB, `SELECT at, scope, path, message FROM error_log ORDER BY id DESC LIMIT 5`);
      await notifyAdmins(env.DB, env, '[문자 관리] 시스템 오류가 계속 나고 있어요',
        `최근 10분 동안 오류가 ${n}건 났어요.\n\n` + last.map((r) => `- ${fmtWhen(r.at)} [${r.scope}] ${r.path} ${r.message}`).join('\n') +
        `\n\n${env.PUBLIC_BASE_URL || ''}/admin 의 "시스템 상태"에서 확인할 수 있어요.`);
    }
  } catch (e) {
    console.error('recordError failed', e);
  }
}

export const recentErrors = (db, limit = 10) => all(db, `SELECT at, scope, path, message FROM error_log ORDER BY id DESC LIMIT ?`, limit);
