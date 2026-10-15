// SMS Gateway for Android (capcom6) 클라우드/프라이빗 서버 API 클라이언트
import { hmacSha256Hex, safeEqual } from './crypto.js';

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

// gw.password 는 호출 전에 복호화되어 있어야 한다.
export async function sendSms(gw, phone, text) {
  const res = await fetch(baseUrl(gw) + gw.send_path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: authHeader(gw) },
    body: JSON.stringify({ textMessage: { text }, phoneNumbers: [toE164(phone)] }),
    signal: AbortSignal.timeout(20000)
  });
  if (!res.ok) throw new Error(`게이트웨이 응답 ${res.status}: ${(await res.text()).slice(0, 150)}`);
  return res.json().catch(() => ({}));
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
