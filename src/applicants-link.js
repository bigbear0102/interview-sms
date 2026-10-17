// 지원자 관리 ↔ 문자 시스템 연결 (기본 꺼짐, 항목별 선택)
//  - register : 면접 안내를 만들 때 명단을 지원자로 자동 등록(중복은 올리지 않음)
//  - history  : 지원자 상세·기록에 면접 안내 이력 표시
//  - suggest  : 노쇼 N회 이상이면 블랙리스트 후보로 "제안"만 한다(승인은 사람이)
//  - flag     : 면접 안내 명단에 블랙리스트 대상이 있으면 "참고용"으로 알려 준다(발송은 막지 않는다)
import { all, first, run } from './d1.js';

const KEYS = {
  enabled: 'link_enabled', register: 'link_register', history: 'link_history', suggest: 'link_suggest', flag: 'link_flag',
  threshold: 'suggest_threshold'
};
export const DEFAULT_THRESHOLD = 3;

export async function getLinkSettings(db) {
  const rows = await all(db, `SELECT key, value FROM applicant_settings`);
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const on = (k) => m[k] === '1';
  const enabled = on(KEYS.enabled);
  const th = parseInt(m[KEYS.threshold] || '', 10);
  return {
    enabled,
    // 항목별 스위치는 연결(전체)이 켜져 있을 때만 의미가 있다
    register: enabled && on(KEYS.register),
    history: enabled && on(KEYS.history),
    suggest: enabled && on(KEYS.suggest),
    flag: enabled && on(KEYS.flag),
    threshold: Number.isFinite(th) && th >= 1 && th <= 20 ? th : DEFAULT_THRESHOLD,
    raw: { register: on(KEYS.register), history: on(KEYS.history), suggest: on(KEYS.suggest), flag: on(KEYS.flag) }
  };
}

export async function saveLinkSettings(db, v) {
  const put = (k, val) => run(db, `INSERT INTO applicant_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, k, val);
  await put(KEYS.enabled, v.enabled ? '1' : '0');
  await put(KEYS.register, v.register ? '1' : '0');
  await put(KEYS.history, v.history ? '1' : '0');
  await put(KEYS.suggest, v.suggest ? '1' : '0');
  await put(KEYS.flag, v.flag ? '1' : '0');
  const th = parseInt(v.threshold, 10);
  await put(KEYS.threshold, String(Number.isFinite(th) && th >= 1 && th <= 20 ? th : DEFAULT_THRESHOLD));
}

// 면접 안내 이력(전화번호 기준). 관리자가 아니면 자기 부서의 면접 안내만 보인다.
export async function campaignHistory(db, phone, user, limit = 20) {
  const scoped = user && user.role !== 'super';
  const deps = (user && user.departments) || [];
  if (scoped && !deps.length) return [];
  const where = scoped ? `AND k.department_id IN (${deps.map(() => '?').join(',')})` : '';
  return all(db,
    `SELECT k.id campaign_id, k.name campaign, ca.site, ca.interview_at, ca.status, ca.outcome, ca.sent_at
       FROM candidates ca JOIN campaigns k ON k.id=ca.campaign_id
      WHERE ca.phone=? ${where} ORDER BY ca.id DESC LIMIT ${Number(limit) || 20}`, phone, ...(scoped ? deps : []));
}

// 노쇼 후보 제안: 면접 결과를 "노쇼"로 기록한 횟수가 기준 이상인데 아직 블랙리스트가 아닌 사람
export async function noshowSuggestions(db, threshold = DEFAULT_THRESHOLD, limit = 50) {
  return all(db,
    `SELECT ca.phone, MAX(ca.name) name, COUNT(*) n
       FROM candidates ca
       LEFT JOIN applicants a ON a.phone=ca.phone
       LEFT JOIN blacklist b ON b.applicant_id=a.id AND b.status='active'
       LEFT JOIN applicant_suggest_dismissed d ON d.phone=ca.phone
      WHERE ca.outcome='noshow' AND ca.phone != '' AND b.id IS NULL
      GROUP BY ca.phone
     HAVING COUNT(*) >= ? AND (MAX(d.dismissed_count) IS NULL OR COUNT(*) > MAX(d.dismissed_count))
      ORDER BY n DESC, name LIMIT ${Number(limit) || 50}`, threshold);
}

export async function dismissSuggestion(db, phone, count, userId) {
  await run(db,
    `INSERT INTO applicant_suggest_dismissed (phone, dismissed_count, dismissed_at, user_id) VALUES (?,?,?,?)
     ON CONFLICT(phone) DO UPDATE SET dismissed_count=excluded.dismissed_count, dismissed_at=excluded.dismissed_at, user_id=excluded.user_id`,
    phone, Number(count) || 0, Date.now(), userId ?? null);
}

// 전화번호 목록 중 블랙리스트로 등록 중인 사람: Map(phone -> { name, reason_code, reason_text })
export async function blacklistedAmong(db, phones) {
  const out = new Map();
  const list = [...new Set(phones.filter(Boolean))];
  for (let i = 0; i < list.length; i += 80) {
    const chunk = list.slice(i, i + 80);
    const rows = await all(db,
      `SELECT a.phone, a.name, b.reason_code, b.reason_text FROM applicants a
         JOIN blacklist b ON b.applicant_id=a.id AND b.status='active'
        WHERE a.phone IN (${chunk.map(() => '?').join(',')})`, ...chunk);
    rows.forEach((r) => out.set(r.phone, r));
  }
  return out;
}

export async function campaignPhones(db, campaignId) {
  return (await all(db, `SELECT name, phone FROM candidates WHERE campaign_id=? AND phone != '' ORDER BY id`, campaignId));
}

// 면접 안내 명단 중 블랙리스트 대상 (참고 표시용). Map(phone -> row)
export async function flaggedInCampaign(db, campaignId) {
  const rows = await all(db,
    `SELECT a.phone, a.name, b.reason_code, b.reason_text FROM applicants a
       JOIN blacklist b ON b.applicant_id=a.id AND b.status='active'
      WHERE a.phone IN (SELECT phone FROM candidates WHERE campaign_id=? AND phone != '')`, campaignId);
  return new Map(rows.map((r) => [r.phone, r]));
}

// 지원자 진행 단계: 같은 전화번호의 가장 최근 면접 안내 건으로 판단한다(별도 저장 없음).
// 면접 결과가 있으면 결과가, 없으면 답장 상태가 단계가 된다. 관리자가 아니면 자기 부서의 면접 안내만 본다.
const STAGE_BY_OUTCOME = { hired: ['ok', '입사'], passed: ['ok', '합격'], rejected: ['mute', '불합격'], noshow: ['no', '노쇼'], showed: ['info', '출석'] };
const STAGE_BY_STATUS = {
  attending: ['ok', '참석 예정'], absent: ['no', '불참'], unclear: ['review', '확인 필요'], sent: ['wait', '답 없음'],
  pending: ['mute', '보낼 예정'], sending: ['mute', '보낼 예정'], failed: ['fail', '못 보냄']
};
export function stageOf(c) {
  if (!c) return null;
  const [tone, label] = STAGE_BY_OUTCOME[c.outcome] || STAGE_BY_STATUS[c.status] || ['mute', c.status];
  return { tone, label, campaignId: c.campaign_id, interviewAt: c.interview_at || '' };
}

export async function latestStages(db, phones, user) {
  const list = [...new Set((phones || []).filter(Boolean))].slice(0, 100);
  const out = new Map();
  if (!list.length) return out;
  const scoped = user && user.role !== 'super';
  const deps = (user && user.departments) || [];
  if (scoped && !deps.length) return out;
  const rows = await all(db,
    `SELECT ca.phone, ca.status, ca.outcome, ca.interview_at, ca.campaign_id
       FROM candidates ca JOIN campaigns k ON k.id=ca.campaign_id
      WHERE ca.phone IN (${list.map(() => '?').join(',')}) AND k.status!='cancelled'
        ${scoped ? `AND k.department_id IN (${deps.map(() => '?').join(',')})` : ''}
      ORDER BY ca.id DESC`, ...list, ...(scoped ? deps : []));
  for (const r of rows) {
    const cur = out.get(r.phone);
    if (!cur) out.set(r.phone, { ...stageOf(r), times: 1, noshow: r.outcome === 'noshow' ? 1 : 0 });
    else { cur.times++; if (r.outcome === 'noshow') cur.noshow++; }
  }
  return out;
}
