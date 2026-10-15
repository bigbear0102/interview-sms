// 직원 계정: 가입(이메일 인증), 인증 메일 재발송, 비밀번호 재설정
import { all, first, run } from './d1.js';
import { hashPassword } from './crypto.js';
import { randomToken, sha256Hex } from './crypto.js';
import { sendMail, mailConfigured } from './mailer.js';
import { normalizePhone, isValidMobile } from './parser.js';

export const ALLOWED_DOMAIN = (env) => String(env.ALLOWED_EMAIL_DOMAIN || 'willvi.co.kr').toLowerCase();
const DAY = 86400000;

// 이메일 형식 + 허용 도메인(정확히 일치, 하위 도메인/우회 표기 불가)
export function normalizeEmail(raw) {
  return String(raw ?? '').trim().toLowerCase();
}
export function isAllowedEmail(env, raw) {
  const email = normalizeEmail(raw);
  const domain = ALLOWED_DOMAIN(env).replace(/\./g, '\\.');
  return new RegExp(`^[a-z0-9._%+-]+@${domain}$`).test(email) && email.length <= 120;
}

// ---- 횟수 제한: key 별로 windowMs 동안 limit 번까지 ----
export async function rateLimit(db, key, limit, windowMs, now = Date.now()) {
  const row = await first(db, `SELECT n, reset_at FROM rate_limits WHERE key=?`, key);
  if (!row || row.reset_at <= now) {
    await run(db, `INSERT INTO rate_limits (key,n,reset_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET n=excluded.n, reset_at=excluded.reset_at`, key, 1, now + windowMs);
    return true;
  }
  if (row.n >= limit) return false;
  await run(db, `UPDATE rate_limits SET n=n+1 WHERE key=?`, key);
  return true;
}

// ---- 토큰 ----
async function issueToken(db, userId, purpose, ttlMs) {
  await run(db, `UPDATE email_tokens SET used_at=? WHERE user_id=? AND purpose=? AND used_at IS NULL`, Date.now(), userId, purpose);
  const token = randomToken(32);
  await run(db, `INSERT INTO email_tokens (token_hash,user_id,purpose,expires_at) VALUES (?,?,?,?)`,
    await sha256Hex(token), userId, purpose, Date.now() + ttlMs);
  return token;
}

// 반환: { userId } | null  (유효한 1회용 토큰이면 사용 처리)
export async function consumeToken(db, token, purpose) {
  if (!token || token.length < 20) return null;
  const hash = await sha256Hex(token);
  const row = await first(db, `SELECT * FROM email_tokens WHERE token_hash=? AND purpose=?`, hash, purpose);
  if (!row || row.used_at || row.expires_at < Date.now()) return null;
  const r = await run(db, `UPDATE email_tokens SET used_at=? WHERE token_hash=? AND used_at IS NULL`, Date.now(), hash);
  return r.meta.changes === 1 ? { userId: row.user_id } : null;
}

// 토큰은 확인만(사용 처리 안 함) — 비밀번호 재설정 화면을 열 때
export async function peekToken(db, token, purpose) {
  if (!token || token.length < 20) return null;
  const row = await first(db, `SELECT * FROM email_tokens WHERE token_hash=? AND purpose=?`, await sha256Hex(token), purpose);
  return row && !row.used_at && row.expires_at >= Date.now() ? { userId: row.user_id } : null;
}

// ---- 메일 본문 ----
function verifyMail(name, link) {
  return {
    subject: '[문자 관리] 이메일 인증을 완료해 주세요',
    text: `${name}님, 안녕하세요.\n\n아래 링크를 눌러 이메일 인증을 완료하면 문자 관리를 사용할 수 있어요. (24시간 안에 눌러 주세요)\n\n${link}\n\n본인이 가입하지 않았다면 이 메일을 무시해 주세요.`,
    html: `<p>${esc(name)}님, 안녕하세요.</p><p>아래 버튼을 눌러 이메일 인증을 완료하면 문자 관리를 사용할 수 있어요. (24시간 안에 눌러 주세요)</p>
      <p><a href="${link}" style="display:inline-block;background:#0066cc;color:#fff;padding:12px 24px;border-radius:999px;text-decoration:none">이메일 인증하기</a></p>
      <p style="color:#6e6e73;font-size:13px">버튼이 안 보이면 이 주소를 브라우저에 붙여넣어 주세요.<br>${link}</p>
      <p style="color:#6e6e73;font-size:13px">본인이 가입하지 않았다면 이 메일을 무시해 주세요.</p>`
  };
}
function resetMail(name, link) {
  return {
    subject: '[문자 관리] 비밀번호 재설정',
    text: `${name}님, 안녕하세요.\n\n아래 링크에서 새 비밀번호를 정해 주세요. (1시간 안에 눌러 주세요)\n\n${link}\n\n본인이 요청하지 않았다면 이 메일을 무시해 주세요.`,
    html: `<p>${esc(name)}님, 안녕하세요.</p><p>아래 버튼에서 새 비밀번호를 정해 주세요. (1시간 안에 눌러 주세요)</p>
      <p><a href="${link}" style="display:inline-block;background:#0066cc;color:#fff;padding:12px 24px;border-radius:999px;text-decoration:none">비밀번호 다시 정하기</a></p>
      <p style="color:#6e6e73;font-size:13px">${link}</p><p style="color:#6e6e73;font-size:13px">본인이 요청하지 않았다면 이 메일을 무시해 주세요.</p>`
  };
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 인증 메일 발송 (가입/재발송 공통). 반환: { ok, reason }
export async function sendVerification(db, env, baseUrl, user) {
  const token = await issueToken(db, user.id, 'verify', DAY);
  const mail = verifyMail(user.name || '직원', `${baseUrl}/verify?token=${token}`);
  return sendMail(env, { to: user.email, ...mail });
}

// ---- 가입 ----
// 반환: { ok:true, mailed:boolean, mailReason?:string } | { ok:false, error:string }
export async function signUp(db, env, baseUrl, f, ip = '') {
  const name = String(f.name || '').trim().replace(/\s+/g, ' ');
  const email = normalizeEmail(f.email);
  const phone = normalizePhone(f.phone);
  const password = String(f.password || '');
  const departmentId = Number(f.department_id);

  if (name.length < 2 || name.length > 30) return { ok: false, error: '이름을 2~30글자로 적어 주세요.' };
  if (!isAllowedEmail(env, email)) return { ok: false, error: `회사 이메일(@${ALLOWED_DOMAIN(env)})만 가입할 수 있어요.` };
  if (!isValidMobile(phone)) return { ok: false, error: '휴대폰 번호를 010-1234-5678 처럼 적어 주세요.' };
  if (password.length < 8) return { ok: false, error: '비밀번호는 8글자 이상으로 정해 주세요.' };
  if (password !== String(f.password2 ?? password)) return { ok: false, error: '비밀번호 확인이 달라요.' };
  const dept = await first(db, `SELECT id FROM departments WHERE id=?`, departmentId);
  if (!dept) return { ok: false, error: '부서를 골라 주세요.' };

  if (!(await rateLimit(db, `signup:ip:${ip || 'unknown'}`, 10, 3600000))) return { ok: false, error: '잠시 후에 다시 시도해 주세요. (가입 시도가 너무 많아요)' };
  if (!(await rateLimit(db, `signup:email:${email}`, 5, 3600000))) return { ok: false, error: '이 이메일로 시도가 너무 많아요. 1시간 뒤에 다시 해 주세요.' };

  const exist = await first(db, `SELECT * FROM users WHERE email=?`, email);
  if (exist && exist.email_verified_at) {
    // 이미 가입됨 — 존재 여부를 자세히 알려 주지 않고 로그인 안내
    return { ok: true, mailed: true, existing: true };
  }
  let user = exist;
  if (exist) {
    // 인증 전 재가입: 입력한 정보로 갱신하고 인증 메일을 다시 보낸다
    await run(db, `UPDATE users SET name=?, phone=?, pass_hash=? WHERE id=?`, name, phone, await hashPassword(password), exist.id);
    await run(db, `DELETE FROM user_departments WHERE user_id=?`, exist.id);
    user = { ...exist, name };
  } else {
    const r = await run(db,
      `INSERT INTO users (username,pass_hash,role,active,name,email,phone,created_at) VALUES (?,?, 'admin',1,?,?,?,?)`,
      email, await hashPassword(password), name, email, phone, Date.now());
    user = { id: Number(r.meta.last_row_id), name, email };
  }
  await run(db, `INSERT OR IGNORE INTO user_departments (user_id, department_id) VALUES (?,?)`, user.id, departmentId);

  const sent = mailConfigured(env) ? await sendVerification(db, env, baseUrl, user) : { ok: false, reason: 'not-configured' };
  return { ok: true, mailed: sent.ok, mailReason: sent.ok ? '' : sent.reason, userId: user.id };
}

// 인증 링크 처리: 계정을 활성화한다. 반환: boolean
export async function verifyEmail(db, token) {
  const t = await consumeToken(db, token, 'verify');
  if (!t) return false;
  await run(db, `UPDATE users SET email_verified_at=?, active=1 WHERE id=?`, Date.now(), t.userId);
  return true;
}

// 인증 메일 다시 보내기 (이메일이 가입돼 있고 아직 인증 전일 때만 실제로 보낸다)
export async function resendVerification(db, env, baseUrl, emailRaw, ip = '') {
  const email = normalizeEmail(emailRaw);
  if (!isAllowedEmail(env, email)) return { ok: false, error: `회사 이메일(@${ALLOWED_DOMAIN(env)})을 적어 주세요.` };
  if (!(await rateLimit(db, `resend:${email}`, 3, 3600000))) return { ok: false, error: '인증 메일은 1시간에 3번까지 보낼 수 있어요.' };
  if (!(await rateLimit(db, `resend:ip:${ip || 'unknown'}`, 10, 3600000))) return { ok: false, error: '잠시 후에 다시 시도해 주세요.' };
  const u = await first(db, `SELECT * FROM users WHERE email=?`, email);
  if (u && !u.email_verified_at && mailConfigured(env)) await sendVerification(db, env, baseUrl, u);
  return { ok: true, mailConfigured: mailConfigured(env) };
}

// ---- 비밀번호 재설정 ----
export async function requestReset(db, env, baseUrl, emailRaw, ip = '') {
  const email = normalizeEmail(emailRaw);
  if (!isAllowedEmail(env, email)) return { ok: false, error: `회사 이메일(@${ALLOWED_DOMAIN(env)})을 적어 주세요.` };
  if (!(await rateLimit(db, `reset:${email}`, 3, 3600000))) return { ok: false, error: '1시간에 3번까지 요청할 수 있어요.' };
  if (!(await rateLimit(db, `reset:ip:${ip || 'unknown'}`, 10, 3600000))) return { ok: false, error: '잠시 후에 다시 시도해 주세요.' };
  const u = await first(db, `SELECT * FROM users WHERE email=? AND email_verified_at IS NOT NULL AND active=1`, email);
  if (u && mailConfigured(env)) {
    const token = await issueToken(db, u.id, 'reset', 3600000);
    await sendMail(env, { to: u.email, ...resetMail(u.name || '직원', `${baseUrl}/reset?token=${token}`) });
  }
  return { ok: true, mailConfigured: mailConfigured(env) };
}

export async function completeReset(db, token, newPassword) {
  if (String(newPassword || '').length < 8) return { ok: false, error: '비밀번호는 8글자 이상으로 정해 주세요.' };
  const t = await consumeToken(db, token, 'reset');
  if (!t) return { ok: false, error: '링크가 만료되었거나 이미 사용했어요. 다시 요청해 주세요.' };
  await run(db, `UPDATE users SET pass_hash=? WHERE id=?`, await hashPassword(newPassword), t.userId);
  await run(db, `DELETE FROM sessions WHERE user_id=?`, t.userId);
  return { ok: true };
}

// ---- 관리자용 ----
export async function listUsers(db) {
  return all(db,
    `SELECT u.id, u.username, u.name, u.email, u.phone, u.role, u.active, u.email_verified_at, u.created_at,
       (SELECT group_concat(d.name, ', ') FROM user_departments ud JOIN departments d ON d.id=ud.department_id WHERE ud.user_id=u.id) deps,
       (SELECT group_concat(department_id) FROM user_departments WHERE user_id=u.id) dep_ids
     FROM users u ORDER BY u.id`);
}
