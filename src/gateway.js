// android-sms-gateway (capcom6) 로컬 서버 모드 클라이언트
import { createHmac, timingSafeEqual } from 'node:crypto';

function authHeader(gw) {
  return 'Basic ' + Buffer.from(`${gw.username}:${gw.password}`).toString('base64');
}

export async function sendSms(gw, phone, text) {
  const res = await fetch(gw.base_url.replace(/\/$/, '') + gw.send_path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: authHeader(gw) },
    body: JSON.stringify({ textMessage: { text }, phoneNumbers: [phone] }),
    signal: AbortSignal.timeout(20000)
  });
  if (!res.ok) throw new Error(`게이트웨이 응답 ${res.status}: ${(await res.text()).slice(0, 150)}`);
  return res.json().catch(() => ({}));
}

// 폰 앱에 "문자 수신 시 우리 서버로 POST" 웹훅을 등록한다.
export async function registerWebhook(gw, publicBaseUrl) {
  const url = `${publicBaseUrl.replace(/\/$/, '')}/hook/${gw.id}/${gw.hook_token}`;
  const res = await fetch(gw.base_url.replace(/\/$/, '') + '/webhooks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: authHeader(gw) },
    body: JSON.stringify({ id: `interview-sms-${gw.id}`, url, event: 'sms:received' }),
    signal: AbortSignal.timeout(20000)
  });
  if (!res.ok) throw new Error(`웹훅 등록 실패 ${res.status}: ${(await res.text()).slice(0, 150)}`);
  return url;
}

// X-Signature = HMAC-SHA256(key, rawBody + X-Timestamp), 허용 시차 ±5분
export function verifySignature(key, rawBody, signature, timestamp, now = Date.now()) {
  if (!key) return true; // 서명 키 미설정 시 URL 토큰만으로 인증
  if (!signature || !timestamp) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const expected = createHmac('sha256', key).update(rawBody + timestamp).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(String(signature));
  return a.length === b.length && timingSafeEqual(a, b);
}
