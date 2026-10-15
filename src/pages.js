// 문자 관리 시스템 화면: 홈(요약), 문자 보내기, 문자함(받은/보낸/예약), 면접 안내 목록
import { all, first } from './d1.js';
import { esc, fmtTime } from './views.js';

const DAY = 86400000;
const KST = 9 * 3600000;
// 한국 시간 기준 오늘 0시(epoch ms)
export const kstDayStart = (now = Date.now()) => Math.floor((now + KST) / DAY) * DAY - KST;

// ---- 예약 시간 입력 (한국 시간) ----
export const schedulePicker = (name = 'when', required = false) => `
  <div class="schedule">
    <input type="datetime-local" name="${name}" id="${name}-input"${required ? ' required' : ''}>
    <div class="quick">
      <button type="button" data-plus="60">1시간 뒤</button>
      <button type="button" data-tomorrow="9">내일 오전 9시</button>
      <button type="button" data-tomorrow="14">내일 오후 2시</button>
    </div>
    <small>한국 시간 기준이에요. 문자는 정해진 시간 <b>1분 안</b>에 나가요.</small>
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
})();
</script>`;

export const CAMPAIGN_STATE = {
  draft: '아직 안 보냄', scheduled: '예약됨', sending: '보내는 중', done: '모두 보냄', cancelled: '취소함'
};

const idList = (arr) => arr.map(() => '?').join(',');

// ---------------- 홈 ----------------
export async function renderHome(db, user, deps) {
  const depIds = deps.map((d) => d.id);
  const today = kstDayStart();
  let sentToday = 0, recvToday = 0, scheduled = 0, review = 0, gwCount = 0;
  let recent = [], camps = [];

  if (depIds.length) {
    const dph = idList(depIds);
    const gwIds = (await all(db, `SELECT id FROM gateways WHERE active=1 AND department_id IN (${dph})`, ...depIds)).map((r) => r.id);
    gwCount = gwIds.length;
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
    camps = await all(db,
      `SELECT k.id, k.name, k.status, k.purged_at,
         (SELECT COUNT(*) FROM candidates WHERE campaign_id=k.id) total,
         (SELECT COUNT(*) FROM candidates WHERE campaign_id=k.id AND status='attending') att,
         (SELECT COUNT(*) FROM candidates WHERE campaign_id=k.id AND status='absent') abs
       FROM campaigns k WHERE k.department_id IN (${dph}) ORDER BY k.id DESC LIMIT 3`, ...depIds);
  }

  const banner = gwCount
    ? '<div class="ok big">🟢 문자를 보낼 폰이 준비되어 있어요.</div>'
    : `<div class="warn big">🔴 문자를 보낼 폰이 아직 연결되지 않았어요. ${user.role === 'super' ? '<a href="/admin">설정에서 폰을 연결하세요.</a>' : '전체 관리자에게 폰 연결을 부탁하세요.'}</div>`;

  return `
    <section class="hero compact">
      <h1>문자 관리 시스템</h1>
      <p>문자를 보내고, 받은 문자를 확인하고, 원하는 시간에 예약해요.</p>
    </section>
    ${banner}
    <div class="counts">
      <div class="count"><b>${sentToday}</b>오늘 보낸 문자</div>
      <div class="count"><b>${recvToday}</b>오늘 받은 문자</div>
      <a class="count" href="/messages?dir=scheduled"><b>${scheduled}</b>예약 대기</a>
      <a class="count${review ? ' check' : ''}" href="/campaigns"><b>${review}</b>확인 필요한 답장</a>
    </div>

    <div class="tiles">
      <a class="tile" href="/send"><span class="ico">✉️</span><b>문자 보내기</b><small>한 명 또는 여러 명에게, 지금 또는 예약</small></a>
      <a class="tile" href="/messages"><span class="ico">📥</span><b>문자함</b><small>받은 문자와 보낸 문자 보기</small></a>
      <a class="tile" href="/messages?dir=scheduled"><span class="ico">⏰</span><b>예약 문자</b><small>예약한 문자 확인·취소</small></a>
      <a class="tile" href="/campaigns"><span class="ico">📋</span><b>면접 안내</b><small>명단으로 한꺼번에 보내고 참석 여부 집계</small></a>
    </div>

    <h3>최근 받은 문자 <small><a href="/messages?dir=in">전체 보기</a></small></h3>
    ${recent.length ? `<table><tr><th>시각</th><th>보낸 사람</th><th>내용</th><th></th></tr>
      ${recent.map((r) => `<tr><td>${fmtTime(r.received_at)}</td><td>${esc(r.sender)}</td>
        <td style="white-space:normal;min-width:200px">${esc(r.message)}</td>
        <td><a href="/send?to=${encodeURIComponent(r.sender)}">답장</a></td></tr>`).join('')}</table>`
      : '<p><small>아직 받은 문자가 없어요.</small></p>'}

    <h3>면접 안내 <small><a href="/campaigns">전체 보기</a> · <a href="/campaigns/new">+ 새 면접 안내</a></small></h3>
    ${camps.length ? `<table><tr><th>이름</th><th>상태</th><th>보낸 사람</th><th>참석</th><th>불참</th></tr>
      ${camps.map((r) => `<tr><td><a href="/campaigns/${r.id}">${esc(r.name)}</a></td>
        <td>${esc(r.purged_at ? '개인정보 지움' : CAMPAIGN_STATE[r.status] || r.status)}</td>
        <td>${r.total}</td><td><b>${r.att}</b></td><td><b>${r.abs}</b></td></tr>`).join('')}</table>`
      : '<p><small>아직 면접 안내가 없어요. 면접 대상자에게 안내 문자를 한꺼번에 보내고 참석 여부를 모아 볼 수 있어요.</small></p>'}`;
}

// ---------------- 면접 안내 목록 ----------------
export async function renderCampaignList(db, user, deps) {
  const depIds = deps.map((d) => d.id);
  const rows = depIds.length
    ? await all(db, `SELECT k.*, d.name dept,
          (SELECT COUNT(*) FROM candidates WHERE campaign_id=k.id) total,
          (SELECT COUNT(*) FROM candidates WHERE campaign_id=k.id AND status='attending') att,
          (SELECT COUNT(*) FROM candidates WHERE campaign_id=k.id AND status='absent') abs,
          (SELECT COUNT(*) FROM candidates WHERE campaign_id=k.id AND status IN ('sent','unclear')) wait
        FROM campaigns k JOIN departments d ON d.id=k.department_id
        WHERE k.department_id IN (${idList(depIds)}) ORDER BY k.id DESC LIMIT 200`, ...depIds)
    : [];
  return `<h2>면접 안내</h2>
    <p class="lead">면접 대상자 명단을 올려 안내 문자를 한꺼번에 보내고, "참석/불참" 답장을 자동으로 모아 보여 줘요.</p>
    <p><a class="btn big" href="/campaigns/new">+ 새 면접 안내 만들기</a></p>
    ${rows.length ? `<table><tr><th>이름</th><th>상태</th><th>예약</th><th>보낸 사람</th><th>참석</th><th>불참</th><th>답 없음·확인 필요</th></tr>
      ${rows.map((r) => `<tr><td><a href="/campaigns/${r.id}">${esc(r.name)}</a><br><small>${esc(r.dept)}</small></td>
        <td>${esc(r.purged_at ? '개인정보 지움' : CAMPAIGN_STATE[r.status] || r.status)}</td><td>${fmtTime(r.scheduled_at)}</td>
        <td>${r.total}</td><td><b>${r.att}</b></td><td><b>${r.abs}</b></td><td>${r.wait}</td></tr>`).join('')}</table>`
      : '<p>아직 만든 면접 안내가 없어요. 위 버튼을 눌러 시작하세요.</p>'}`;
}

// ---------------- 문자 보내기 ----------------
export function renderSend({ gws, deps, gwSel, toPhone = '', text = '', notice = '' }) {
  return `<h2>문자 보내기</h2>${notice}
    <form method="post" action="/send" class="stack">
      ${gws.length > 1 ? `<label>보낼 폰 <select name="gateway_id">${gws.map((g) =>
        `<option value="${g.id}"${g.id === gwSel ? ' selected' : ''}>${esc(deps.find((d) => d.id === g.department_id)?.name || '')} / ${esc(g.name)}</option>`).join('')}</select></label>`
        : `<input type="hidden" name="gateway_id" value="${gws[0].id}">`}
      <label>받는 번호 <small>여러 명은 쉼표나 줄바꿈으로 나눠요 (최대 200명)</small>
        <textarea name="phones" rows="3" placeholder="010-1234-5678" required>${esc(toPhone)}</textarea></label>
      <label>내용 <textarea name="text" rows="4" required>${esc(text)}</textarea></label>
      <fieldset class="when-choice">
        <legend>언제 보낼까요?</legend>
        <label class="check"><input type="radio" name="send_mode" value="now" checked> <b>지금 바로</b></label>
        <label class="check"><input type="radio" name="send_mode" value="schedule"> <b>예약해서 보낼게요</b></label>
        ${schedulePicker('when')}
      </fieldset>
      <button class="btn big">문자 보내기</button>
    </form>
    ${SCHEDULE_JS}`;
}

// ---------------- 문자함 (받은/보낸/예약) ----------------
export const MESSAGE_RESULT = {
  sent: '보냄', failed: '못 보냄', scheduled: '예약됨', sending: '보내는 중', cancelled: '취소함',
  attending: '참석', absent: '불참', unclear: '확인 필요', unmatched: '일반 문자'
};

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
      `SELECT 'out' dir, id, phone, text, status result, scheduled_at at, gateway_id FROM messages
       WHERE gateway_id IN (${ph}) AND status IN ('scheduled','sending')${phoneOut} ORDER BY scheduled_at, id LIMIT 200`, ...ids, ...pArgs);
  } else {
    rows = await all(db,
      `SELECT * FROM (
         SELECT 'out' dir, id, phone, text, status result, COALESCE(CASE WHEN status='scheduled' THEN scheduled_at END, at) at, gateway_id
           FROM messages WHERE gateway_id IN (${ph}) AND status != 'cancelled'${phoneOut}
         UNION ALL
         SELECT 'in' dir, id, sender phone, message text, result, received_at at, gateway_id FROM inbound WHERE gateway_id IN (${ph})${phoneIn}
       ) WHERE (? = '' OR dir = ?) ORDER BY at DESC LIMIT 100`, ...ids, ...pArgs, ...ids, ...pArgs, dirFilter, dirFilter);
  }

  const campSched = dirFilter === 'scheduled'
    ? await all(db, `SELECT id, name, scheduled_at FROM campaigns WHERE gateway_id IN (${ph}) AND status='scheduled' ORDER BY scheduled_at`, ...ids)
    : [];

  const title = { in: '받은 문자', out: '보낸 문자', scheduled: '예약된 문자' }[dirFilter] || '주고받은 문자';
  return `<h2>문자함</h2>${notice}
    <p><a class="btn big" href="/send">✉️ 새 문자 보내기</a></p>
    <div class="tabs">
      <a class="${dirFilter === '' ? 'on' : ''}" href="/messages">전체</a>
      <a class="${dirFilter === 'in' ? 'on' : ''}" href="/messages?dir=in">받은 문자 (${inCount})</a>
      <a class="${dirFilter === 'out' ? 'on' : ''}" href="/messages?dir=out">보낸 문자</a>
      <a class="${dirFilter === 'scheduled' ? 'on' : ''}" href="/messages?dir=scheduled">예약 문자 (${schedCount})</a>
    </div>
    <h3>${title} <small>${dirFilter === 'scheduled' ? '' : '최근 100건 · '}15초마다 자동으로 새로 불러와요${phoneFilter ? ` · ${esc(phoneFilter)} <a href="/messages">전체 보기</a>` : ''}</small></h3>
    ${campSched.length ? `<div class="card"><b>예약된 면접 안내</b><ul>${campSched.map((c) =>
      `<li><a href="/campaigns/${c.id}">${esc(c.name)}</a> — ${fmtTime(c.scheduled_at)}</li>`).join('')}</ul></div>` : ''}
    <table><tr><th>시각</th><th>구분</th><th>번호</th><th>내용</th><th>상태</th><th></th></tr>
      ${rows.length ? '' : '<tr><td colspan="6">아직 없어요.</td></tr>'}
      ${rows.map((r) => `<tr><td>${fmtTime(r.at)}</td><td>${r.dir === 'in' ? '받음' : '보냄'}</td>
        <td><a href="/messages?phone=${encodeURIComponent(r.phone)}">${esc(r.phone)}</a></td>
        <td style="white-space:normal;min-width:200px">${esc(r.text)}</td><td>${esc(MESSAGE_RESULT[r.result] || r.result)}</td>
        <td>${r.dir === 'out' && r.result === 'scheduled'
          ? `<form method="post" action="/messages/cancel" class="inline"><input type="hidden" name="id" value="${r.id}"><button>예약 취소</button></form>`
          : `<a href="/send?to=${encodeURIComponent(r.phone)}&gw=${r.gateway_id}">답장</a>`}</td></tr>`).join('')}</table>`;
}
