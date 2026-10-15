// 로그인 · 회원가입 · 이메일 인증 · 비밀번호 재설정 화면
import { esc, icon } from './views.js';

const DEPT_ORDER = ['임원실', '경영지원본부', '마케팅영업본부', 'CRM운영본부', '물류사업본부', '윌비모터스',
  'HR본부', 'FM사업부문', 'IT사업본부', '지사', '동부캐리어', '센터'];
export const sortDepartments = (deps) => [...deps].sort((a, b) => {
  const ia = DEPT_ORDER.indexOf(a.name), ib = DEPT_ORDER.indexOf(b.name);
  return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.name.localeCompare(b.name, 'ko');
});

const notice = (tone, body) => `<div class="notice ${tone}"${tone === 'warn' ? ' role="alert"' : ''}>${icon(tone === 'ok' ? 'check' : tone === 'warn' ? 'alert' : 'info')}<div>${body}</div></div>`;
const shell = (inner) => `<div class="auth-card">
  <div class="logo">${icon('send', 24)}</div>
  ${inner}
</div>`;

export function renderLogin(err = '', info = '', email = '') {
  return shell(`
    <h1>로그인</h1>
    <p class="muted" style="margin-bottom:20px">회사 이메일과 비밀번호로 로그인해 주세요.</p>
    ${info ? notice('ok', info) : ''}${err ? notice('warn', err) : ''}
    <form method="post" class="stack">
      <label>이메일<input name="email" type="text" inputmode="email" autocapitalize="none" spellcheck="false" autocomplete="username" value="${esc(email)}" placeholder="name@willvi.co.kr" autofocus required></label>
      <label>비밀번호<input name="password" type="password" autocomplete="current-password" required></label>
      <button class="btn big block">로그인</button>
    </form>
    <p class="muted" style="margin-top:20px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px">
      <a href="/forgot">비밀번호를 잊으셨나요?</a><span>처음이세요? <a href="/signup"><b>회원가입</b></a></span></p>`);
}

// 로그인했는데 이메일 인증 전일 때
export function renderUnverified(email, canResend = true) {
  return shell(`
    <h1>이메일 인증이 필요해요</h1>
    ${notice('info', `<b>${esc(email)}</b>로 보낸 인증 메일의 링크를 눌러 주세요. 메일이 안 보이면 스팸함도 확인해 주세요.`)}
    ${canResend ? `<form method="post" action="/verify/resend" class="stack">
      <input type="hidden" name="email" value="${esc(email)}">
      <button class="btn secondary block">인증 메일 다시 받기</button></form>` : '<p class="muted">메일 발송이 아직 설정되지 않았어요. 관리자에게 승인을 요청해 주세요.</p>'}
    <p style="margin-top:16px"><a href="/login">← 로그인으로</a></p>`);
}

export function renderSignup({ deps, domain, err = '', v = {} }) {
  return shell(`
    <h1>회원가입</h1>
    <p class="muted" style="margin-bottom:20px">회사 이메일(<b>@${esc(domain)}</b>)로 가입하고, 메일로 받은 링크로 인증하면 바로 사용할 수 있어요.</p>
    ${err ? notice('warn', esc(err)) : ''}
    <form method="post" class="stack" autocomplete="on">
      <label>이름<input name="name" autocomplete="name" value="${esc(v.name || '')}" required></label>
      <label>회사 이메일<input name="email" type="email" inputmode="email" autocomplete="email" value="${esc(v.email || '')}" placeholder="name@${esc(domain)}" required></label>
      <label>휴대폰 번호<input name="phone" type="tel" inputmode="tel" autocomplete="tel" value="${esc(v.phone || '')}" placeholder="010-1234-5678" required></label>
      <label>부서
        <select name="department_id" required>
          <option value="">부서를 골라 주세요</option>
          ${deps.map((d) => `<option value="${d.id}"${String(v.department_id) === String(d.id) ? ' selected' : ''}>${esc(d.name)}</option>`).join('')}
        </select></label>
      <label>비밀번호 <small>8글자 이상</small><input name="password" type="password" minlength="8" autocomplete="new-password" required></label>
      <label>비밀번호 확인<input name="password2" type="password" minlength="8" autocomplete="new-password" required></label>
      <button class="btn big block">가입하고 인증 메일 받기</button>
    </form>
    <p class="muted" style="margin-top:20px">이미 계정이 있으세요? <a href="/login"><b>로그인</b></a></p>`);
}

export function renderSignupDone({ email, mailed, existing = false }) {
  if (existing) {
    return shell(`<h1>메일을 확인해 주세요</h1>
      ${notice('info', `<b>${esc(email)}</b>로 가입 안내를 처리했어요. 이미 가입한 메일이라면 바로 로그인해 주세요.`)}
      <p><a class="btn block" href="/login">로그인하기</a></p>`);
  }
  return shell(`<h1>${mailed ? '인증 메일을 보냈어요' : '가입 신청이 접수됐어요'}</h1>
    ${mailed
      ? notice('ok', `<b>${esc(email)}</b>로 인증 메일을 보냈어요.<br>메일의 링크를 누르면 가입이 끝나요. 메일이 안 보이면 스팸함도 확인해 주세요. (24시간 안에 눌러 주세요)`)
      : notice('warn', `인증 메일을 보내지 못했어요. <b>관리자에게 승인을 요청</b>해 주세요. 승인되면 <b>${esc(email)}</b>와(과) 비밀번호로 로그인할 수 있어요.`)}
    <p><a class="btn secondary block" href="/login">로그인 화면으로</a></p>`);
}

export function renderForgot({ err = '', sent = false, configured = true }) {
  return shell(`
    <h1>비밀번호 다시 정하기</h1>
    <p class="muted" style="margin-bottom:20px">가입한 회사 이메일을 적으면 새 비밀번호를 정할 수 있는 링크를 보내 드려요.</p>
    ${sent ? notice('ok', configured
      ? '가입된 이메일이라면 메일을 보냈어요. 메일의 링크에서 새 비밀번호를 정해 주세요. (1시간 안에)'
      : '메일 발송이 아직 설정되지 않았어요. 관리자에게 비밀번호 변경을 요청해 주세요.') : ''}
    ${err ? notice('warn', esc(err)) : ''}
    <form method="post" class="stack">
      <label>회사 이메일<input name="email" type="email" inputmode="email" autocomplete="email" placeholder="name@willvi.co.kr" required></label>
      <button class="btn big block">재설정 메일 받기</button>
    </form>
    <p style="margin-top:16px"><a href="/login">← 로그인으로</a></p>`);
}

export function renderReset({ token, err = '' }) {
  return shell(`
    <h1>새 비밀번호</h1>
    ${err ? notice('warn', esc(err)) : ''}
    <form method="post" class="stack">
      <input type="hidden" name="token" value="${esc(token)}">
      <label>새 비밀번호 <small>8글자 이상</small><input name="password" type="password" minlength="8" autocomplete="new-password" autofocus required></label>
      <label>비밀번호 확인<input name="password2" type="password" minlength="8" autocomplete="new-password" required></label>
      <button class="btn big block">비밀번호 바꾸기</button>
    </form>`);
}

export function renderLinkInvalid() {
  return shell(`<h1>링크를 사용할 수 없어요</h1>
    ${notice('warn', '링크가 만료되었거나 이미 사용했어요. 로그인 화면에서 인증 메일을 다시 받아 주세요.')}
    <p><a class="btn block" href="/login">로그인 화면으로</a></p>`);
}
