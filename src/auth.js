import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

export function hashPassword(pw) {
  const salt = randomBytes(16);
  const h = scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${h.toString('hex')}`;
}

export function verifyPassword(pw, stored) {
  const [alg, saltHex, hashHex] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const h = scryptSync(pw, Buffer.from(saltHex, 'hex'), 64);
  const want = Buffer.from(hashHex, 'hex');
  return h.length === want.length && timingSafeEqual(h, want);
}

const SESSION_MS = 12 * 3600 * 1000;

export function createSession(db, userId) {
  const token = randomBytes(32).toString('hex');
  db.prepare(`INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)`).run(token, userId, Date.now() + SESSION_MS);
  return token;
}

export function getUser(db, token) {
  if (!token) return null;
  const row = db.prepare(
    `SELECT u.id, u.username, u.role FROM sessions s JOIN users u ON u.id=s.user_id
     WHERE s.token=? AND s.expires_at>? AND u.active=1`
  ).get(token, Date.now());
  if (!row) return null;
  const deps = db.prepare(`SELECT department_id FROM user_departments WHERE user_id=?`).all(row.id).map((r) => r.department_id);
  return { ...row, departments: deps };
}

export function canAccessDepartment(user, departmentId) {
  return user.role === 'super' || user.departments.includes(departmentId);
}

export function ensureInitialAdmin(db, log = console) {
  const n = db.prepare(`SELECT COUNT(*) n FROM users`).get().n;
  if (n > 0) return;
  const username = process.env.ADMIN_USER || 'admin';
  const password = process.env.ADMIN_PASSWORD || randomBytes(9).toString('base64url');
  db.prepare(`INSERT INTO users (username,pass_hash,role) VALUES (?,?, 'super')`).run(username, hashPassword(password));
  log.log(`\n[초기 관리자 생성] 아이디: ${username} / 비밀번호: ${password}\n로그인 후 바로 변경하세요.\n`);
}
