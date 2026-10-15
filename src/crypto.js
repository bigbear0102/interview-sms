// WebCrypto 기반 유틸 (Cloudflare Workers / Node 공용)
const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (s) => new Uint8Array((s.match(/../g) || []).map((h) => parseInt(h, 16)));
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function randomToken(bytes = 32) {
  return hex(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256Hex(text) {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

export function safeEqual(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// Workers 의 PBKDF2 반복 횟수 상한은 100000
const ITER = 100000;
async function pbkdf2(pw, salt) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITER }, key, 256);
}
export async function hashPassword(pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${hex(salt)}$${hex(await pbkdf2(pw, salt))}`;
}
export async function verifyPassword(pw, stored) {
  const [alg, salt, h] = String(stored).split('$');
  if (alg !== 'pbkdf2' || !salt || !h) return false;
  return safeEqual(hex(await pbkdf2(pw, unhex(salt))), h);
}

export async function hmacSha256Hex(key, message) {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, enc.encode(message)));
}

// 게이트웨이 비밀번호 등 저장용 대칭 암호화 (AES-GCM, 키 = SHA-256(secret))
async function aesKey(secret) {
  return crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', enc.encode(secret)), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function encryptText(secret, text) {
  if (!secret) throw new Error('ENCRYPTION_KEY 시크릿이 설정되지 않았습니다.');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(secret), enc.encode(text));
  return `enc$${b64(iv)}$${b64(ct)}`;
}
export async function decryptText(secret, stored) {
  const [tag, iv, ct] = String(stored).split('$');
  if (tag !== 'enc') return stored; // 평문 호환
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await aesKey(secret), unb64(ct));
  return new TextDecoder().decode(pt);
}
