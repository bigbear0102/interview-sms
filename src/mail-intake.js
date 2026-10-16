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
export async function saveParsed(db, p, now = Date.now()) {
  const dup = await first(db, `SELECT id FROM applicant_inbox WHERE source=? AND apply_no=?`, p.source, p.applyNo);
  if (dup) return { ok: true, duplicate: true, id: dup.id };
  const clip = (s, n) => String(s || '').slice(0, n);
  const r = await run(db,
    `INSERT INTO applicant_inbox (source, apply_no, recruit_no, company, job_title, name, gender, age, address, education, career, resume_url, received_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    p.source, p.applyNo, clip(p.recruitNo, 30), clip(p.company, 100), clip(p.jobTitle, 200), clip(p.name, 50), clip(p.gender, 4),
    p.age ?? null, clip(p.address, 100), clip(p.education, 50), clip(p.career, 50), clip(p.resumeUrl, 500), now);
  return { ok: true, id: Number(r.meta.last_row_id) };
}

// 이메일 Worker 진입점: 반환값은 처리 결과(테스트용). 예외를 던지지 않는다.
export async function ingestRaw(db, rawBytes, now = Date.now()) {
  if (!rawBytes || rawBytes.length === 0) return { ok: false, reason: 'empty' };
  if (rawBytes.length > MAX_MAIL_BYTES) return { ok: false, reason: 'too_large' };
  let parsed;
  try { parsed = parseMime(rawBytes); } catch { return { ok: false, reason: 'parse_error' }; }
  const html = parsed.html || parsed.text;
  const p = parseAlbamonApply(html);
  if (!p) return { ok: false, reason: 'not_albamon' };
  if (!p.name) return { ok: false, reason: 'no_name' };
  return saveParsed(db, p, now);
}

// 수신함 대기 건수
export async function pendingInboxCount(db) {
  const r = await first(db, `SELECT COUNT(*) n FROM applicant_inbox WHERE status='pending'`);
  return r ? r.n : 0;
}

export async function listInbox(db, status = 'pending', limit = 200) {
  const where = status === 'done' ? `status IN ('registered','ignored')` : `status='pending'`;
  return all(db, `SELECT * FROM applicant_inbox WHERE ${where} ORDER BY received_at DESC, id DESC LIMIT ${Number(limit) || 200}`);
}

// ---------------- 연락처 가져오기 요청 · 에이전트 ----------------
import { sha256Hex } from './crypto.js';

const AGENT_KEY = 'agent_token_hash';
const AUTO_KEY = 'inbox_auto_register';

export async function createAgentToken(db) {
  const token = 'ag_' + hex(crypto.getRandomValues(new Uint8Array(24)));
  await run(db, `INSERT INTO applicant_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    AGENT_KEY, await sha256Hex(token));
  return token;
}

export async function hasAgentToken(db) {
  const r = await first(db, `SELECT value FROM applicant_settings WHERE key=?`, AGENT_KEY);
  return !!(r && r.value);
}

export async function verifyAgentToken(db, token) {
  const t = String(token || '');
  if (!/^ag_[0-9a-f]{48}$/.test(t)) return false;
  const r = await first(db, `SELECT value FROM applicant_settings WHERE key=?`, AGENT_KEY);
  if (!r || !r.value) return false;
  const h = await sha256Hex(t);
  if (h.length !== r.value.length) return false;
  let diff = 0;
  for (let i = 0; i < h.length; i++) diff |= h.charCodeAt(i) ^ r.value.charCodeAt(i);
  return diff === 0;
}

export async function getAutoRegister(db) {
  const r = await first(db, `SELECT value FROM applicant_settings WHERE key=?`, AUTO_KEY);
  return !!(r && r.value === '1');
}
export async function setAutoRegister(db, on) {
  await run(db, `INSERT INTO applicant_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, AUTO_KEY, on ? '1' : '0');
}

// 가져오기 요청: 아직 연락처가 없고 대기 중인 건만. ids 가 없으면 대기 전체. 반환: 요청한 건수
export async function requestFetch(db, ids = null) {
  let sql = `UPDATE applicant_inbox SET fetch_state='requested', fetch_note='' WHERE status='pending' AND phone='' AND fetch_state != 'requested'`;
  const args = [];
  if (Array.isArray(ids)) {
    if (!ids.length) return 0;
    sql += ` AND id IN (${ids.map(() => '?').join(',')})`;
    args.push(...ids);
  }
  const r = await run(db, sql, ...args);
  return r.meta.changes || 0;
}

// 에이전트가 처리할 요청 목록(한 번에 적게)
export async function agentQueue(db, limit = 5) {
  return all(db,
    `SELECT id, apply_no, name, resume_url FROM applicant_inbox
      WHERE status='pending' AND fetch_state='requested' AND resume_url != ''
      ORDER BY id LIMIT ${Math.min(Math.max(Number(limit) || 5, 1), 20)}`);
}

// 에이전트 결과 저장. 반환: { ok, phone? }
export async function saveFetchResult(db, id, { ok, phone = '', note = '' }, now = Date.now()) {
  const row = await first(db, `SELECT id, status FROM applicant_inbox WHERE id=?`, id);
  if (!row || row.status !== 'pending') return { ok: false, reason: 'gone' };
  const p = String(phone || '').replace(/\D/g, '');
  if (ok && /^01[016789]\d{7,8}$/.test(p)) {
    await run(db, `UPDATE applicant_inbox SET phone=?, fetch_state='done', fetch_note='', fetch_at=? WHERE id=?`, p, now, id);
    return { ok: true, phone: p };
  }
  await run(db, `UPDATE applicant_inbox SET fetch_state='failed', fetch_note=?, fetch_at=? WHERE id=?`,
    String(note || '연락처를 찾지 못했어요').slice(0, 200), now, id);
  return { ok: false, reason: 'failed' };
}
