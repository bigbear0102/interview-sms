// Cloudflare Worker 진입점: 화면(SSR) + 웹훅 + Cron 발송 큐
import { createSession, getUser, canAccessDepartment, ensureInitialAdmin, hashPassword, verifyPassword } from './auth.js';
import { candidatesFromCsv, toCsv } from './csv.js';
import { registerWebhook, verifySignature, unlockGateway } from './gateway.js';
import { encryptText, decryptText, randomToken, sha256Hex } from './crypto.js';
import {
  DEFAULT_TEMPLATE, renderTemplate, createCampaign, scheduleCampaign, cancelCampaign, remindCampaign,
  processQueue, handleInbound, setManualStatus, purgeExpired, campaignStats, sendDirect, unscheduleCampaign,
  queueDirect, cancelDirect
} from './core.js';
import { all, first, run } from './d1.js';
import { normalizePhone, isValidMobile } from './parser.js';
import { applyAdminAction, renderAdmin } from './admin.js';
import { page, esc, STATUS_LABEL, fmtTime, parseKstLocal, icon } from './views.js';
import {
  renderHome, renderCampaignList, renderCampaignNew, renderCampaignDetail, renderSend, renderMessages,
  renderPassword, renderAudit
} from './pages.js';
import {
  renderLogin, renderUnverified, renderSignup, renderSignupDone, renderForgot, renderReset, renderLinkInvalid, sortDepartments
} from './pages-auth.js';
import {
  ALLOWED_DOMAIN, normalizeEmail, signUp, verifyEmail, resendVerification, requestReset, completeReset, peekToken
} from './accounts.js';
import { mailConfigured } from './mailer.js';
import { renderPhoneHelp } from './pages-help.js';
import { OUTCOMES, setOutcome, queueAutoReminders } from './reminders.js';
import { phoneApiUrl, isPublicCloud } from './admin.js';
import { monitorPhones, recordError } from './monitor.js';
import { applyDeliveryEvent, pollDelivery, notifyNewReply, unreadCount, markAllRead } from './delivery.js';
import { rateLimit } from './accounts.js';

// 어느 실행 환경이 응답했는지 확인용 (Cloudflare Workers / Node)
const RUNTIME = typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers' ? 'workers' : 'node';
const html = (body, status = 200, headers = {}) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store', 'X-Runtime': RUNTIME, ...headers } });
const redirect = (to, headers = {}) => new Response(null, { status: 303, headers: { Location: to, ...headers } });
const form = (raw) => Object.fromEntries(new URLSearchParams(raw));
const getCookie = (req, name) =>
  (req.headers.get('cookie') || '').split(';').map((s) => s.trim().split('=')).find((p) => p[0] === name)?.[1];

async function audit(db, user, action, detail = '') {
  await run(db, `INSERT INTO audit (at,user_id,action,detail) VALUES (?,?,?,?)`, Date.now(), user?.id ?? null, action, detail);
}

async function visibleDepartments(db, user) {
  const all_ = await all(db, `SELECT * FROM departments ORDER BY name`);
  return user.role === 'super' ? all_ : all_.filter((d) => user.departments.includes(d.id));
}

async function loadCampaign(db, user, id) {
  const c = await first(db, `SELECT k.*, d.name dept, g.name gateway FROM campaigns k
    JOIN departments d ON d.id=k.department_id JOIN gateways g ON g.id=k.gateway_id WHERE k.id=?`, id);
  return c && canAccessDepartment(user, c.department_id) ? c : null;
}

// 화면 위치(상단/하단 메뉴 강조)
const navFor = (p) =>
  p === '/' ? 'home' : p.startsWith('/send') ? 'send' : p.startsWith('/messages') ? 'inbox'
    : p.startsWith('/campaigns') ? 'interview' : (p.startsWith('/admin') || p.startsWith('/audit')) ? 'settings'
    : p.startsWith('/password') ? 'account' : '';

async function handle(request, env, ctx) {
  const db = env.DB;
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const publicBase = env.PUBLIC_BASE_URL || url.origin;
  let m;

  // 문자 수신 웹훅 (로그인 불필요, URL 토큰 + HMAC)
  // 폰이 정말 알림을 보냈는지 확인할 수 있도록, 도착한 요청은 결과와 함께 감사 로그에 남긴다(개인정보 제외).
  if (method === 'POST' && (m = path.match(/^\/hook\/(\d+)\/([A-Za-z0-9_-]+)$/))) {
    const gw = await first(db, `SELECT * FROM gateways WHERE id=?`, Number(m[1]));
    if (!gw || gw.hook_token !== m[2]) {
      await audit(db, null, 'hook.reject', `gateway=${m[1]} reason=bad-token`);
      return html('not found', 404);
    }
    const raw = await request.text();
    if (!(await verifySignature(gw.signing_key, raw, request.headers.get('x-signature'), request.headers.get('x-timestamp')))) {
      await audit(db, null, 'hook.reject', `gateway=${gw.id} reason=bad-signature`);
      return html('bad signature', 401);
    }
    let evt;
    try { evt = JSON.parse(raw); } catch {
      await audit(db, null, 'hook.reject', `gateway=${gw.id} reason=bad-json`);
      return html('bad request', 400);
    }
    let note = 'ignored';
    if (evt.event === 'sms:received' && evt.payload) {
      const r = await handleInbound(db, gw.id, {
        sender: evt.payload.sender ?? evt.payload.phoneNumber ?? '',
        message: evt.payload.message ?? ''
      });
      note = r.matched ? `matched result=${r.result}` : 'unmatched';
      ctx.waitUntil(notifyNewReply(env, gw.id).catch((e) => recordError(env, 'notify', e, 'notifyNewReply')));
    } else if (['sms:sent', 'sms:delivered', 'sms:failed'].includes(evt.event) && evt.payload) {
      const ev = evt.event.slice(4);
      const r = await applyDeliveryEvent(db, {
        gwMsgId: evt.payload.messageId ?? evt.payload.id ?? '',
        event: ev,
        reason: evt.payload.reason ?? evt.payload.error ?? ''
      });
      note = r.matched ? `${ev} ${r.kind}` : `${ev} unmatched`;
      if (ev === 'failed' && r.matched) ctx.waitUntil(processQueue(env).catch(() => {}));
    }
    await audit(db, null, 'hook.recv', `gateway=${gw.id} event=${String(evt.event).slice(0, 30)} ${note}`);
    return html('ok');
  }

  if (path === '/healthz') {
    try {
      await first(db, `SELECT 1 AS ok`);
      return new Response(JSON.stringify({ ok: true, db: true, runtime: RUNTIME }), { headers: { 'Content-Type': 'application/json' } });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, db: false }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    }
  }

  // CSRF 방어: 브라우저가 보낸 POST는 Origin 호스트가 현재 호스트와 같아야 한다
  if (method === 'POST') {
    const origin = request.headers.get('origin');
    if (origin) {
      let ok = false;
      try { ok = new URL(origin).host === url.host; } catch { /* ignore */ }
      if (!ok) return html('forbidden', 403);
    }
  }

  // 로그인 (이메일 + 비밀번호)
  if (path === '/login') {
    if (method === 'POST') {
      const ip = request.headers.get('cf-connecting-ip') || 'unknown';
      const fail = (await first(db, `SELECT * FROM login_fail WHERE ip=?`, ip)) || { n: 0, until: 0 };
      if (fail.until > Date.now()) return html(page(null, '로그인', renderLogin('시도 횟수가 너무 많아요. 5분 뒤에 다시 시도해 주세요.')), 429);
      await ensureInitialAdmin(db, env);
      const f = form(await request.text());
      const id = normalizeEmail(f.email || f.username);
      // 이메일로 찾고, 이메일이 아닌 값이면 이전 방식의 아이디도 허용한다(이메일을 아직 등록하지 않은 관리자 계정용)
      const u = await first(db, `SELECT * FROM users WHERE active=1 AND (email=? OR (username=? AND email IS NULL))`, id, f.email || f.username || '');
      if (u && (await verifyPassword(f.password || '', u.pass_hash))) {
        if (!u.email_verified_at) {
          return html(page(null, '이메일 인증', renderUnverified(u.email || id, mailConfigured(env))), 403);
        }
        await run(db, `DELETE FROM login_fail WHERE ip=?`, ip);
        await audit(db, u, 'login');
        const token = await createSession(db, u.id);
        return redirect('/', { 'Set-Cookie': `sid=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=43200` });
      }
      const n = fail.n + 1;
      await run(db, `INSERT INTO login_fail (ip,n,until) VALUES (?,?,?)
        ON CONFLICT(ip) DO UPDATE SET n=excluded.n, until=excluded.until`,
        ip, n >= 5 ? 0 : n, n >= 5 ? Date.now() + 5 * 60000 : 0);
      return html(page(null, '로그인', renderLogin('이메일 또는 비밀번호가 올바르지 않아요.', '', f.email || '')), 401);
    }
    const info = url.searchParams.get('verified') ? '이메일 인증이 끝났어요. 로그인해 주세요.'
      : url.searchParams.get('reset') ? '비밀번호를 바꿨어요. 새 비밀번호로 로그인해 주세요.' : '';
    return html(page(null, '로그인', renderLogin('', info)));
  }

  // ---- 회원가입 / 이메일 인증 / 비밀번호 재설정 (로그인 전) ----
  const ipOf = () => request.headers.get('cf-connecting-ip') || 'unknown';

  if (path === '/signup') {
    const deps = sortDepartments(await all(db, `SELECT id, name FROM departments`));
    const domain = ALLOWED_DOMAIN(env);
    if (method === 'POST') {
      const f = form(await request.text());
      const r = await signUp(db, env, publicBase, f, ipOf());
      if (!r.ok) return html(page(null, '회원가입', renderSignup({ deps, domain, err: r.error, v: f })), 400);
      await audit(db, null, 'signup', r.existing ? 'existing' : `user=${r.userId} mailed=${r.mailed ? 1 : 0}`);
      return html(page(null, '가입 신청', renderSignupDone({ email: normalizeEmail(f.email), mailed: r.mailed, existing: r.existing })));
    }
    return html(page(null, '회원가입', renderSignup({ deps, domain })));
  }

  if (path === '/verify' && method === 'GET') {
    const ok = await verifyEmail(db, url.searchParams.get('token') || '');
    if (!ok) return html(page(null, '인증', renderLinkInvalid()), 400);
    return redirect('/login?verified=1');
  }

  if (path === '/verify/resend' && method === 'POST') {
    const f = form(await request.text());
    const r = await resendVerification(db, env, publicBase, f.email, ipOf());
    if (!r.ok) return html(page(null, '로그인', renderLogin(r.error, '', f.email)), 429);
    return html(page(null, '로그인', renderLogin('', r.mailConfigured
      ? '인증 메일을 다시 보냈어요. 메일의 링크를 눌러 주세요.' : '메일 발송이 아직 설정되지 않았어요. 관리자에게 승인을 요청해 주세요.', f.email)));
  }

  if (path === '/forgot') {
    if (method === 'POST') {
      const f = form(await request.text());
      const r = await requestReset(db, env, publicBase, f.email, ipOf());
      if (!r.ok) return html(page(null, '비밀번호 재설정', renderForgot({ err: r.error })), 429);
      return html(page(null, '비밀번호 재설정', renderForgot({ sent: true, configured: r.mailConfigured })));
    }
    return html(page(null, '비밀번호 재설정', renderForgot({})));
  }

  if (path === '/reset') {
    if (method === 'POST') {
      const f = form(await request.text());
      if (f.password !== f.password2) return html(page(null, '새 비밀번호', renderReset({ token: f.token || '', err: '비밀번호 확인이 달라요.' })), 400);
      const r = await completeReset(db, f.token || '', f.password);
      if (!r.ok) return html(page(null, '새 비밀번호', renderReset({ token: f.token || '', err: r.error })), 400);
      return redirect('/login?reset=1');
    }
    const token = url.searchParams.get('token') || '';
    if (!(await peekToken(db, token, 'reset'))) return html(page(null, '새 비밀번호', renderLinkInvalid()), 400);
    return html(page(null, '새 비밀번호', renderReset({ token })));
  }

  const user = await getUser(db, getCookie(request, 'sid'));
  if (!user) return redirect('/login');
  let unread = 0;
  if (method === 'GET' && path !== '/logout') unread = await unreadCount(db, user).catch(() => 0);
  const pg = (title, body, nav) => page(user, title, body, nav || navFor(path), { inbox: unread });

  if (path === '/logout' && method === 'POST') {
    await run(db, `DELETE FROM sessions WHERE token_hash=?`, await sha256Hex(getCookie(request, 'sid')));
    return redirect('/login', { 'Set-Cookie': 'sid=; Max-Age=0; Path=/; Secure; HttpOnly' });
  }

  // 홈: 문자 관리 요약
  if (path === '/' && method === 'GET') {
    const deps = await visibleDepartments(db, user);
    return html(pg('홈', await renderHome(db, user, deps)));
  }

  // 면접 안내 목록 (문자 관리 안의 한 기능)
  if (path === '/campaigns' && method === 'GET') {
    const deps = await visibleDepartments(db, user);
    return html(pg('면접 안내', await renderCampaignList(db, user, deps)));
  }

  // 새 캠페인
  if (path === '/campaigns/new') {
    const deps = await visibleDepartments(db, user);
    const gws = (await all(db, `SELECT id,department_id,name FROM gateways WHERE active=1`)).filter((g) => deps.some((d) => d.id === g.department_id));
    if (method === 'GET') {
      if (!gws.length) return html(pg('면접 안내 만들기', `<div class="notice warn" role="alert">${icon('alert')}<div><b>문자를 보낼 폰이 아직 연결되지 않았어요.</b><br>${user.role === 'super' ? '<a href="/admin">설정에서 폰을 먼저 연결하세요.</a>' : '전체 관리자에게 폰 연결을 부탁하세요.'}</div></div>`));
      const today = fmtTime(Date.now()).slice(5, 10);
      const body = renderCampaignNew({ gws, deps, today, defaultTemplate: DEFAULT_TEMPLATE });
      return html(pg('면접 안내 만들기', body));
    }
    const f = form(await request.text());
    const gw = gws.find((g) => g.id === Number(f.gateway_id));
    if (!gw) return html(pg('오류', '<p>권한이 없습니다.</p>'), 403);
    const one = f.mode === 'one';
    const defaultSite = String(one ? f.one_site : f.default_site || '').trim();
    if (one) {
      if (!defaultSite) return html(pg('오류', '<p>사업장을 적어 주세요.</p><p><a href="/campaigns/new">돌아가기</a></p>'), 400);
      f.name = `${f.name || '면접 안내'} ${String(f.one_name || '').trim()}`.trim();
    }
    if (one && !isValidMobile(normalizePhone(f.one_phone || ''))) return html(pg('오류', '<p>휴대폰 번호를 확인해 주세요. (예: 010-1234-5678)</p><p><a href="/campaigns/new">돌아가기</a></p>'), 400);
    const parsed = one
      ? { errors: [], candidates: [{ site: defaultSite, name: String(f.one_name || '').trim(), phone: f.one_phone || '', interview_at: String(f.one_when || '').trim() }] }
      : candidatesFromCsv(f.csv || '', { requireSite: !defaultSite });
    if (parsed.errors.length) return html(pg('오류', `<p>${parsed.errors.map(esc).join('<br>')}</p><p><a href="/campaigns/new">돌아가기</a></p>`), 400);
    const r = await createCampaign(db, {
      departmentId: gw.department_id, gatewayId: gw.id, name: f.name || '무제', template: f.template,
      retentionDays: Number(f.retention_days) || 90, userId: user.id, candidates: parsed.candidates, autoRemind: f.auto_remind === '1', defaultSite
    });
    await audit(db, user, 'campaign.create', `campaign=${r.campaignId} accepted=${r.accepted} rejected=${r.rejected.length}`);
    let scheduledAt = null;
    let scheduleError = '';
    if (f.send_mode === 'schedule') {
      const at = f.when ? parseKstLocal(f.when) : NaN;
      if (!Number.isFinite(at)) scheduleError = '예약 시간을 적지 않아서 예약하지 못했어요. 다음 화면에서 시간을 정해 주세요.';
      else if (at < Date.now() - 60000) scheduleError = '이미 지난 시간이라 예약하지 못했어요. 다음 화면에서 시간을 다시 정해 주세요.';
      else {
        await scheduleCampaign(db, r.campaignId, at);
        scheduledAt = at;
        await audit(db, user, 'campaign.schedule', `campaign=${r.campaignId} at=${new Date(at).toISOString()}`);
      }
    }
    const rej = r.rejected.length
      ? `<div class="notice warn" role="alert">${icon('alert')}<div><b>${r.rejected.length}명은 올리지 못했어요.</b> 아래 이유를 고쳐서 다시 올리거나, 그대로 두셔도 돼요.<ul style="margin:8px 0 0;padding-left:20px">${r.rejected.slice(0, 50).map((x) => `<li>${x.row}번째 줄: ${esc(x.reason)}</li>`).join('')}</ul></div></div>` : '';
    const nextStep = scheduledAt
      ? `<div class="notice ok">${icon('clock')}<div><b>${esc(fmtTime(scheduledAt))}에 보내도록 예약했어요.</b><br>그때까지 컴퓨터나 폰을 만지지 않아도 돼요. 예약은 다음 화면에서 바꾸거나 취소할 수 있어요.</div></div>`
      : `${scheduleError ? `<div class="notice warn" role="alert">${icon('alert')}<div>${esc(scheduleError)}</div></div>` : ''}<div class="notice info">${icon('info')}<div><b>아직 문자는 나가지 않았어요.</b><br>다음 화면에서 "지금 바로 보내기"를 누르면 문자가 나가요.</div></div>`;
    return html(pg('올리기 완료', `<header class="phead"><div><h1>명단을 올렸어요</h1></div></header>
      <div class="col">
        <div class="notice ok">${icon('check')}<div><b>${r.accepted}명을 불러왔어요.</b></div></div>
        ${rej}${nextStep}
        <a class="btn big" href="/campaigns/${r.campaignId}">${scheduledAt ? '예약 내용 확인하기' : '다음: 보내기 화면으로'}</a>
      </div>`, 'interview'));
  }

  // 캠페인 상세 / 액션
  if ((m = path.match(/^\/campaigns\/(\d+)(?:\/(send|unschedule|cancel|remind|export\.csv|set|outcome|autoremind))?$/))) {
    const camp = await loadCampaign(db, user, Number(m[1]));
    if (!camp) return html(pg('없음', '<p>캠페인을 찾을 수 없습니다.</p>'), 404);
    const action = m[2];

    if (method === 'POST' && action) {
      const f = form(await request.text());
      if (action === 'send') {
        const at = f.when ? parseKstLocal(f.when) : Date.now();
        if (!Number.isFinite(at)) return html(pg('오류', '<p>시각 형식 오류</p>'), 400);
        await scheduleCampaign(db, camp.id, at);
        await audit(db, user, 'campaign.send', `campaign=${camp.id} at=${new Date(at).toISOString()}`);
        if (at <= Date.now()) ctx.waitUntil(processQueue(env).catch(console.error));
      } else if (action === 'unschedule') {
        await unscheduleCampaign(db, camp.id);
        await audit(db, user, 'campaign.unschedule', `campaign=${camp.id}`);
      } else if (action === 'cancel') {
        await cancelCampaign(db, camp.id);
        await audit(db, user, 'campaign.cancel', `campaign=${camp.id}`);
      } else if (action === 'remind') {
        const n = await remindCampaign(db, camp.id);
        await audit(db, user, 'campaign.remind', `campaign=${camp.id} n=${n}`);
        if (n > 0) ctx.waitUntil(processQueue(env).catch(console.error));
      } else if (action === 'outcome') {
        const cand = await first(db, `SELECT id FROM candidates WHERE id=? AND campaign_id=?`, Number(f.id), camp.id);
        if (cand && (f.outcome === '' || OUTCOMES[f.outcome])) {
          await setOutcome(db, cand.id, f.outcome);
          await audit(db, user, 'candidate.outcome', `campaign=${camp.id} candidate=${cand.id} outcome=${f.outcome || '-'}`);
        }
      } else if (action === 'autoremind') {
        await run(db, `UPDATE campaigns SET auto_remind=? WHERE id=?`, f.on === '1' ? 1 : 0, camp.id);
        await audit(db, user, 'campaign.autoremind', `campaign=${camp.id} on=${f.on === '1' ? 1 : 0}`);
      } else if (action === 'set') {
        const cand = await first(db, `SELECT id FROM candidates WHERE id=? AND campaign_id=?`, Number(f.id), camp.id);
        if (cand) {
          await setManualStatus(db, cand.id, f.status);
          await audit(db, user, 'candidate.manual', `campaign=${camp.id} candidate=${cand.id} status=${f.status}`);
        }
      }
      return redirect(`/campaigns/${camp.id}${f.back || ''}`);
    }

    if (action === 'export.csv') {
      await audit(db, user, 'campaign.export', `campaign=${camp.id}`);
      const rows = await all(db, `SELECT * FROM candidates WHERE campaign_id=? ORDER BY site, id`, camp.id);
      const out = [['사업장(원가중심점)', '이름', '전화번호', '면접일시', '상태', '답장', '발송시각', '응답시각', '결과']].concat(
        rows.map((r) => [r.site, r.name, r.phone, r.interview_at, STATUS_LABEL[r.status] || r.status, r.reply_text,
          r.status === 'pending' ? '' : fmtTime(r.sent_at), fmtTime(r.replied_at), OUTCOMES[r.outcome] || '']));
      return new Response(toCsv(out), {
        headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="campaign-${camp.id}.csv"` }
      });
    }

    const siteFilter = url.searchParams.get('site') || '';
    const statusFilter = url.searchParams.get('status') || '';
    const stats = await campaignStats(db, camp.id);
    const siteRows = stats.map((s) => {
      const attending = s.attending || 0, absent = s.absent || 0, unclear = s.unclear || 0, noreply = s.sent || 0;
      const failed = s.failed || 0, waiting = (s.pending || 0) + (s.sending || 0);
      const replied = attending + absent + unclear;
      const delivered = replied + noreply;
      return { site: s.site, delivered, replied, rate: delivered ? Math.round((replied / delivered) * 100) + '%' : '-', attending, absent, unclear, noreply, failed, waiting };
    });
    const siteTotal = siteRows.reduce((t, r) => {
      for (const k of ['delivered', 'replied', 'attending', 'absent', 'unclear', 'noreply', 'failed', 'waiting']) t[k] = (t[k] || 0) + r[k];
      return t;
    }, {});
    siteTotal.rate = siteTotal.delivered ? Math.round((siteTotal.replied / siteTotal.delivered) * 100) + '%' : '-';
    const deliveryStats = await first(db,
      `SELECT COALESCE(SUM(delivery='delivered'),0) delivered, COALESCE(SUM(status='pending' AND attempts>0),0) retrying FROM candidates WHERE campaign_id=?`, camp.id);
    const firstCand = camp.template ? await first(db, `SELECT * FROM candidates WHERE campaign_id=? ORDER BY id LIMIT 1`, camp.id) : null;
    const previewText = camp.template ? renderTemplate(camp.template, firstCand || { site: '', name: '홍길동', interview_at: '' }) : '';
    const where = ['campaign_id=?']; const args = [camp.id];
    if (siteFilter) { where.push('site=?'); args.push(siteFilter); }
    if (statusFilter) { where.push('status=?'); args.push(statusFilter); }
    const cands = await all(db, `SELECT * FROM candidates WHERE ${where.join(' AND ')} ORDER BY site, id LIMIT 500`, ...args);
    const back = '?' + url.searchParams.toString();
    const totals = stats.reduce((t, s) => {
      for (const k of ['total', 'attending', 'absent', 'sent', 'unclear', 'failed', 'pending', 'sending']) t[k] = (t[k] || 0) + (s[k] || 0);
      return t;
    }, {});
    const waiting = (totals.pending || 0) + (totals.sending || 0);
    const STATE = {
      draft: ['info', '아직 문자를 보내지 않았어요. 아래에서 지금 보내거나 예약할 수 있어요.'],
      scheduled: ['ok', `${fmtTime(camp.scheduled_at)}에 보낼 예정이에요.`],
      sending: ['info', `문자를 보내는 중이에요. (${totals.total - waiting}/${totals.total}명 보냄) 잠시 후 새로고침해 보세요.`],
      done: ['ok', '모두 보냈어요. 답장이 오면 아래 숫자가 바뀌어요.'],
      cancelled: ['warn', '보내기를 취소했어요.']
    };
    const [tone, stateText] = camp.purged_at ? ['info', '개인정보 보관 기간이 지나 이름과 전화번호를 지웠어요. 숫자만 남아 있어요.'] : (STATE[camp.status] || ['info', camp.status]);
    const stateNotice = `<div class="notice ${tone}">${icon(tone === 'ok' ? 'check' : tone === 'warn' ? 'alert' : 'info')}<div>${esc(stateText)}</div></div>`;
    const canSend = !camp.purged_at && ['draft', 'scheduled'].includes(camp.status);
    const body = renderCampaignDetail({
      camp, totals, siteRows, siteTotal, cands, siteFilter, statusFilter, previewText, canSend, stateNotice, delivery: deliveryStats,
      backQuery: back, back: { href: '/campaigns', label: '면접 안내' }
    });
    return html(pg(camp.name, body));
  }

  // 설정 (전체 관리자 전용): 폰 연결, 부서, 관리자 계정
  if (path === '/admin') {
    if (user.role !== 'super') return html(pg('권한 없음', '<p>권한이 없습니다.</p>'), 403);
    let result = null;
    if (method === 'POST') {
      const f = form(await request.text());
      result = await applyAdminAction(db, env, { ...f, _me: user.id }, publicBase);
      await audit(db, user, 'admin.' + (f.do || '?'), result.ok ? 'ok' : 'fail');
    }
    return html(pg('설정', await renderAdmin(db, env, publicBase, result)));
  }

  // 폰 설치 안내 (로그인한 모두)
  if (path === '/help/phone') {
    const isAdmin = user.role === 'super';
    return html(pg('폰 설치 안내', renderPhoneHelp({
      pub: isPublicCloud(env), apiUrl: phoneApiUrl(env), token: isAdmin ? (env.GATEWAY_PRIVATE_TOKEN || '') : '', isAdmin
    }), 'settings'));
  }

  // 지원자 명단 양식 내려받기
  if (path === '/template.csv') {
    const csv = toCsv([['사업장(원가중심점)', '이름', '전화번호', '면접일시'], ['1001 강남점', '홍길동', '010-1234-5678', '10/20 14:00'], ['1002 서초점', '김철수', '010-2345-6789', '10/20 15:00']]);
    return new Response(csv, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="candidates-template.csv"; filename*=UTF-8''${encodeURIComponent('지원자명단-양식.csv')}` } });
  }

  if (path === '/audit' && user.role === 'super') {
    const rows = await all(db, `SELECT a.*, u.username FROM audit a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 300`);
    return html(pg('기록', renderAudit(rows)));
  }

  // 문자 보내기 / 문자함 (직접 보내는 문자, 예약 포함)
  if (path === '/send' || path === '/messages' || path === '/messages/cancel') {
    const deps = await visibleDepartments(db, user);
    const gws = (await all(db, `SELECT id,department_id,name FROM gateways WHERE active=1`)).filter((g) => deps.some((d) => d.id === g.department_id));
    if (!gws.length) {
      return html(pg('문자 보내기', `<div class="notice warn" role="alert">${icon('alert')}<div><b>문자를 보낼 폰이 아직 연결되지 않았어요.</b><br>${user.role === 'super' ? '<a href="/admin">설정에서 폰을 먼저 연결하세요.</a>' : '전체 관리자에게 폰 연결을 부탁하세요.'}</div></div>`));
    }

    if (path === '/messages/cancel' && method === 'POST') {
      const f = form(await request.text());
      const n = await cancelDirect(db, f.id, gws.map((g) => g.id));
      if (n) await audit(db, user, 'message.cancel', `message=${Number(f.id)}`);
      return redirect('/messages?dir=scheduled');
    }

    // 새 문자 (지금 / 예약). POST /messages 도 같은 처리를 한다(이전 주소 호환).
    let notice = '';
    let keep = {};
    if (method === 'POST') {
      const f = form(await request.text());
      const gwRow = gws.find((g) => g.id === Number(f.gateway_id)) || (gws.length === 1 ? gws[0] : null);
      const phones = String(f.phones || '').split(/[\s,;]+/).filter(Boolean);
      const text = String(f.text || '').trim();
      let at = Date.now();
      let err = '';
      if (!gwRow) err = '보낼 폰을 골라 주세요.';
      else if (!phones.length) err = '받는 번호를 적어 주세요.';
      else if (!text) err = '문자 내용을 적어 주세요.';
      else if (phones.length > 200) err = '한 번에 최대 200명까지 보낼 수 있어요. 나누어서 보내 주세요.';
      else if (f.send_mode === 'schedule') {
        at = f.when ? parseKstLocal(f.when) : NaN;
        if (!Number.isFinite(at)) err = '예약 시간을 정해 주세요.';
        else if (at < Date.now() - 60000) err = '이미 지난 시간이에요. 시간을 다시 정해 주세요.';
      }
      if (err) {
        notice = `<div class="notice warn" role="alert">${icon('alert')}<div>${esc(err)}</div></div>`;
        keep = { toPhone: f.phones, text: f.text };
      } else {
        const r = await queueDirect(db, { gatewayId: gwRow.id, phones, text, userId: user.id, at });
        await audit(db, user, f.send_mode === 'schedule' ? 'message.schedule' : 'message.send',
          `gateway=${gwRow.id} queued=${r.queued} rejected=${r.rejected.length}`);
        if (r.queued && at <= Date.now() + 1000) ctx.waitUntil(processQueue(env).catch(console.error));
        const bad = r.rejected.length
          ? `<div class="notice warn" role="alert">${icon('alert')}<div>보내지 못한 번호 ${r.rejected.length}건: ${r.rejected.slice(0, 10).map((x) => `${esc(x.phone)} (${esc(x.reason)})`).join(', ')}</div></div>` : '';
        const when = f.send_mode === 'schedule' ? `${fmtTime(at)}에 보내도록 예약했어요` : '보내는 중이에요';
        notice = (r.queued ? `<div class="notice ok">${icon('check')}<div><b>${r.queued}명에게 ${when}.</b> <a href="/messages">문자함에서 확인하기</a></div></div>` : '') + bad;
        if (!r.queued) keep = { toPhone: f.phones, text: f.text };
      }
    }

    if (path === '/send' || method === 'POST') {
      return html(pg('문자 보내기', renderSend({
        gws, deps,
        gwSel: Number(url.searchParams.get('gw')) || gws[0].id,
        toPhone: keep.toPhone ?? url.searchParams.get('to') ?? '',
        text: keep.text ?? '',
        notice
      })));
    }

    const dirParam = url.searchParams.get('dir');
    const dirFilter = ['in', 'out', 'scheduled'].includes(dirParam) ? dirParam : '';
    if (dirFilter === '' || dirFilter === 'in') { await markAllRead(db, user); unread = 0; }
    const body = await renderMessages(db, { gws, dirFilter, phoneFilter: normalizePhone(url.searchParams.get('phone') || '') });
    const live = '<script>setInterval(function(){var a=document.activeElement;if(a&&(a.tagName==="TEXTAREA"||a.tagName==="INPUT"))return;location.reload();},15000);</script>';
    return html(pg('문자함', body + live));
  }

  // 비밀번호 변경
  if (path === '/password') {
    const me = await first(db, `SELECT id, name, username, email, notify_replies FROM users WHERE id=?`, user.id);
    if (method === 'POST') {
      const f = form(await request.text());
      if (f.do === 'notify') {
        await run(db, `UPDATE users SET notify_replies=? WHERE id=?`, f.notify_replies === '1' ? 1 : 0, user.id);
        const now = await first(db, `SELECT id, name, username, email, notify_replies FROM users WHERE id=?`, user.id);
        return html(pg('내 계정', renderPassword('', { user: now, saved: '알림 설정을 저장했어요.' })));
      }
      const u = await first(db, `SELECT * FROM users WHERE id=?`, user.id);
      if (!(await verifyPassword(f.current || '', u.pass_hash)) || (f.next || '').length < 8)
        return html(pg('내 계정', renderPassword('현재 비밀번호가 틀리거나, 새 비밀번호가 8글자보다 짧아요.', { user: me })), 400);
      await run(db, `UPDATE users SET pass_hash=? WHERE id=?`, await hashPassword(f.next), user.id);
      await audit(db, user, 'password.change');
      return redirect('/');
    }
    return html(pg('내 계정', renderPassword('', { user: me })));
  }

  return html(pg('없음', '<p>페이지를 찾을 수 없습니다.</p>'), 404);
}

// 주기 작업: 발송 큐 처리 + 매 시 정각 파기/세션 정리 (Workers Cron, Node 서버 공용)
export async function runScheduled(env, whenMs = Date.now()) {
  try {
    if (await rateLimit(env.DB, 'auto:remind', 1, 4 * 60000)) await queueAutoReminders(env.DB, whenMs);
  } catch (e) {
    await recordError(env, 'cron', e, 'autoReminders');
  }
  try {
    await processQueue(env);
  } catch (e) {
    await recordError(env, 'cron', e, 'processQueue');
  }
  try {
    if (await rateLimit(env.DB, 'poll:delivery', 1, 110000)) await pollDelivery(env);
  } catch (e) {
    await recordError(env, 'cron', e, 'pollDelivery');
  }
  try {
    // 폰 상태 점검은 5분에 한 번 (실행 환경과 무관하게 호출 간격으로 제한)
    if (await rateLimit(env.DB, 'monitor:phones', 1, 4 * 60000)) await monitorPhones(env);
  } catch (e) {
    await recordError(env, 'monitor', e, 'monitorPhones');
  }
  if (new Date(whenMs).getUTCMinutes() === 0) {
    await run(env.DB, `DELETE FROM sessions WHERE expires_at<?`, Date.now());
    await run(env.DB, `DELETE FROM login_fail WHERE until<?`, Date.now());
    const n = await purgeExpired(env.DB);
    if (n) console.log(`보관기간 만료 캠페인 ${n}건 파기`);
  }
}

export async function handleRequest(request, env, ctx) {
  try {
    return await handle(request, env, ctx);
  } catch (e) {
    let p = '';
    try { p = new URL(request.url).pathname; } catch { /* ignore */ }
    await recordError(env, 'request', e, p);
    return html('internal error', 500);
  }
}

export default {
  fetch: handleRequest,
  // Cloudflare Cron Trigger (Workers 배포 시)
  scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduled(env, event.scheduledTime));
  }
};
