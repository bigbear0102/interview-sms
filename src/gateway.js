// SMS Gateway for Android (capcom6) 클라우드/프라이빗 서버 API 클라이언트
import { hmacSha256Hex, safeEqual, decryptText, encryptPassphrase } from './crypto.js';

const authHeader = (gw) => 'Basic ' + btoa(`${gw.username}:${gw.password}`);
const baseUrl = (gw) => gw.base_url.replace(/\/$/, '');

// 게이트웨이 서버는 국제 형식(E.164)만 받는다. 국내 번호 01012345678 → +821012345678
export function toE164(phone) {
  const d = String(phone).replace(/\D/g, '');
  if (String(phone).trim().startsWith('+')) return `+${d}`;
  if (d.startsWith('0')) return `+82${d.slice(1)}`;
  if (d.startsWith('82')) return `+${d}`;
  return `+${d}`;
}

// DB 의 게이트웨이 행을 사용 가능한 상태로 만든다: 비밀번호/암호화 비밀번호 복호화 + 암호화 반복 횟수
export async function unlockGateway(env, row) {
  return {
    ...row,
    password: await decryptText(env.ENCRYPTION_KEY, row.password),
    passphrase: row.passphrase ? await decryptText(env.ENCRYPTION_KEY, row.passphrase) : '',
    iterations: Number(env.E2E_ITERATIONS) || 75000
  };
}

// gw 는 unlockGateway 를 거친 값이어야 한다. gw.passphrase 가 있으면 내용과 번호를 암호화해 보낸다.
export async function sendSms(gw, phone, text) {
  const res = await fetch(baseUrl(gw) + gw.send_path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: authHeader(gw) },
    body: JSON.stringify(await buildSendBody(gw, phone, text)),
    signal: AbortSignal.timeout(20000)
  });
  if (!res.ok) throw new Error(`게이트웨이 응답 ${res.status}: ${(await res.text()).slice(0, 150)}`);
  return res.json().catch(() => ({}));
}

export async function buildSendBody(gw, phone, text) {
  const number = toE164(phone);
  if (!gw.passphrase) return { textMessage: { text }, phoneNumbers: [number] };
  const it = gw.iterations || 75000;
  return {
    textMessage: { text: await encryptPassphrase(gw.passphrase, text, it) },
    phoneNumbers: [await encryptPassphrase(gw.passphrase, number, it)],
    isEncrypted: true
  };
}

// 폰이 문자 수신 시 우리 Worker 로 POST 하도록 웹훅을 등록한다. (같은 id 가 있으면 교체)
export async function registerWebhook(gw, publicBaseUrl) {
  const id = `interview-sms-${gw.id}`;
  const url = `${publicBaseUrl.replace(/\/$/, '')}/hook/${gw.id}/${gw.hook_token}`;
  const headers = { 'Content-Type': 'application/json', Authorization: authHeader(gw) };
  await fetch(`${baseUrl(gw)}/webhooks/${id}`, { method: 'DELETE', headers, signal: AbortSignal.timeout(20000) }).catch(() => {});
  const res = await fetch(`${baseUrl(gw)}/webhooks`, {
    method: 'POST', headers, body: JSON.stringify({ id, url, event: 'sms:received' }),
    signal: AbortSignal.timeout(20000)
  });
  if (!res.ok) throw new Error(`웹훅 등록 실패 ${res.status}: ${(await res.text()).slice(0, 150)}`);
  return url;
}

// X-Signature = HMAC-SHA256(key, rawBody + X-Timestamp), 허용 시차 ±5분
export async function verifySignature(key, rawBody, signature, timestamp, now = Date.now()) {
  if (!key) return true; // 서명 키 미설정 시 URL 토큰만으로 인증
  if (!signature || !timestamp) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  return safeEqual(await hmacSha256Hex(key, rawBody + timestamp), String(signature));
}

// 서버에 등록된 기기 목록으로 연결 상태를 확인한다. (마지막 응답이 15분 이내면 online)
export async function checkGateway(gw) {
  try {
    const res = await fetch(`${baseUrl(gw)}/devices`, {
      headers: { Authorization: authHeader(gw) },
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) return { reachable: false, error: `응답 ${res.status}` };
    const body = await res.json();
    const list = Array.isArray(body) ? body : body.devices || [];
    let last = 0;
    for (const d of list) {
      const t = Date.parse(d.lastSeen ?? d.last_seen ?? d.updatedAt ?? '');
      if (Number.isFinite(t) && t > last) last = t;
    }
    return {
      reachable: true,
      count: list.length,
      lastSeen: last ? new Date(last).toISOString() : null,
      online: last > 0 && Date.now() - last < 15 * 60000
    };
  } catch (e) {
    return { reachable: false, error: String(e.message || e).slice(0, 120) };
  }
}
