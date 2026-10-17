// 문자 관리 시스템 화면 (홈, 문자 보내기, 문자함, 면접 안내 목록/만들기/상세, 로그인, 비밀번호, 기록)
// 화면 구성 원칙: 한 화면에 하나의 주요 동작, 숫자는 먼저, 설명은 짧게, 모든 표시값은 ui.js 형식을 따른다.
import { all, first } from './d1.js';
import { esc, fmtTime, icon } from './views.js';
import { OUTCOMES } from './reminders.js';
import { unreadCount } from './delivery.js';
import { inboxBreakdown, agentStatus } from './mail-intake.js';
import { agentIdle, stalledText } from './workspace.js';
import { outcomeSection } from './outcome-view.js';
import { monthStats, renderSavingsCard } from './savings.js';
import { phoneWaitBadge, colHead, colCount, fmtPhone, fmtWhen, badge, messageBadge, responseBar, pageHeader, tableWrap, stat, emptyState } from './ui.js';

const DAY = 86400000;
const KST = 9 * 3600000;
// 한국 시간 기준 오늘 0시(epoch ms)
export const kstDayStart = (now = Date.now()) => Math.floor((now + KST) / DAY) * DAY - KST;
const idList = (arr) => arr.map(() => '?').join(',');
const DOW = ['일', '월', '화', '수', '목', '금', '토'];
const kstDateLabel = (now = Date.now()) => {
  const d = new Date(now + KST);
  return `${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일 ${DOW[d.getUTCDay()]}요일`;
};

export const CAMPAIGN_STATE = {
  draft: '아직 안 보냄', scheduled: '예약됨', sending: '보내는 중', done: '모두 보냄', cancelled: '취소함'
};
const campaignBadge = (r) => (r.purged_at ? badge('mute', '개인정보 지움') : badge(r.status));

// ---- 예약 시간 입력 (한국 시간) ----
export const schedulePicker = (name = 'when', required = false) => `
  <div class="schedule">
    <input type="datetime-local" name="${name}" id="${name}-input"${required ? ' required' : ''} aria-label="예약 날짜와 시간">
    <div class="quick">
      <button type="button" class="small" data-plus="60">1시간 뒤</button>
      <button type="button" class="small" data-tomorrow="9">내일 오전 9시</button>
      <button type="button" class="small" data-tomorrow="14">내일 오후 2시</button>
    </div>
    <small>한국 시간 기준이에요. 정해진 시간 <b>1분 안</b>에 나가요.</small>
  </div>`;

export const SCHEDULE_JS = `<script>
(function () {
  function fmt(d) { var p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()); }
  document.addEventListener('click', function (e) {
    var b = e.target.closest('.quick button'); if (!b) return;
    var input = b.closest('.schedule').querySelector('input[type=datetime-local]'); var d = new Date();
    if (b.dataset.plus) d = new Date(d.getTime() + Number(b.dataset.plus) * 60000);
    if (b.dataset.tomorrow) { d.setDate(d.getDate() + 1); d.setHours(Number(b.dataset.tomorrow), 0, 0, 0); }
    input.value = fmt(d); input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  document.querySelectorAll('input[type=datetime-local]').forEach(function (i) { i.min = fmt(new Date()); });
  // "예약해서 보낼게요"를 고를 때만 시간 입력을 보여 준다
  document.querySelectorAll('[data-when-choice]').forEach(function (box) {
    var target = box.querySelector('.when-picker');
    function sync() { var m = box.querySelector('input[name=send_mode]:checked'); target.hidden = !(m && m.value === 'schedule'); }
    box.addEventListener('change', sync); sync();
  });
})();
</script>`;

// 보내는 시간 선택(지금/예약) 공통 조각. firstLabel/firstValue 로 첫 선택지를 바꿀 수 있다.
const whenChoice = ({ firstValue, firstLabel, firstHint = '' }) => `
  <fieldset data-when-choice>
    <legend>언제 보낼까요?</legend>
    <label class="check"><input type="radio" name="send_mode" value="${firstValue}" checked> <span>${firstLabel}${firstHint ? ` <small>${firstHint}</small>` : ''}</span></label>
    <label class="check"><input type="radio" name="send_mode" value="schedule"> <span>예약해서 보낼게요</span></label>
    <div class="when-picker" hidden>${schedulePicker('when')}</div>
  </fieldset>`;

// ---------------- 로그인 / 비밀번호 / 기록 ----------------
export function renderLogin(err = '') {
  return `<div class="auth-card">
    <div class="logo">${icon('send', 24)}</div>
    <h1>문자 관리</h1>
    <p class="muted" style="margin-bottom:24px">문자를 보내고, 받고, 예약해요. 계정으로 로그인해 주세요.</p>
    ${err ? `<div class="notice warn" role="alert">${icon('alert')}<div>${esc(err)}</div></div>` : ''}
    <form method="post" class="stack">
      <label>아이디<input name="username" autocomplete="username" autofocus required></label>
      <label>비밀번호<input name="password" type="password" autocomplete="current-password" required></label>
      <button class="btn big block">로그인</button>
    </form>
  </div>`;
}

export function renderPassword(err = '', { user = null, saved = '' } = {}) {
  return `${pageHeader({ title: '내 계정', desc: user ? `${esc(user.name || user.username)}${user.email ? ' · ' + esc(user.email) : ''}` : '' })}
    <div class="col">
      ${err ? `<div class="notice warn" role="alert">${icon('alert')}<div>${esc(err)}</div></div>` : ''}
      ${saved ? `<div class="notice ok" role="status">${icon('check')}<div>${esc(saved)}</div></div>` : ''}
      ${user ? `<form method="post" class="card stack" style="margin-bottom:16px">
        <input type="hidden" name="do" value="notify">
        <h3>알림</h3>
        <label class="check"><input type="checkbox" name="notify_replies" value="1"${user.notify_replies ? ' checked' : ''}> <span>새 답장이 오면 메일로 알려 주세요 <small>내용은 메일에 넣지 않고 확인 링크만 보내요 (5분에 한 번)</small></span></label>
        <div class="form-actions"><button class="btn secondary">알림 설정 저장</button></div>
      </form>` : ''}
      <h3 style="margin:8px 0 12px">비밀번호 바꾸기</h3>
      <form method="post" class="card stack">
        <label>현재 비밀번호<input type="password" name="current" autocomplete="current-password" required></label>
        <label>새 비밀번호 <small>8글자 이상</small><input type="password" name="next" autocomplete="new-password" minlength="8" required></label>
        <div class="form-actions"><button class="btn">바꾸기</button></div>
      </form>
    </div>`;
}

export function renderAudit(rows) {
  return `${pageHeader({ title: '기록', desc: '로그인, 발송, 설정 변경 등 최근 300건이에요. (개인정보는 남기지 않아요)' })}
    ${tableWrap(`<table class="cards"><thead><tr><th>시각</th><th>사용자</th><th>동작</th><th>내용</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td data-label="시각" class="nowrap">${fmtWhen(r.at)}</td><td data-label="사용자">${esc(r.username || '-')}</td>
        <td data-label="동작">${esc(r.action)}</td><td data-label="내용">${esc(r.detail)}</td></tr>`).join('')}</tbody></table>`)}`;
}

// ---------------- 홈 ----------------
export async function renderHome(db, user, deps) {
  const depIds = deps.map((d) => d.id);
  const today = kstDayStart();
  let sentToday = 0, recvToday = 0, scheduled = 0, review = 0, gwCount = 0;
  let recent = [], camps = [], phones = [];
  let noreply7 = 0;
  const unread = await unreadCount(db, user).catch(() => 0);
  const inbox = await inboxBreakdown(db, { id: user.id, isSuper: user.role === 'super' }).catch(() => ({ pending: 0, ready: 0, waiting: 0 }));
  const agent = inbox.waiting ? await agentStatus(db, user.id).catch(() => ({ hasKey: true, lastUsedAt: Date.now() })) : null;
  const stalled = !!(agent && agentIdle(agent));

  if (depIds.length) {
    const dph = idList(depIds);
    const gwIds = (await all(db, `SELECT id FROM gateways WHERE active=1 AND department_id IN (${dph})`, ...depIds)).map((r) => r.id);
    gwCount = gwIds.length;
    phones = await all(db, `SELECT name, health, health_note, last_seen_at FROM gateways WHERE active=1 AND department_id IN (${dph})`, ...depIds);
    if (gwIds.length) {
      const g = idList(gwIds);
      const m = await first(db, `SELECT COUNT(*) n FROM messages WHERE gateway_id IN (${g}) AND status='sent' AND at>=?`, ...gwIds, today);
      const c = await first(db,
        `SELECT COUNT(*) n FROM candidates ca JOIN campaigns k ON k.id=ca.campaign_id
         WHERE k.gateway_id IN (${g}) AND ca.sent_at>=? AND ca.status IN ('sent','attending','absent','unclear')`, ...gwIds, today);
      sentToday = m.n + c.n;
      recvToday = (await first(db, `SELECT COUNT(*) n FROM inbound WHERE gateway_id IN (${g}) AND received_at>=?`, ...gwIds, today)).n;
      const ms = (await first(db, `SELECT COUNT(*) n FROM messages WHERE gateway_id IN (${g}) AND status IN ('scheduled','sending')`, ...gwIds)).n;
      const cs = (await first(db, `SELECT COUNT(*) n FROM campaigns WHERE gateway_id IN (${g}) AND status='scheduled'`, ...gwIds)).n;
      scheduled = ms + cs;
      recent = await all(db, `SELECT sender, message, received_at FROM inbound WHERE gateway_id IN (${g}) ORDER BY id DESC LIMIT 5`, ...gwIds);
    }
    review = (await first(db,
      `SELECT COUNT(*) n FROM candidates ca JOIN campaigns k ON k.id=ca.campaign_id
       WHERE k.department_id IN (${dph}) AND ca.status='unclear'`, ...depIds)).n;
    noreply7 = (await first(db,
      `SELECT COUNT(*) n FROM candidates ca JOIN campaigns k ON k.id=ca.campaign_id
        WHERE k.department_id IN (${dph}) AND ca.status='sent' AND ca.sent_at>=?`, ...depIds, Date.now() - 7 * DAY)).n;
    camps = await all(db,
      `SELECT k.id, k.name, k.status, k.purged_at, k.scheduled_at,
         (SELECT COUNT(*) FROM candidates WHERE campaign_id=k.id) total,
         (SELECT COUNT(*) FROM candidates WHERE campaign_id=k.id AND status='attending') attending,
         (SELECT COUNT(*) FROM candidates WHERE campaign_id=k.id AND status='absent') absent,
         (SELECT COUNT(*) FROM candidates WHERE campaign_id=k.id AND status='unclear') unclear,
         (SELECT COUNT(*) FROM candidates WHERE campaign_id=k.id AND status='sent') noreply,
         (SELECT COALESCE(NULLIF(name,''), username) FROM users WHERE id=k.created_by) author
       FROM campaigns k WHERE k.department_id IN (${dph}) ORDER BY k.id DESC LIMIT 3`, ...depIds);
  }

  const savings = renderSavingsCard(await monthStats(db, depIds));

  // 사업장·발송일별 현황 (최근 30일)
  let board = [];
  if (depIds.length) {
    board = await all(db,
      `SELECT date((ca.sent_at + 32400000) / 1000, 'unixepoch') day, ca.site site,
         COUNT(*) sent,
         SUM(ca.status='attending') attending, SUM(ca.status='absent') absent,
         SUM(ca.status='unclear') unclear, SUM(ca.status='sent') noreply,
         SUM(ca.outcome='showed') showed, SUM(ca.outcome='noshow') noshow
       FROM candidates ca JOIN campaigns k ON k.id=ca.campaign_id
       WHERE k.department_id IN (${idList(depIds)}) AND ca.sent_at IS NOT NULL AND ca.sent_at>=?
         AND ca.status IN ('sent','attending','absent','unclear')
       GROUP BY day, ca.site ORDER BY day DESC, ca.site LIMIT 120`, ...depIds, today - 29 * DAY);
  }
  const bsum = board.reduce((a, r) => ({ showed: a.showed + r.showed, noshow: a.noshow + r.noshow, sent: a.sent + r.sent, attending: a.attending + r.attending, absent: a.absent + r.absent, unclear: a.unclear + r.unclear, noreply: a.noreply + r.noreply }),
    { showed: 0, noshow: 0, sent: 0, attending: 0, absent: 0, unclear: 0, noreply: 0 });
  const dayLabel = (d) => { const [, m, dd] = d.split('-'); return `${Number(m)}/${Number(dd)}`; };
  const boardHtml = board.length ? tableWrap(`<table><thead><tr><th>보낸 날</th><th>사업장</th><th class="num">보냄</th><th class="num">${colHead('참석', 'ok')}</th><th class="num">${colHead('불참', 'no')}</th><th class="num">${colHead('확인 필요', 'review')}</th><th class="num">${colHead('미회신', 'wait')}</th><th class="num">${colHead('출석', 'ok')}</th><th class="num">${colHead('노쇼', 'no')}</th></tr></thead><tbody>
      ${board.map((r) => `<tr><td>${dayLabel(r.day)}</td><td>${esc(r.site)}</td><td class="num">${r.sent}</td><td class="num">${colCount(r.attending, 'ok')}</td><td class="num">${colCount(r.absent, 'no')}</td><td class="num">${colCount(r.unclear, 'review')}</td><td class="num">${colCount(r.noreply, 'wait')}</td><td class="num">${colCount(r.showed, 'ok')}</td><td class="num">${colCount(r.noshow, 'no')}</td></tr>`).join('')}
      </tbody><tfoot><tr><th colspan="2">합계</th><th class="num">${bsum.sent}</th><th class="num">${colCount(bsum.attending, 'ok')}</th><th class="num">${colCount(bsum.absent, 'no')}</th><th class="num">${colCount(bsum.unclear, 'review')}</th><th class="num">${colCount(bsum.noreply, 'wait')}</th><th class="num">${colCount(bsum.showed, 'ok')}</th><th class="num">${colCount(bsum.noshow, 'no')}</th></tr></tfoot></table>`, 'hint')
    : emptyState({ title: '아직 보낸 면접 안내가 없어요', desc: '면접 안내를 보내면 사업장·날짜별 참석/불참/미회신이 여기에 모여요.' });

  const phoneNotice = gwCount
    ? ''
    : `<div class="notice warn" role="alert">${icon('alert')}<div><b>문자를 보낼 폰이 아직 연결되지 않았어요.</b><br>${
      user.role === 'super' ? '<a href="/admin">설정에서 폰을 연결하세요.</a> · <a href="/help/phone">폰 설치 안내</a>' : '관리자에게 폰 연결을 부탁하세요. · <a href="/help/phone">폰 설치 안내</a>'}</div></div>`;

  const todoItems = [
    review ? `<li><a href="/campaigns"><span class="n review">${review}</span><span class="t">확인이 필요한 답장<small>참석인지 불참인지 애매해서 사람이 봐야 해요</small></span><span class="go" aria-hidden="true">›</span></a></li>` : '',
    inbox.ready ? `<li><a href="/applicants/inbox?f=ready"><span class="n ok">${inbox.ready}</span><span class="t">등록할 수 있는 새 지원<small>연락처가 채워졌어요. 확인하고 지원자로 등록해요</small></span><span class="go" aria-hidden="true">›</span></a></li>` : '',
    stalled ? `<li><a href="/applicants/inbox/connect"><span class="n wait">${inbox.waiting}</span><span class="t">연락처를 기다리는 새 지원<small>${esc(stalledText(agent))}</small></span><span class="go" aria-hidden="true">›</span></a></li>` : '',
    inbox.pending - inbox.ready - (stalled ? inbox.waiting : 0) > 0 ? `<li><a href="/applicants/inbox"><span class="n info">${inbox.pending - inbox.ready - (stalled ? inbox.waiting : 0)}</span><span class="t">${inbox.ready || stalled ? '그 밖의 새 지원' : '새 지원이 도착했어요'}<small>원가중심점을 정하면 연락처를 자동으로 가져와요</small></span><span class="go" aria-hidden="true">›</span></a></li>` : '',
    unread ? `<li><a href="/messages?dir=in"><span class="n info">${unread}</span><span class="t">안 읽은 받은 문자<small>문자함에서 확인해요</small></span><span class="go" aria-hidden="true">›</span></a></li>` : '',
    noreply7 ? `<li><a href="/campaigns"><span class="n wait">${noreply7}</span><span class="t">아직 답이 없는 사람 (최근 7일)<small>면접 안내에서 "답 없는 사람에게 다시 보내기"를 쓸 수 있어요</small></span><span class="go" aria-hidden="true">›</span></a></li>` : '',
    scheduled ? `<li><a href="/messages?dir=scheduled"><span class="n mute">${scheduled}</span><span class="t">예약 대기 중인 발송<small>정해 둔 시간에 나가요</small></span><span class="go" aria-hidden="true">›</span></a></li>` : ''
  ].filter(Boolean);
  const todoHtml = todoItems.length
    ? `<ul class="todo">${todoItems.join('')}</ul>`
    : `<div class="todo-done">${icon('check', 20)}<span>지금 처리할 일이 없어요.</span></div>`;

  return `${pageHeader({ title: '홈', desc: `${kstDateLabel()} 현황이에요.`,
    actions: `<a class="btn" href="/send">${icon('send', 18)}문자 보내기</a><a class="btn secondary" href="/campaigns/new">${icon('clipboard', 18)}면접 안내 만들기</a>` })}
    ${phoneNotice}
    ${phoneHealthNotices(phones)}

    <section class="section">
      <div class="shead"><h2>오늘 할 일</h2></div>
      <div class="card" style="padding:0">${todoHtml}</div>
    </section>

    <section class="section">
      <div class="shead"><h2>면접 안내 현황</h2><span class="muted">최근 30일 · 사업장·보낸 날별</span></div>
      <div class="card" style="padding:0">${boardHtml}</div>
    </section>

    <section class="section">
      <div class="shead"><h2>면접 안내</h2><a href="/campaigns">전체 보기</a></div>
      <div class="card" style="padding:0">
        ${camps.length ? camps.map((r) => campaignCard(r)).join('')
          : emptyState({ title: '아직 면접 안내가 없어요', desc: '대상자 명단을 올리면 안내 문자를 한꺼번에 보내고 참석 여부를 모아 볼 수 있어요.',
              action: `<p style="margin-top:16px"><a class="btn" href="/campaigns/new">면접 안내 만들기</a></p>` })}
      </div>
    </section>

    <section class="section">
      <div class="shead"><h2>최근 받은 문자</h2><a href="/messages?dir=in">전체 보기</a></div>
      <div class="card" style="padding:0">
        ${recent.length ? `<ul class="feed">${recent.map((r) => `<li>
          <span class="who">${esc(fmtPhone(r.sender))}</span>
          <span class="what">${esc(r.message)}</span>
          <span class="when">${fmtWhen(r.received_at)}</span>
          <a href="/send?to=${encodeURIComponent(r.sender)}" aria-label="${esc(fmtPhone(r.sender))}에게 답장">${icon('reply', 18)}</a></li>`).join('')}</ul>`
          : emptyState({ title: '아직 받은 문자가 없어요', desc: '문자가 오면 여기에 바로 보여요.' })}
      </div>
    </section>

    <section class="section">
      <div class="shead"><h2>오늘의 숫자</h2></div>
      <div class="stats">
        ${stat({ value: sentToday, label: '오늘 보낸 문자' })}
        ${stat({ value: recvToday, label: '오늘 받은 문자', href: '/messages?dir=in' })}
        ${stat({ value: scheduled, label: '예약 대기', href: '/messages?dir=scheduled' })}
        ${stat({ value: review, label: '확인이 필요한 답장', tone: review ? 'review' : '', href: '/campaigns' })}
      </div>
    </section>

    ${savings}`;
}

// 폰 상태 알림: 문제가 있을 때만 눈에 띄게, 정상이면 한 줄로
function phoneHealthNotices(phones) {
  if (!phones.length) return '';
  const bad = phones.filter((p) => p.health === 'down');
  const warn = phones.filter((p) => p.health === 'warn');
  const out = [];
  for (const p of bad) out.push(`<div class="notice warn" role="alert">${icon('alert')}<div><b>${esc(p.name)} 상태를 확인해 주세요.</b><br>${esc(p.health_note || '폰이 응답하지 않아요.')}</div></div>`);
  for (const p of warn) out.push(`<div class="notice info">${icon('info')}<div><b>${esc(p.name)}</b> ${esc(p.health_note || '응답이 늦어요.')}${p.last_seen_at ? ` <span class="muted">(마지막 응답 ${fmtWhen(p.last_seen_at)})</span>` : ''}</div></div>`);
  if (!out.length) {
    const seen = phones.map((p) => p.last_seen_at).filter(Boolean).sort().pop();
    if (phones.every((p) => p.health === 'ok')) out.push(`<p class="muted" style="margin:-8px 0 16px;font-size:14px">${icon('check', 14)} 문자 보내는 폰 정상${seen ? ' · 마지막 응답 ' + fmtWhen(seen) : ''}</p>`);
  }
  return out.join('');
}

function campaignCard(r) {
  const replied = r.attending + r.absent + r.unclear;
  const delivered = replied + r.noreply;
  return `<a class="camp" href="/campaigns/${r.id}">
    <div class="top"><b>${esc(r.name)}</b>${campaignBadge(r)}</div>
    ${responseBar({ attending: r.attending, absent: r.absent, unclear: r.unclear, noreply: r.noreply })}
    <div class="meta">${r.author ? `${esc(r.author)} · ` : ''}${r.status === 'scheduled' ? `${fmtWhen(r.scheduled_at)} 발송 예정 · ` : ''}대상 ${r.total}명${delivered ? ` · 회신 ${replied}명 · 참석 ${r.attending} · 불참 ${r.absent}` : ''}</div>
  </a>`;
}

// ---------------- 면접 안내 목록 ----------------
export async function renderCampaignList(db, user, deps) {
  const depIds = deps.map((d) => d.id);
  const rows = depIds.length
    ? await all(db, `SELECT k.id, k.name, k.status, k.purged_at, k.scheduled_at,
          (SELECT COUNT(*) FROM candidates WHERE campaign_id=k.id) total,
          (SELECT COUNT(*) FROM candidates WHERE campaign_id=k.id AND status='attending') attending,
          (SELECT COUNT(*) FROM candidates WHERE campaign_id=k.id AND status='absent') absent,
          (SELECT COUNT(*) FROM candidates WHERE campaign_id=k.id AND status='unclear') unclear,
          (SELECT COUNT(*) FROM candidates WHERE campaign_id=k.id AND status='sent') noreply,
          (SELECT COALESCE(NULLIF(name,''), username) FROM users WHERE id=k.created_by) author
        FROM campaigns k WHERE k.department_id IN (${idList(depIds)}) ORDER BY k.id DESC LIMIT 200`, ...depIds)
    : [];
  return `${pageHeader({ title: '면접 안내', desc: '대상자 명단으로 안내 문자를 한꺼번에 보내고, 참석·불참 답장을 사업장별로 모아 봐요.',
    actions: `<a class="btn" href="/campaigns/new">${icon('plus', 18)}새 면접 안내</a>` })}
    <div class="card" style="padding:0">
      ${rows.length ? rows.map((r) => campaignCard(r)).join('')
        : emptyState({ title: '아직 만든 면접 안내가 없어요', desc: '오른쪽 위 버튼으로 시작해 보세요.' })}
    </div>`;
}

// ---------------- 면접 안내 만들기 ----------------
export function renderCampaignNew({ gws, deps, today, defaultTemplate, slotTemplate = '', prefill = null }) {
  const many = !!prefill;
  const prefillNotice = prefill ? `<div class="notice ok">${icon('check')}<div><b>지원자 관리에서 고른 ${prefill.count}명을 명단에 채웠어요.</b><br>
      면접일시가 모두 같으면 아래 <b>"모두 같은 면접일시"</b>에 한 번만 적으세요. 사람마다 다르면 명단의 마지막 칸에 적어요.${prefill.noSite ? `<br>${prefill.noSite}명은 원가중심점이 없어요. 아래 "사업장" 칸에 적으면 함께 적용돼요.` : ''}</div></div>
    ${prefill.blacklisted.length ? `<div class="notice warn" role="status">${icon('alert')}<div><b>참고: 고른 사람 중 블랙리스트 ${prefill.blacklisted.length}명</b> — ${prefill.blacklisted.slice(0, 10).map(esc).join(', ')}${prefill.blacklisted.length > 10 ? ' 외' : ''}. 보내지 않으려면 명단에서 그 줄을 지우세요.</div></div>` : ''}` : '';
  return `${pageHeader({ title: '면접 안내 만들기', back: { href: prefill ? '/applicants' : '/campaigns', label: prefill ? '지원자' : '면접 안내' },
    desc: '명단을 올리면 안내 문자가 준비돼요. <b>올린 뒤에 보내기를 눌러야</b> 문자가 나가니 안심하세요.' })}
    ${prefillNotice}
    <form method="post" class="col">
      <input type="hidden" name="name" value="면접 안내 ${esc(today)}">

      <div class="step"><div class="num">1</div><div class="body">
        <h3>대상자 명단 <small>누구에게 보낼까요?</small></h3>
        <fieldset style="margin-bottom:16px">
          <legend>보낼 대상</legend>
          <label class="check"><input type="radio" name="mode" value="one"${many ? '' : ' checked'}> <span>한 명에게만</span></label>
          <label class="check"><input type="radio" name="mode" value="many"${many ? ' checked' : ''}> <span>여러 명 (엑셀 붙여넣기 · 파일 · 지원자 관리에서 고르기)</span></label>
        </fieldset>
        <div id="mode-one">
          <label>사업장(원가중심점) <input name="one_site" placeholder="예: 아마노코리아(현장HR)"></label>
          <label style="margin-top:12px">이름 <input name="one_name" placeholder="홍길동" autocomplete="off"></label>
          <label style="margin-top:12px">휴대폰 번호 <input name="one_phone" type="tel" inputmode="tel" placeholder="010-1234-5678" autocomplete="off"></label>
          <label style="margin-top:12px" class="fixed-only">면접일시 <input name="one_when" placeholder="10/20 14:00" autocomplete="off"></label>
        </div>
        <div id="mode-many" hidden>
        <p class="muted" style="margin-bottom:8px">엑셀에서 표를 <b>드래그해서 복사(Ctrl+C)</b>한 뒤, 아래 칸에 <b>붙여넣기(Ctrl+V)</b> 하세요. 제목 줄은 있어도 없어도 돼요.</p>
        <textarea name="csv" id="csv" rows="7" aria-label="명단 붙여넣기" placeholder="아마노코리아(현장HR)&#9;홍길동&#9;010-1234-5678&#9;10/20 14:00&#10;아마노코리아(현장HR)&#9;김영희&#9;010-2345-6789&#9;10/20 14:30">${prefill ? esc(prefill.csv) : ''}</textarea>
        <div id="paste-preview" class="muted" style="margin-top:8px;font-size:14px" aria-live="polite"></div>
        <p class="muted" style="margin:10px 0 0;font-size:14px">열 순서는 <b>사업장 · 이름 · 전화번호 · 면접일시</b>를 권해요. 제목 줄이 있으면 순서가 달라도 알아봐요.
          <br>지원자 관리 → 지원자에서 사람을 골라 <b>"면접 안내 만들기"</b>를 누르면 명단이 저절로 채워져요.</p>
        <label style="margin-top:16px" class="fixed-only">모두 같은 면접일시
          <small>명단에 면접일시가 비어 있는 사람에게 넣어요</small>
          <input name="default_when" placeholder="예: 10/20 14:00" autocomplete="off"></label>
        <label style="margin-top:16px">사업장(원가중심점)
          <small>붙여넣은 표에 사업장 열이 없다면 여기에 적으세요. 전체에 적용돼요.</small>
          <input name="default_site" placeholder="예: 아마노코리아(현장HR)"></label>
        <p class="muted" style="margin-top:8px;font-size:14px">사업장 이름은 <b>문자에는 들어가지 않고</b>, 사업장별 회신 현황에만 쓰여요.</p>
        <details style="margin-top:16px"><summary>파일(CSV)로 올리고 싶다면</summary>
          <div style="margin-top:12px">
            <div class="dropzone"><input type="file" id="f" accept=".csv,.txt" aria-label="명단 파일 선택"><p id="fname" class="muted" style="margin-top:8px">아직 고른 파일이 없어요.</p></div>
            <p style="margin:12px 0"><a class="btn secondary small" href="/template.csv">${icon('download', 16)}양식 받기</a></p>
          </div>
        </details>
        </div>
      </div></div>

      <div class="step"><div class="num">2</div><div class="body">
        <h3>어떻게 안내할까요?</h3>
        <fieldset>
          <legend class="sr-only">안내 방식</legend>
          <label class="check"><input type="radio" name="kind" value="fixed" checked> <span><b>정해진 면접일시를 알려요</b><br><small>"참석" / "불참"으로 답장을 받아요.</small></span></label>
          <label class="check" style="margin-top:8px"><input type="radio" name="kind" value="slots"> <span><b>면접 일정을 골라 달라고 해요</b><br><small>후보 일정을 번호로 보내고, 답장한 번호가 그 사람의 면접일시가 돼요. 고르면 확정 문자가 저절로 가요.</small></span></label>
        </fieldset>
        <div id="slotbox" hidden style="margin-top:12px">
          <label>고를 수 있는 일정 <small>한 줄에 하나씩, 최대 9개. 문자에는 "1) 10/21(화) 14:00"처럼 번호가 붙어요.</small>
            <textarea name="slots" id="slots" rows="4" placeholder="10/21(화) 14:00&#10;10/22(수) 10:00&#10;10/23(목) 15:00"></textarea></label>
          <p class="muted" style="margin-top:8px;font-size:14px">일정을 고르는 방식에서는 명단의 면접일시 칸은 쓰지 않아요. 리마인드를 받으려면 일정을 <b>"10/21 14:00"</b>처럼 날짜와 시간으로 적어 주세요.</p>
        </div>
      </div></div>

      <div class="step"><div class="num">3</div><div class="body">
        <h3>보낼 문자</h3>
        <p class="muted" style="margin-bottom:12px">{이름}, {면접일시} 자리에는 사람마다 맞는 정보가 들어가요. 일정을 고르는 방식이면 {일정목록} 자리에 번호 붙은 일정이 들어가요. 줄바꿈은 그대로 반영돼요.</p>
        <textarea name="template" id="template" rows="8" aria-label="문자 내용">${esc(defaultTemplate)}</textarea>
        <p style="margin:14px 0 6px"><b>미리보기</b> <small>홍길동님에게 갈 문자</small></p>
        <div id="preview" class="preview"></div>
      </div></div>

      <div class="step"><div class="num">4</div><div class="body">
        <h3>보내기</h3>
        ${gws.length > 1 ? `<label>보낼 폰 <select name="gateway_id">${gws.map((g) =>
          `<option value="${g.id}">${esc(deps.find((d) => d.id === g.department_id)?.name || '')} / ${esc(g.name)}</option>`).join('')}</select></label>`
          : `<input type="hidden" name="gateway_id" value="${gws[0].id}"><p class="muted" style="margin-bottom:12px">보내는 폰: ${esc(gws[0].name)}</p>`}
        ${whenChoice({ firstValue: 'manual', firstLabel: '올린 다음에 제가 직접 보낼게요' })}
        <fieldset style="margin-top:16px;display:grid;gap:12px">
          <legend><b>자동으로 보내는 문자</b> <small>면접일시를 "10/20 14:00"처럼 날짜와 시간으로 적어야 시각을 맞출 수 있어요</small></legend>
          <label class="check"><input type="checkbox" name="remind_prev" value="1" checked> <span><b>면접 전날 오후 5시에 알려 주기</b><br><small>"참석"이라고 답한 사람에게 한 번. 노쇼를 줄이는 데 가장 효과가 커요.</small></span></label>
          <label class="check"><input type="checkbox" name="auto_remind" value="1" checked> <span><b>면접 당일 아침 8시에 알려 주기</b><br><small>"참석"이라고 답한 사람에게 한 번.</small></span></label>
          <label class="check"><input type="checkbox" name="auto_followup" value="1" checked> <span><b>답이 없으면 하루 뒤 한 번 더 보내기</b><br><small>같은 안내를 한 번만 더 보내요. 면접이 가까우면 면접 3시간 전에 보내요. 밤(21시~9시)에는 보내지 않아요.</small></span></label>
        </fieldset>
        <details style="margin-top:12px"><summary>더 설정하기</summary>
          <label style="margin-top:8px">개인정보 보관 기간(일) <small>지나면 이름과 전화번호가 저절로 지워져요</small>
            <input name="retention_days" type="number" value="90" min="1" max="3650"></label></details>
        <div class="form-actions"><button class="btn big">명단 올리기</button></div>
      </div></div>
    </form>
    ${SCHEDULE_JS}
    <script>
    (function () {
      var t = document.getElementById('template'), p = document.getElementById('preview'), sl = document.getElementById('slots');
      var TPL = { fixed: ${JSON.stringify(defaultTemplate).replace(/</g, '\\u003c')}, slots: ${JSON.stringify(slotTemplate).replace(/</g, '\\u003c')} };
      function slotLines() {
        var xs = sl.value.split('\\n').map(function (x) { return x.trim(); }).filter(Boolean).slice(0, 9);
        return (xs.length ? xs : ['10/21(화) 14:00', '10/22(수) 10:00']).map(function (x, i) { return (i + 1) + ') ' + x; }).join('\\n');
      }
      function show() {
        var s = t.value.split('{일정목록}').join(slotLines()).split('{이름}').join('홍길동').split('{면접일시}').join('10/20 14:00').split('{사업장}').join('');
        p.textContent = s.split('\\n').map(function (l) { return l.replace(/[ \\t]+/g, ' ').trim(); }).join('\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
      }
      t.addEventListener('input', show); sl.addEventListener('input', show); show();
      function kind() {
        var k = document.querySelector('input[name=kind]:checked').value;
        document.getElementById('slotbox').hidden = k !== 'slots';
        sl.required = k === 'slots';
        document.querySelectorAll('.fixed-only').forEach(function (el) { el.hidden = k === 'slots'; });
        // 손대지 않은 기본 문구면 방식에 맞는 문구로 바꾼다
        if (t.value.trim() === TPL.fixed.trim() || t.value.trim() === TPL.slots.trim()) t.value = TPL[k];
        show();
      }
      Array.prototype.forEach.call(document.getElementsByName('kind'), function (r) { r.addEventListener('change', kind); });
      kind();
      var one = document.getElementById('mode-one'), many = document.getElementById('mode-many');
      function mode() {
        var m = document.querySelector('input[name=mode]:checked').value;
        one.hidden = m !== 'one'; many.hidden = m !== 'many';
        ['one_site', 'one_name', 'one_phone'].forEach(function (n) { document.getElementsByName(n)[0].required = m === 'one'; });
        document.getElementById('csv').required = m === 'many';
      }
      var csvEl = document.getElementById('csv'), prev = document.getElementById('paste-preview');
      function showPaste() {
        var lines = csvEl.value.replace(/\\r/g, '').split('\\n').filter(function (l) { return l.trim() !== ''; });
        if (!lines.length) { prev.textContent = ''; return; }
        var d = lines[0].indexOf('\\t') >= 0 ? '\\t' : ',';
        var cols = lines[0].split(d).length;
        prev.textContent = '✓ ' + lines.length + '줄, ' + cols + '개 칸을 읽었어요. 첫 줄: ' + lines[0].split(d).map(function (c) { return c.trim(); }).join(' | ');
      }
      csvEl.addEventListener('input', showPaste); showPaste();
      Array.prototype.forEach.call(document.getElementsByName('mode'), function (r) { r.addEventListener('change', mode); });
      mode();
      document.getElementById('f').addEventListener('change', async function (e) {
        var file = e.target.files[0]; if (!file) return;
        var buf = await file.arrayBuffer();
        var s = new TextDecoder('utf-8').decode(buf);
        if (s.indexOf('\\uFFFD') >= 0) s = new TextDecoder('euc-kr').decode(buf);
        document.getElementById('csv').value = s;
        document.getElementById('csv').dispatchEvent(new Event('input'));
        document.getElementById('fname').textContent = '✓ ' + file.name + ' 파일을 불러왔어요.';
      });
    })();
    </script>`;
}

// ---------------- 면접 안내 상세 ----------------
export function renderCampaignDetail(d) {
  const { camp, totals, siteRows, siteTotal, cands, siteFilter, statusFilter, previewText, canSend, stateNotice, back } = d;
  const replied = (totals.attending || 0) + (totals.absent || 0) + (totals.unclear || 0);
  const delivered = replied + (totals.sent || 0);
  const oc = d.outcomes || {};
  const slots = d.slots || [];
  const FILTERS = [['', '전체', totals.total || 0], ['attending', slots.length ? '일정 정함' : '참석', totals.attending || 0], ['absent', '불참', totals.absent || 0],
    ['unclear', '확인 필요', totals.unclear || 0], ['sent', '답 없음', totals.sent || 0], ['failed', '못 보냄', totals.failed || 0]];
  if (oc.reschedule) FILTERS.splice(4, 0, ['reschedule', '일정 변경 요청', oc.reschedule]);
  const live = !camp.purged_at && camp.status !== 'cancelled';
  const flashHtml = [
    d.flash === 'result' ? `<div class="notice ok">${icon('check')}<div><b>${d.flashN}명에게 결과 안내 문자를 보내요.</b> 보낸 문자는 문자함에서 볼 수 있어요.</div></div>` : '',
    d.err === 'reschedule' ? `<div class="notice warn" role="alert">${icon('alert')}<div>다시 안내하지 못했어요. 새 면접일시를 적었는지, 문자를 보내는 중인 사람이 아닌지 확인해 주세요.</div></div>` : ''
  ].join('');
  const slotCard = slots.length ? `<section class="section"><div class="shead"><h2>일정별 확정 인원</h2><span class="muted">답장한 번호로 정해진 사람 수</span></div>
      <ul class="slotsum">${slots.map((x, i) => `<li><span><b>${i + 1})</b> ${esc(x)}</span><b>${(d.slotCounts && d.slotCounts[x]) || 0}명</b></li>`).join('')}</ul></section>` : '';
  const rowActions = (c) => {
    if (!live) return '';
    const hid = `<input type="hidden" name="id" value="${c.id}"><input type="hidden" name="back" value="${esc(d.backQuery)}">`;
    const set = slots.length
      ? `<form method="post" action="/campaigns/${camp.id}/slot" class="inline">${hid}
          <select name="slot" aria-label="일정 정하기" onchange="this.form.submit()"><option value="">일정 정하기</option>${slots.map((x, i) => `<option value="${i + 1}"${c.status === 'attending' && c.interview_at === x ? ' selected' : ''}>${i + 1}) ${esc(x)}</option>`).join('')}</select></form>
        <form method="post" action="/campaigns/${camp.id}/set" class="inline">${hid}<button name="status" value="absent">불참</button></form>`
      : `<form method="post" action="/campaigns/${camp.id}/set" class="inline">${hid}
          <button name="status" value="attending">참석</button> <button name="status" value="absent">불참</button></form>`;
    // 다시 안내는 답장을 보낸 사람(변경 요청·불참·확인 필요·참석)에게만. 답 없는 사람은 "답 없는 사람에게 다시 보내기"를 쓴다.
    const resch = (c.reply_kind === 'reschedule' || ['attending', 'absent', 'unclear'].includes(c.status)) && camp.status !== 'draft' && camp.status !== 'scheduled'
      ? `<details class="resch"${c.reply_kind === 'reschedule' ? ' open' : ''}><summary>일정 다시 안내</summary>
          <form method="post" action="/campaigns/${camp.id}/reschedule" data-confirm="이 사람에게 새 일정으로 안내 문자를 보낼까요?">${hid}
            <input name="when" required placeholder="10/24 14:00" aria-label="새 면접일시" autocomplete="off"><button class="small">보내기</button></form></details>` : '';
    return set + resch;
  };
  const qs = (status) => `?${siteFilter ? `site=${encodeURIComponent(siteFilter)}&` : ''}${status ? `status=${status}` : ''}`.replace(/[?&]$/, '');

  const actions = camp.purged_at ? '' : `
    <a class="btn secondary" href="/campaigns/${camp.id}/export.csv">${icon('download', 18)}엑셀로 저장</a>
    <form method="post" action="/campaigns/${camp.id}/remind" class="inline" data-confirm="답이 없거나 못 보낸 사람에게 문자를 다시 보낼까요?"><button class="secondary" title="답이 없거나 못 보낸 사람에게만 다시 보내요">답 없는 사람에게 다시 보내기</button></form>
    ${['scheduled', 'sending'].includes(camp.status) ? `<form method="post" action="/campaigns/${camp.id}/cancel" class="inline" data-confirm="남은 문자 보내기를 멈출까요?"><button class="danger">보내기 멈추기</button></form>` : ''}`;

  const sendCard = canSend ? `
    <div class="card" style="margin-bottom:20px">
      <h3 style="margin-bottom:12px">언제 보낼까요?</h3>
      <form method="post" action="/campaigns/${camp.id}/send" data-confirm="${totals.total || 0}명에게 지금 문자를 보낼까요?"><button class="btn go">${icon('send', 20)}지금 바로 보내기 (${totals.total || 0}명)</button></form>
      <p class="muted" style="text-align:center;margin:14px 0 10px">또는</p>
      <form method="post" action="/campaigns/${camp.id}/send" class="stack">
        <b>${camp.status === 'scheduled' ? '예약 시간 바꾸기' : '예약해서 보내기'}</b>
        ${schedulePicker('when', true)}
        <div class="form-actions"><button class="btn secondary">${camp.status === 'scheduled' ? '이 시간으로 바꾸기' : '이 시간에 보내기'}</button></div>
      </form>
      ${camp.status === 'scheduled' ? `<form method="post" action="/campaigns/${camp.id}/unschedule" style="margin-top:12px" data-confirm="예약을 취소할까요? 문자는 나가지 않아요."><button class="btn danger">예약 취소하기 (보내지 않음)</button></form>` : ''}
    </div>${SCHEDULE_JS}` : '';

  const siteTable = tableWrap(`<table><thead><tr><th>사업장(원가중심점)</th><th class="num">보냄</th><th class="num">회신</th><th class="num">회신율</th>
      <th class="num">${colHead('참석', 'ok')}</th><th class="num">${colHead('불참', 'no')}</th><th class="num">${colHead('확인 필요', 'review')}</th><th class="num">${colHead('답 없음', 'wait')}</th><th class="num">${colHead('못 보냄', 'fail')}</th><th>응답</th></tr></thead><tbody>
    ${siteRows.map((s) => `<tr><td><a href="${esc(qs(statusFilter))}${qs(statusFilter).includes('?') ? '&' : '?'}site=${encodeURIComponent(s.site)}">${esc(s.site)}</a></td>
      <td class="num">${s.delivered}</td><td class="num"><b>${s.replied}</b></td><td class="num">${s.rate}</td>
      <td class="num">${colCount(s.attending, 'ok')}</td><td class="num">${colCount(s.absent, 'no')}</td><td class="num">${colCount(s.unclear, 'review')}</td><td class="num">${colCount(s.noreply, 'wait')}</td><td class="num">${colCount(s.failed, 'fail')}</td>
      <td style="min-width:120px">${responseBar(s)}</td></tr>`).join('')}
    ${siteRows.length > 1 ? `<tr class="total"><td>합계</td><td class="num">${siteTotal.delivered}</td><td class="num">${siteTotal.replied}</td><td class="num">${siteTotal.rate}</td>
      <td class="num">${colCount(siteTotal.attending, 'ok')}</td><td class="num">${colCount(siteTotal.absent, 'no')}</td><td class="num">${colCount(siteTotal.unclear, 'review')}</td><td class="num">${colCount(siteTotal.noreply, 'wait')}</td><td class="num">${colCount(siteTotal.failed, 'fail')}</td><td></td></tr>` : ''}
    </tbody></table>`, 'hint');

  return `${pageHeader({ title: camp.name, back, actions,
    desc: `${esc(camp.dept)} · 보내는 폰 ${esc(camp.gateway)} · ${campaignBadge(camp)}` })}
    ${flashHtml}
    ${stateNotice}
    ${sendCard}
    <div class="stats">
      ${stat({ value: totals.attending || 0, label: '참석', tone: 'yes' })}
      ${stat({ value: totals.absent || 0, label: '불참', tone: 'no' })}
      ${stat({ value: totals.unclear || 0, label: '확인 필요', tone: 'review' })}
      ${stat({ value: totals.sent || 0, label: '답 없음', tone: 'wait' })}
    </div>
    ${delivered ? `<div class="card" style="margin-top:12px">
      ${responseBar({ attending: totals.attending || 0, absent: totals.absent || 0, unclear: totals.unclear || 0, noreply: totals.sent || 0 })}
      <div class="legend"><span><i style="background:var(--green)"></i>참석 ${totals.attending || 0}</span><span><i style="background:var(--red)"></i>불참 ${totals.absent || 0}</span>
        <span><i style="background:var(--purple)"></i>확인 필요 ${totals.unclear || 0}</span><span><i style="background:var(--amber-bar)"></i>답 없음 ${totals.sent || 0}</span>
        <span style="margin-left:auto">회신율 ${siteTotal.rate}</span></div></div>` : ''}
    ${d.delivery && delivered ? `<p class="muted" style="margin-top:10px">${icon('check', 14)} 전달 확인 ${d.delivery.delivered}명 / 보냄 ${delivered}명${d.delivery.retrying ? ` · 다시 시도 중 ${d.delivery.retrying}명` : ''}</p>` : ''}
    ${d.delivery && d.delivery.stuck ? `<div class="notice warn" style="margin-top:12px" role="alert">${icon('alert')}<div><b>${d.delivery.stuck}명은 폰이 아직 문자를 보내지 않았어요.</b><br>문자 서버는 받았지만 폰이 보내지 못하고 있어요. 폰이 켜져 있는지, SMSGate 앱에서 <b>Cloud server</b>가 켜져 있는지, 인터넷이 되는지 확인해 주세요. 폰이 다시 연결되면 자동으로 나가요.</div></div>` : ''}
    ${slotCard}
    ${outcomeSection(camp, d.outcomes, d.resultTemplates)}
    ${totals.failed ? `<div class="notice warn" style="margin-top:12px" role="alert">${icon('alert')}<div><b>${totals.failed}명에게 문자를 보내지 못했어요.</b> 위의 "답 없는 사람에게 다시 보내기"로 다시 시도할 수 있어요.</div></div>` : ''}

    ${camp.template ? `<details class="card" style="margin-top:16px"><summary><b>보낸(보낼) 문자 보기</b></summary><div class="preview" style="margin-top:12px">${esc(previewText)}</div></details>` : ''}

    <section class="section">
      <div class="shead"><h2>사업장(원가중심점)별 회신 현황</h2></div>
      ${siteRows.length ? siteTable : emptyState({ title: '아직 집계할 내용이 없어요' })}
    </section>

    <section class="section">
      <div class="shead"><h2>사람별 현황${siteFilter ? ` · ${esc(siteFilter)}` : ''}</h2>${siteFilter ? `<a href="${esc(qs(statusFilter).replace(/site=[^&]*&?/, '').replace(/\?$/, '') || `/campaigns/${camp.id}`)}">사업장 필터 해제</a>` : ''}</div>
      <div class="tabs" role="tablist">${FILTERS.map(([key, label, n]) =>
        `<a href="${esc(qs(key))}"${(statusFilter || '') === key ? ' aria-current="page"' : ''}>${label} <span class="n">${n}</span></a>`).join('')}</div>
      ${tableWrap(`<table class="cards cand"><thead><tr><th>사업장</th><th>이름</th><th>전화번호 · 면접일시</th><th>상태</th><th>받은 답장</th><th>면접 결과</th><th></th></tr></thead><tbody>
        ${cands.length ? cands.map((c) => `<tr>
          <td class="c-site">${esc(c.site)}</td><td class="c-name nowrap">${esc(c.name)}</td><td class="c-phone nowrap">${esc(fmtPhone(c.phone))}${c.interview_at ? `<small class="muted" style="display:block">면접 ${esc(c.interview_at)}</small>` : ''}</td>
          <td class="c-status">${c.status === 'sent' && c.delivery === 'queued' ? phoneWaitBadge(c.sent_at) : badge(c.status, slots.length && c.status === 'attending' && !c.template_override ? '일정 정함' : '')}${c.reply_kind === 'reschedule' ? ' <span class="badge review">일정 변경 요청</span>' : ''}${c.followed_at ? ' <small title="답이 없어 자동으로 한 번 더 보냈어요">(한 번 더 보냄)</small>' : ''}${d.flagged && d.flagged.has(c.phone) ? ' <span class="badge no" title="지원자 관리: 블랙리스트 (참고용, 발송은 막지 않아요)">블랙리스트</span>' : ''}${c.manual ? ' <small>(직접)</small>' : ''}${c.delivery === 'delivered' ? ' <small title="상대 휴대폰에 전달됨">✓ 전달</small>' : ''}${c.error ? `<br><small>${esc(c.error)}</small>` : ''}</td>
          <td class="c-reply msg">${esc(c.reply_text)}</td>
          <td class="c-outcome">${camp.purged_at ? esc(OUTCOMES[c.outcome] || '') : `<form method="post" action="/campaigns/${camp.id}/outcome" class="inline">
            <input type="hidden" name="id" value="${c.id}"><input type="hidden" name="back" value="${esc(d.backQuery)}">
            <select name="outcome" aria-label="면접 결과" onchange="this.form.submit()"><option value="">결과 기록</option>${Object.entries(OUTCOMES).map(([k, v]) => `<option value="${k}"${c.outcome === k ? ' selected' : ''}>${v}</option>`).join('')}</select></form>`}</td>
          <td class="actions">${rowActions(c)}</td></tr>`).join('')
          : `<tr><td colspan="7">${emptyState({ title: '해당하는 사람이 없어요' })}</td></tr>`}
        </tbody></table>`)}
      ${cands.length >= 500 ? '<p class="muted" style="margin-top:8px">최대 500명까지 보여요. 사업장이나 상태로 걸러서 보세요.</p>' : ''}
    </section>`;
}

// ---------------- 문자 보내기 ----------------
export function renderSend({ gws, deps, gwSel, toPhone = '', text = '', notice = '' }) {
  return `${pageHeader({ title: '문자 보내기', desc: '한 명 또는 여러 명에게 보내요. 지금 바로 보내거나 시간을 정해 예약할 수 있어요.' })}
    ${notice}
    <form method="post" action="/send" class="col card stack" id="send-form">
      ${gws.length > 1 ? `<label>보낼 폰 <select name="gateway_id">${gws.map((g) =>
        `<option value="${g.id}"${g.id === gwSel ? ' selected' : ''}>${esc(deps.find((d) => d.id === g.department_id)?.name || '')} / ${esc(g.name)}</option>`).join('')}</select></label>`
        : `<input type="hidden" name="gateway_id" value="${gws[0].id}">`}
      <label>받는 번호 <small>여러 명은 쉼표나 줄바꿈으로 나눠요 (최대 200명)</small>
        <textarea name="phones" id="phones" rows="3" placeholder="010-1234-5678" required>${esc(toPhone)}</textarea>
        <span class="counter"><span id="phone-count">받는 사람 0명</span></span></label>
      <label>내용
        <textarea name="text" id="text" rows="5" required>${esc(text)}</textarea>
        <span class="counter"><span id="byte-count">0바이트</span><span id="kind"></span></span></label>
      ${whenChoice({ firstValue: 'now', firstLabel: '지금 바로' })}
      <div class="form-actions"><button class="btn big">${icon('send', 18)}문자 보내기</button></div>
    </form>
    ${SCHEDULE_JS}
    <script>
    (function () {
      var ph = document.getElementById('phones'), tx = document.getElementById('text');
      function bytes(s) { var n = 0; for (var i = 0; i < s.length; i++) n += s.charCodeAt(i) > 127 ? 2 : 1; return n; }
      function upd() {
        var list = ph.value.split(/[\\s,;]+/).filter(Boolean);
        document.getElementById('phone-count').textContent = '받는 사람 ' + list.length + '명';
        var b = bytes(tx.value);
        document.getElementById('byte-count').textContent = b + '바이트';
        document.getElementById('kind').textContent = b === 0 ? '' : (b <= 90 ? '단문(SMS)' : '장문(LMS) · 90바이트가 넘어 장문으로 나가요');
      }
      // 지금 2명 이상에게 보낼 때만 확인 창을 띄운다 (공통 스크립트가 data-confirm 을 읽는다)
      function syncConfirm() {
        var f = document.getElementById('send-form');
        var n = ph.value.split(/[\\s,;]+/).filter(Boolean).length;
        var mode = document.querySelector('#send-form input[name=send_mode]:checked');
        if (mode && mode.value === 'now' && n >= 2) f.setAttribute('data-confirm', n + '명에게 지금 문자를 보낼까요?');
        else f.removeAttribute('data-confirm');
      }
      ph.addEventListener('input', function () { upd(); syncConfirm(); });
      tx.addEventListener('input', upd);
      document.querySelectorAll('#send-form input[name=send_mode]').forEach(function (r) { r.addEventListener('change', syncConfirm); });
      upd(); syncConfirm();
    })();
    </script>`;
}

// ---------------- 문자함 (받은/보낸/예약) ----------------
export async function renderMessages(db, { gws, dirFilter, phoneFilter, notice = '' }) {
  const ids = gws.map((g) => g.id);
  const ph = idList(ids);
  const inCount = (await first(db, `SELECT COUNT(*) n FROM inbound WHERE gateway_id IN (${ph})`, ...ids)).n;
  const schedCount = (await first(db, `SELECT COUNT(*) n FROM messages WHERE gateway_id IN (${ph}) AND status IN ('scheduled','sending')`, ...ids)).n;

  const phoneOut = phoneFilter ? ' AND phone=?' : '';
  const phoneIn = phoneFilter ? ' AND sender=?' : '';
  const pArgs = phoneFilter ? [phoneFilter] : [];
  let rows;
  if (dirFilter === 'scheduled') {
    rows = await all(db,
      `SELECT 'out' dir, id, phone, text, status result, scheduled_at at, gateway_id, delivery, error, attempts,
         (SELECT COALESCE(NULLIF(name,''), username) FROM users WHERE id=messages.user_id) author FROM messages
       WHERE gateway_id IN (${ph}) AND status IN ('scheduled','sending')${phoneOut} ORDER BY scheduled_at, id LIMIT 200`, ...ids, ...pArgs);
  } else {
    rows = await all(db,
      `SELECT * FROM (
         SELECT 'out' dir, id, phone, text, status result, COALESCE(CASE WHEN status='scheduled' THEN scheduled_at END, at) at, gateway_id, delivery, error, attempts,
           (SELECT COALESCE(NULLIF(name,''), username) FROM users WHERE id=messages.user_id) author
           FROM messages WHERE gateway_id IN (${ph}) AND status != 'cancelled'${phoneOut}
         UNION ALL
         SELECT 'in' dir, id, sender phone, message text, result, received_at at, gateway_id, '' delivery, '' error, 0 attempts, NULL author FROM inbound WHERE gateway_id IN (${ph})${phoneIn}
       ) WHERE (? = '' OR dir = ?) ORDER BY at DESC LIMIT 100`, ...ids, ...pArgs, ...ids, ...pArgs, dirFilter, dirFilter);
  }

  const campSched = dirFilter === 'scheduled'
    ? await all(db, `SELECT id, name, scheduled_at FROM campaigns WHERE gateway_id IN (${ph}) AND status='scheduled' ORDER BY scheduled_at`, ...ids)
    : [];

  const tab = (key, label, n) => `<a href="/messages${key ? `?dir=${key}` : ''}"${dirFilter === key ? ' aria-current="page"' : ''}>${label}${n !== undefined ? ` <span class="n">${n}</span>` : ''}</a>`;
  const empty = { in: '받은 문자가 없어요', out: '보낸 문자가 없어요', scheduled: '예약된 문자가 없어요' }[dirFilter] || '주고받은 문자가 없어요';

  return `${pageHeader({ title: '문자함', desc: '받은 문자와 보낸 문자를 한곳에서 봐요. 15초마다 저절로 새로 불러와요.',
    actions: `<a class="btn" href="/send">${icon('plus', 18)}새 문자</a>` })}
    ${notice}
    <div class="tabs">${tab('', '전체')}${tab('in', '받은 문자', inCount)}${tab('out', '보낸 문자')}${tab('scheduled', '예약 문자', schedCount)}</div>
    ${phoneFilter ? `<p class="muted" style="margin-bottom:12px">${esc(fmtPhone(phoneFilter))}와(과) 주고받은 문자만 보고 있어요. <a href="/messages">전체 보기</a></p>` : ''}
    ${campSched.length ? `<div class="card" style="margin-bottom:16px"><b>예약된 면접 안내</b><ul style="margin:8px 0 0;padding-left:20px">${campSched.map((c) =>
      `<li><a href="/campaigns/${c.id}">${esc(c.name)}</a> — ${fmtWhen(c.scheduled_at)}</li>`).join('')}</ul></div>` : ''}
    <div class="card" style="padding:0">
      ${rows.length ? `<ul class="mlist">${rows.map((r) => `<li class="mrow">
        <div class="mtop">
          <a href="/messages?phone=${encodeURIComponent(r.phone)}"><b>${esc(fmtPhone(r.phone))}</b></a>
          ${r.dir === 'in' ? '<span class="badge info">받음</span>' : '<span class="badge">보냄</span>'}
          ${messageBadge(r.dir, r.result, r.delivery, r.at)}
          <span class="when">${fmtWhen(r.at)}</span>
          ${r.dir === 'out' && r.result === 'scheduled' ? '' : `<a class="rbtn" href="/send?to=${encodeURIComponent(r.phone)}&gw=${r.gateway_id}" aria-label="${esc(fmtPhone(r.phone))}에게 답장" title="답장">${icon('reply', 18)}</a>`}
        </div>
        <div class="mtext">${esc(r.text)}</div>
        ${r.dir === 'out' && r.error && ['failed', 'scheduled', 'sending'].includes(r.result) || (r.dir === 'out' && r.delivery === 'failed') ? `<div class="muted" style="font-size:13px;margin-top:4px;color:var(--red-t)">${esc(r.error || '전달에 실패했어요')}</div>` : ''}
        ${r.author ? `<div class="muted" style="font-size:13px;margin-top:4px">${esc(r.author)} 님이 보냄</div>` : ''}
        ${r.dir === 'out' && r.result === 'scheduled' ? `<div class="mact">${`<form method="post" action="/messages/cancel" class="inline" data-confirm="이 예약을 취소할까요?"><input type="hidden" name="id" value="${r.id}"><button class="btn danger small">예약 취소</button></form>`}</div>` : ''}
      </li>`).join('')}</ul>` : emptyState({ title: empty })}
    </div>`;
}
