// 메일 발송. 설정된 방식 중 하나로 보낸다. (아무것도 설정되지 않으면 보내지 않고 이유를 돌려준다)
//   1) env.MAIL_SEND            : 함수(테스트/사내 연동용) ({to, subject, text, html}) => Promise<void>
//   2) env.RESEND_API_KEY       : Resend REST API (https://resend.com) — MAIL_FROM 도메인 인증 필요
//   3) env.EMAIL (Workers 바인딩): Cloudflare Email Sending (베타, Workers 유료 플랜) — MAIL_FROM 도메인 온보딩 필요
// MAIL_FROM 예: "문자 관리 <noreply@example.com>"
export function mailConfigured(env) {
  return Boolean(env.MAIL_SEND || (env.RESEND_API_KEY && env.MAIL_FROM) || (env.EMAIL && env.MAIL_FROM));
}

// 반환: { ok: boolean, reason?: string }
export async function sendMail(env, { to, subject, text, html }) {
  try {
    if (env.MAIL_SEND) {
      await env.MAIL_SEND({ to, subject, text, html });
      return { ok: true };
    }
    if (env.RESEND_API_KEY && env.MAIL_FROM) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject, text, html }),
        signal: AbortSignal.timeout(15000)
      });
      if (!res.ok) return { ok: false, reason: `메일 서비스 응답 ${res.status}: ${(await res.text()).slice(0, 120)}` };
      return { ok: true };
    }
    if (env.EMAIL && env.MAIL_FROM) {
      await env.EMAIL.send({ to, from: env.MAIL_FROM, subject, text, html });
      return { ok: true };
    }
    return { ok: false, reason: 'not-configured' };
  } catch (e) {
    return { ok: false, reason: String(e.message || e).slice(0, 160) };
  }
}
