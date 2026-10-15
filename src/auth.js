import { hashPassword, verifyPassword, randomToken, sha256Hex } from './crypto.js';
import { first, all, run } from './d1.js';

const SESSION_MS = 12 * 3600 * 1000;

export async function createSession(db, userId) {
  const token = randomToken(32);
  await run(db, `INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)`,
    await sha256Hex(token), userId, Date.now() + SESSION_MS);
  return token;
}

export async function getUser(db, token) {
  if (!token) return null;
  const row = await first(db,
    `SELECT u.id, u.username, u.name, u.email, u.role FROM sessions s JOIN users u ON u.id=s.user_id
     WHERE s.token_hash=? AND s.expires_at>? AND u.active=1 AND u.email_verified_at IS NOT NULL`, await sha256Hex(token), Date.now());
  if (!row) return null;
  const deps = (await all(db, `SELECT department_id FROM user_departments WHERE user_id=?`, row.id)).map((r) => r.department_id);
  return { ...row, departments: deps };
}

export const canAccessDepartment = (user, departmentId) =>
  user.role === 'super' || user.departments.includes(departmentId);

// 사용자가 하나도 없으면 ADMIN_USER/ADMIN_PASSWORD 시크릿으로 최초 관리자를 만든다.
export async function ensureInitialAdmin(db, env) {
  const n = (await first(db, `SELECT COUNT(*) n FROM users`)).n;
  if (n > 0 || !env.ADMIN_PASSWORD) return;
  await run(db, `INSERT INTO users (username,pass_hash,role) VALUES (?,?, 'super')`,
    env.ADMIN_USER || 'admin', await hashPassword(env.ADMIN_PASSWORD));
}

export { hashPassword, verifyPassword };
