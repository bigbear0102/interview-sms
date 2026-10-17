// 메일 수신(Cloudflare 이메일 Worker) → 알바몬 지원 알림 해석 → 지원자 수신함에 저장
//  - 메일에는 이름·공고·이력서 링크만 있고 연락처는 없다. 연락처는 담당자가 이력서 페이지에서 확인해 등록한다.
//  - 메일 원문은 저장하지 않고 해석한 항목만 저장한다.
import { first, run, all } from './d1.js';

export const MAX_MAIL_BYTES = 2 * 1024 * 1024;
const TOKEN_KEY = 'mail_intake_token';

// ---------------- 수신 주소(비밀 토큰) ----------------
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function getIntakeToken(db) {
  const r = await first(db, `SELECT value FROM applicant_settings WHERE key=?`, TOKEN_KEY);
  return r && r.value ? r.value : '';
}

export async function ensureIntakeToken(db, { rotate = false } = {}) {
  let t = rotate ? '' : await getIntakeToken(db);
  if (!t) {
    t = hex(crypto.getRandomValues(new Uint8Array(12)));
    await run(db, `INSERT INTO applicant_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, TOKEN_KEY, t);
  }
  return t;
}

export function intakeDomain(env) {
  if (env.MAIL_INTAKE_DOMAIN) return env.MAIL_INTAKE_DOMAIN;
  try {
    const host = new URL(env.PUBLIC_BASE_URL || '').hostname;
    const parts = host.split('.');
    return parts.length > 2 ? parts.slice(1).join('.') : host;
  } catch { return ''; }
}

export const intakeAddress = (token, env) => `apply-${token}@${intakeDomain(env)}`;

// ---------------- 사람별 수신 주소 ----------------
export const MAIL_NAME_RE = /^[a-z0-9][a-z0-9-]{2,29}$/;

export async function getUserMailName(db, userId) {
  let r = await first(db, `SELECT name FROM user_mail_addr WHERE user_id=?`, userId);
  if (!r) {
    await run(db, `INSERT OR IGNORE INTO user_mail_addr (user_id, name, updated_at) VALUES (?,?,?)`, userId, hex(crypto.getRandomValues(new Uint8Array(6))), Date.now());
    r = await first(db, `SELECT name FROM user_mail_addr WHERE user_id=?`, userId);
  }
  return r.name;
}

// name 이 비어 있으면 무작위로 다시 만든다. 반환: { ok, name } | { ok:false, error:'invalid'|'taken' }
export async function setUserMailName(db, userId, raw) {
  const typed = String(raw || '').trim().toLowerCase();
  const name = typed || hex(crypto.getRandomValues(new Uint8Array(6)));
  if (!MAIL_NAME_RE.test(name)) return { ok: false, error: 'invalid' };
  if (name === (await getIntakeToken(db))) return { ok: false, error: 'taken' };
  const other = await first(db, `SELECT user_id FROM user_mail_addr WHERE name=?`, name);
  if (other && other.user_id !== userId) return { ok: false, error: 'taken' };
  await run(db, `INSERT INTO user_mail_addr (user_id, name, updated_at) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET name=excluded.name, updated_at=excluded.updated_at`, userId, name, Date.now());
  return { ok: true, name };
}

export async function ownerForMailName(db, name) {
  const r = await first(db, `SELECT user_id FROM user_mail_addr WHERE name=?`, String(name || '').toLowerCase());
  return r ? r.user_id : null;
}

// ---------------- MIME 해석 (의존성 없는 최소 구현) ----------------
function bytesToBinary(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return s;
}
const binaryToBytes = (s) => {
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i) & 0xff;
  return u8;
};

function decodeBody(body, encoding, charset) {
  let bin = body;
  const enc = String(encoding || '').toLowerCase().trim();
  if (enc === 'base64') {
    try { bin = atob(body.replace(/[^A-Za-z0-9+/=]/g, '')); } catch { bin = ''; }
  } else if (enc === 'quoted-printable') {
    bin = body.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  }
  const cs = String(charset || 'utf-8').toLowerCase().replace(/"/g, '');
  const label = /^(ks_c_5601-1987|ksc5601|euc-kr|cp949|ms949)$/.test(cs) ? 'euc-kr' : cs;
  try { return new TextDecoder(label).decode(binaryToBytes(bin)); } catch { return new TextDecoder('utf-8').decode(binaryToBytes(bin)); }
}

function splitMessage(str) {
  const m = str.match(/\r?\n\r?\n/);
  if (!m) return { head: str, body: '' };
  return { head: str.slice(0, m.index), body: str.slice(m.index + m[0].length) };
}

function parseHeaders(head) {
  const out = {};
  const lines = head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/);
  for (const l of lines) {
    const i = l.indexOf(':');
    if (i > 0) out[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
  }
  return out;
}

const param = (value, name) => {
  const m = String(value || '').match(new RegExp(name + '\\s*=\\s*("([^"]*)"|[^;\\s]+)', 'i'));
  return m ? (m[2] !== undefined ? m[2] : m[1]) : '';
};

// 반환: { html: string[], text: string[] }
function walk(str, depth = 0, acc = { html: [], text: [] }) {
  if (depth > 8) return acc;
  const { head, body } = splitMessage(str);
  const h = parseHeaders(head);
  const ctype = (h['content-type'] || 'text/plain').toLowerCase();
  const type = ctype.split(';')[0].trim();
  if (type.startsWith('multipart/')) {
    const boundary = param(h['content-type'], 'boundary');
    if (!boundary) return acc;
    const marker = '--' + boundary;
    const chunks = body.split(marker).slice(1);
    for (const c of chunks) {
      if (c.startsWith('--')) break;
      walk(c.replace(/^\r?\n/, ''), depth + 1, acc);
    }
  } else if (type === 'message/rfc822') {
    walk(body, depth + 1, acc);
  } else if (type === 'text/html') {
    acc.html.push(decodeBody(body, h['content-transfer-encoding'], param(h['content-type'], 'charset')));
  } else if (type === 'text/plain') {
    acc.text.push(decodeBody(body, h['content-transfer-encoding'], param(h['content-type'], 'charset')));
  }
  return acc;
}

export function parseMime(rawBytes) {
  const u8 = rawBytes instanceof Uint8Array ? rawBytes : new Uint8Array(rawBytes);
  const str = bytesToBinary(u8);
  const { head } = splitMessage(str);
  const h = parseHeaders(head);
  const parts = walk(str);
  return { headers: h, html: parts.html.join('\n'), text: parts.text.join('\n') };
}

// ---------------- 알바몬 지원 알림 해석 ----------------
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decodeEntities = (s) => String(s)
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&([a-z]+);/gi, (m, n) => (ENT[n.toLowerCase()] !== undefined ? ENT[n.toLowerCase()] : m));
const stripTags = (s) => decodeEntities(String(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

export function parseAlbamonApply(html) {
  const src = String(html || '');
  // 이력서 보기 링크 (지원 번호가 여기에 들어 있다)
  let resumeUrl = '';
  const hrefs = [...src.matchAll(/href\s*=\s*"([^"]+)"/gi)].map((m) => decodeEntities(m[1]));
  resumeUrl = hrefs.find((u) => /albamon\.com\/email-apply-url-route/i.test(u)) || '';
  if (!resumeUrl) return null;
  let applyNo = '', recruitNo = '';
  try {
    const q = new URL(resumeUrl).searchParams;
    applyNo = q.get('applyNo') || '';
    recruitNo = q.get('recruitNo') || '';
  } catch { return null; }
  if (!/^\d+$/.test(applyNo)) return null;

  // 표의 "항목 / 값" 쌍
  const fields = {};
  for (const m of src.matchAll(/<th[^>]*>([\s\S]*?)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/gi)) {
    const label = stripTags(m[1]);
    const value = stripTags(m[2]);
    if (label && !(label in fields)) fields[label] = value;
  }
  // 이름: "홍길동(여, 32세)"
  const rawName = fields['이름'] || '';
  let name = rawName, gender = '', age = null;
  const nm = rawName.match(/^(.*?)\s*\(\s*(여|남)?\s*,?\s*(\d{1,3})?\s*세?\s*\)\s*$/);
  if (nm) {
    name = nm[1].trim();
    gender = nm[2] || '';
    age = nm[3] ? Number(nm[3]) : null;
  }
  return {
    source: 'albamon',
    applyNo,
    recruitNo: recruitNo || (fields['공고번호'] || '').replace(/\D/g, ''),
    company: fields['근무회사명'] || '',
    jobTitle: fields['공고제목'] || '',
    name,
    gender,
    age,
    address: fields['주소'] || '',
    education: fields['학력'] || '',
    career: fields['총 경력'] || fields['경력'] || '',
    resumeUrl
  };
}

// ---------------- 저장 ----------------
// 반환: { ok, reason?, id?, duplicate? }
// 이력서 링크는 알바몬(https) 주소만 받는다. 나중에 확장 프로그램이 이 주소를 열기 때문에 다른 곳으로 보내는 링크는 버린다.
export function safeResumeUrl(u) {
  try {
    const x = new URL(String(u || ''));
    return x.protocol === 'https:' && /(^|\.)albamon\.com$/i.test(x.hostname) ? x.toString() : '';
  } catch { return ''; }
}

export async function saveParsed(db, p, now = Date.now(), ownerId = null, mailAccount = '') {
  const dup = await first(db, `SELECT id FROM applicant_inbox WHERE source=? AND apply_no=?`, p.source, p.applyNo);
  if (dup) return { ok: true, duplicate: true, id: dup.id };
  const clip = (s, n) => String(s || '').slice(0, n);
  // 같은 공고에 이미 정해 둔 원가중심점이 있으면 자동으로 붙인다
  const rule = p.recruitNo ? await first(db, `SELECT cost_center, job FROM inbox_cost_rules WHERE recruit_no=?`, clip(p.recruitNo, 30)) : null;
  const r = await run(db,
    `INSERT INTO applicant_inbox (source, apply_no, recruit_no, company, job_title, name, gender, age, address, education, career, resume_url, received_at, cost_center, owner_user_id, job, mail_account, fetch_state)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    p.source, p.applyNo, clip(p.recruitNo, 30), clip(p.company, 100), clip(p.jobTitle, 200), clip(p.name, 50), clip(p.gender, 4),
    p.age ?? null, clip(p.address, 100), clip(p.education, 50), clip(p.career, 50), safeResumeUrl(p.resumeUrl).slice(0, 500), now, rule ? rule.cost_center : '', ownerId, rule ? rule.job : '', clip(mailAccount, 60), rule && rule.cost_center && safeResumeUrl(p.resumeUrl) ? 'requested' : '');
  return { ok: true, id: Number(r.meta.last_row_id) };
}

// 이메일 Worker 진입점: 반환값은 처리 결과(테스트용). 예외를 던지지 않는다.
export async function ingestRaw(db, rawBytes, now = Date.now(), ownerId = null) {
  if (!rawBytes || rawBytes.length === 0) return { ok: false, reason: 'empty' };
  if (rawBytes.length > MAX_MAIL_BYTES) return { ok: false, reason: 'too_large' };
  let parsed;
  try { parsed = parseMime(rawBytes); } catch { return { ok: false, reason: 'parse_error' }; }
  const html = parsed.html || parsed.text;
  const p = parseAlbamonApply(html);
  if (!p) return { ok: false, reason: 'not_albamon' };
  if (!p.name) return { ok: false, reason: 'no_name' };
  return saveParsed(db, p, now, ownerId);
}

// 수신함 대기 건수
// viewer: { id, isSuper } — 관리자는 전체, 그 밖에는 내 건과 담당자 없는 공용 건. viewer 가 없으면 전체(내부 용도).
export function inboxScope(viewer, alias = '') {
  const c = alias ? alias + '.' : '';
  if (!viewer || viewer.isSuper) return { sql: '1=1', args: [] };
  return { sql: `(${c}owner_user_id = ? OR ${c}owner_user_id IS NULL)`, args: [viewer.id] };
}

export async function pendingInboxCount(db, viewer = null) {
  const sc = inboxScope(viewer);
  const r = await first(db, `SELECT COUNT(*) n FROM applicant_inbox WHERE status='pending' AND ${sc.sql}`, ...sc.args);
  return r ? r.n : 0;
}

// 새 지원 대기 건의 상태별 수: 등록할 수 있음(연락처 있음) / 연락처를 기다림(요청함) / 분류 필요
export async function inboxBreakdown(db, viewer = null) {
  const sc = inboxScope(viewer);
  const r = await first(db,
    `SELECT COUNT(*) pending, COALESCE(SUM(phone!=''),0) ready, COALESCE(SUM(phone='' AND fetch_state='requested'),0) waiting,
            COALESCE(SUM(cost_center=''),0) needClass
       FROM applicant_inbox WHERE status='pending' AND ${sc.sql}`, ...sc.args);
  return r || { pending: 0, ready: 0, waiting: 0, needClass: 0 };
}

export async function listInbox(db, status = 'pending', limit = 200, viewer = null) {
  const where = status === 'done' ? `status IN ('registered','ignored')` : `status='pending'`;
  const sc = inboxScope(viewer);
  return all(db, `SELECT i.*, (SELECT name FROM users WHERE id=i.owner_user_id) owner_name FROM applicant_inbox i WHERE ${where.replace(/status/g, 'i.status')} AND ${inboxScope(viewer, 'i').sql} ORDER BY received_at DESC, i.id DESC LIMIT ${Number(limit) || 200}`, ...inboxScope(viewer, 'i').args);
}

// ---------------- 연락처 가져오기 요청 · 에이전트 ----------------
import { sha256Hex } from './crypto.js';

const AGENT_KEY = 'agent_token_hash';
const AUTO_KEY = 'inbox_auto_register';

// userId 가 있으면 그 사람의 키, 없으면 예전 공용 키(담당자 없음)
export async function createAgentToken(db, userId = null) {
  const token = 'ag_' + hex(crypto.getRandomValues(new Uint8Array(24)));
  const h = await sha256Hex(token);
  if (userId == null) {
    await run(db, `INSERT INTO applicant_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, AGENT_KEY, h);
  } else {
    await run(db, `INSERT INTO agent_tokens (user_id, token_hash, created_at) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET token_hash=excluded.token_hash, created_at=excluded.created_at, last_used_at=NULL`, userId, h, Date.now());
  }
  return token;
}

// 내 연결 키가 있는지, 내 확장이 마지막으로 시스템에 접속한 시각
export async function agentStatus(db, userId) {
  if (userId == null) return { hasKey: await hasAgentToken(db, null), lastUsedAt: null };
  const r = await first(db, `SELECT last_used_at FROM agent_tokens WHERE user_id=?`, userId);
  return { hasKey: !!r, lastUsedAt: r ? r.last_used_at : null };
}

export async function hasAgentToken(db, userId = null) {
  if (userId != null) return !!(await first(db, `SELECT 1 x FROM agent_tokens WHERE user_id=?`, userId));
  const r = await first(db, `SELECT value FROM applicant_settings WHERE key=?`, AGENT_KEY);
  return !!(r && r.value);
}

// 맞는 키면 { userId } (예전 공용 키는 userId=null), 아니면 null
export async function verifyAgentToken(db, token) {
  const t = String(token || '');
  if (!/^ag_[0-9a-f]{48}$/.test(t)) return null;
  const h = await sha256Hex(t);
  const u = await first(db, `SELECT user_id FROM agent_tokens WHERE token_hash=?`, h);
  if (u) { await run(db, `UPDATE agent_tokens SET last_used_at=? WHERE user_id=?`, Date.now(), u.user_id).catch(() => {}); return { userId: u.user_id }; }
  const r = await first(db, `SELECT value FROM applicant_settings WHERE key=?`, AGENT_KEY);
  if (!r || !r.value || h.length !== r.value.length) return null;
  let diff = 0;
  for (let i = 0; i < h.length; i++) diff |= h.charCodeAt(i) ^ r.value.charCodeAt(i);
  return diff === 0 ? { userId: null } : null;
}

export async function getAutoRegister(db) {
  const r = await first(db, `SELECT value FROM applicant_settings WHERE key=?`, AUTO_KEY);
  return !!(r && r.value === '1');
}
export async function setAutoRegister(db, on) {
  await run(db, `INSERT INTO applicant_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, AUTO_KEY, on ? '1' : '0');
}

// 가져오기 요청: 아직 연락처가 없고 대기 중인 건만. ids 가 없으면 대기 전체. 반환: 요청한 건수
export async function requestFetch(db, ids = null, viewer = null) {
  const sc = inboxScope(viewer);
  let sql = `UPDATE applicant_inbox SET fetch_state='requested', fetch_note='', fetch_at=NULL WHERE status='pending' AND phone='' AND fetch_state != 'requested' AND ${sc.sql}`;
  const args = [...sc.args];
  if (Array.isArray(ids)) {
    if (!ids.length) return 0;
    sql += ` AND id IN (${ids.map(() => '?').join(',')})`;
    args.push(...ids);
  }
  const r = await run(db, sql, ...args);
  return r.meta.changes || 0;
}

// 같은 공고의 대기 건 중 연락처가 없는 건의 가져오기를 한꺼번에 요청한다(원가중심점을 정한 직후에 부른다). 반환: 요청한 건수
export async function requestFetchByPosting(db, recruitNo) {
  const r = String(recruitNo || '');
  if (!r) return 0;
  const x = await run(db, `UPDATE applicant_inbox SET fetch_state='requested', fetch_note='', fetch_at=NULL WHERE recruit_no=? AND status='pending' AND phone='' AND fetch_state != 'requested' AND resume_url != ''`, r);
  return x.meta.changes || 0;
}

// 에이전트가 처리할 요청 목록(한 번에 적게)
// userId: 내 건 + 담당자 없는 공용 건만(예전 공용 키는 전체)
// 확장이 처리할 요청을 가져가며 "가져감" 표시(fetch_at)를 남긴다. 다른 확장은 3분 동안 같은 건을 가져가지 않는다
// (관리자 PC 가 여러 알바몬 계정으로 모두 처리하고, 담당자 PC 도 자기 건을 처리할 때 같은 이력서를 두 번 열지 않게).
// all=true 면 담당자 구분 없이 모든 요청(알바몬 계정이 등록된 관리자 확장).
export const CLAIM_MS = 3 * 60 * 1000;
export async function agentQueue(db, limit = 5, userId = null, { all: everyone = false, now = Date.now() } = {}) {
  const own = userId == null || everyone ? '1=1' : '(i.owner_user_id = ? OR i.owner_user_id IS NULL)';
  const args = userId == null || everyone ? [] : [userId];
  const n = Math.min(Math.max(Number(limit) || 5, 1), 20);
  const cand = await all(db,
    `SELECT i.id FROM applicant_inbox i
      WHERE i.status='pending' AND i.fetch_state='requested' AND i.resume_url != '' AND (i.fetch_at IS NULL OR i.fetch_at < ?) AND ${own}
      ORDER BY i.id LIMIT ${n}`, now - CLAIM_MS, ...args);
  if (!cand.length) return [];
  const claim = now + Math.floor(Math.random() * 997);   // 이번에 가져간 건을 구분하는 표시
  const ph = cand.map(() => '?').join(',');
  await run(db, `UPDATE applicant_inbox SET fetch_at=? WHERE id IN (${ph}) AND fetch_state='requested' AND (fetch_at IS NULL OR fetch_at < ?)`, claim, ...cand.map((r) => r.id), now - CLAIM_MS);
  return all(db,
    `SELECT i.id, i.apply_no, i.name, i.resume_url, i.recruit_no, r.account_id
       FROM applicant_inbox i LEFT JOIN recruit_accounts r ON r.recruit_no=i.recruit_no AND i.recruit_no != ''
      WHERE i.id IN (${ph}) AND i.fetch_at=? AND i.fetch_state='requested' ORDER BY i.id`, ...cand.map((r) => r.id), claim);
}

// 에이전트 결과 저장. 반환: { ok, phone? }
export async function saveFetchResult(db, id, { ok, phone = '', note = '' }, now = Date.now(), userId = null) {
  const row = await first(db, `SELECT id, status, owner_user_id FROM applicant_inbox WHERE id=?`, id);
  if (!row || row.status !== 'pending') return { ok: false, reason: 'gone' };
  if (userId != null && row.owner_user_id != null && row.owner_user_id !== userId) return { ok: false, reason: 'gone' };
  const p = String(phone || '').replace(/\D/g, '');
  if (ok && /^01[016789]\d{7,8}$/.test(p)) {
    await run(db, `UPDATE applicant_inbox SET phone=?, fetch_state='done', fetch_note='', fetch_at=? WHERE id=?`, p, now, id);
    return { ok: true, phone: p };
  }
  await run(db, `UPDATE applicant_inbox SET fetch_state='failed', fetch_note=?, fetch_at=? WHERE id=?`,
    String(note || '연락처를 찾지 못했어요').slice(0, 200), now, id);
  return { ok: false, reason: 'failed' };
}
