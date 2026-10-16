// 지원자·블랙리스트 관리 모듈: 문자 관리 시스템과 별개의 데이터(applicants, blacklist ...)
// 지금은 로그인한 모두가 사용할 수 있다. 권한을 좁힐 때는 canUseApplicants() 한 곳만 바꾼다.
import { all, first, run, stmt } from './d1.js';
import { esc, icon, fmtTime } from './views.js';
import { fmtPhone, pageHeader, tableWrap, emptyState } from './ui.js';
import { normalizePhone, isValidMobile } from './parser.js';
import { parseCsv, toCsv } from './csv.js';

export const canUseApplicants = (user) => !!user; // 이후: user.role === 'super' 등으로 제한

export const REASONS = [
  ['noshow', '면접 무단 불참'],
  ['absent', '근무 중 무단 이탈'],
  ['false_info', '서류·정보 허위'],
  ['misconduct', '업무상 부적절한 행위'],
  ['other', '기타 (사유 직접 입력)']
];
const REASON_LABEL = Object.fromEntries(REASONS);
export const reasonLabel = (code, text = '') =>
  code === 'other' ? `기타: ${text || '-'}` : (REASON_LABEL[code] || code) + (text ? ` — ${text}` : '');

const ACTION_LABEL = { create: '등록', edit: '정보 수정', apply: '지원 건 추가', blacklist: '블랙리스트 등록', release: '블랙리스트 해제' };
const MAX_PASTE = 200;

// ---------------- 붙여넣기 해석 ----------------
const ALIAS = {
  name: ['이름', '성명', '지원자', '지원자명', 'name'],
  phone: ['전화번호', '휴대폰', '휴대폰번호', '연락처', '핸드폰', '핸드폰번호', 'phone', 'mobile'],
  applied_to: ['지원한곳', '지원처', '지원회사', '지원사', '회사', '회사명', '사업장', '사업장명', '지원사업장', 'applied', '근무지'],
  job: ['직무', '직종', '지원직무', '포지션', 'job', 'position']
};
const isPhoneCell = (v) => isValidMobile(normalizePhone(v));

export function applicantsFromText(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { rows: [], errors: ['붙여넣은 내용이 없어요.'] };
  const header = rows[0].map((h) => h.trim().toLowerCase().replace(/\s/g, ''));
  const idx = {};
  for (const [k, names] of Object.entries(ALIAS)) idx[k] = header.findIndex((h) => names.includes(h));
  let data = rows.slice(1);
  if (idx.phone < 0) {
    // 제목 줄이 없으면 내용으로 추정: 번호 모양인 칸 = 전화번호, 나머지는 이름 → 지원한 곳 → 직무 순
    const width = Math.max(...rows.map((r) => r.length));
    const sample = rows.slice(0, 30);
    let best = 0, phone = -1;
    for (let c = 0; c < width; c++) {
      const vals = sample.map((r) => (r[c] ?? '').trim()).filter(Boolean);
      const r = vals.length ? vals.filter(isPhoneCell).length / vals.length : 0;
      if (r > best) { best = r; phone = c; }
    }
    if (best < 0.5) return { rows: [], errors: ['전화번호 칸을 찾지 못했어요. 휴대폰 번호가 들어 있는 열이 있는지 확인해 주세요.'] };
    const rest = [];
    for (let c = 0; c < width; c++) if (c !== phone) rest.push(c);
    idx.phone = phone;
    idx.name = rest[0] ?? -1;
    idx.applied_to = rest[1] ?? -1;
    idx.job = rest[2] ?? -1;
    data = isPhoneCell(rows[0][phone] ?? '') ? rows : rows.slice(1);
  } else if (rows.length < 2) {
    return { rows: [], errors: ['데이터 행이 없어요.'] };
  }
  const get = (r, k) => (idx[k] >= 0 ? (r[idx[k]] ?? '').trim() : '');
  return {
    rows: data.map((r) => ({ name: get(r, 'name'), phone: get(r, 'phone'), applied_to: get(r, 'applied_to'), job: get(r, 'job') })),
    errors: []
  };
}

// ---------------- 데이터 처리 ----------------
const clip = (s, n) => String(s ?? '').trim().slice(0, n);

async function addEvent(db, applicantId, action, detail, userId, at = Date.now()) {
  await run(db, `INSERT INTO applicant_events (applicant_id, action, detail, user_id, at) VALUES (?,?,?,?,?)`,
    applicantId, action, clip(detail, 200), userId ?? null, at);
}

// 한 명 등록(또는 같은 번호가 있으면 지원 건만 추가). 반환: { ok, id, created, error }
export async function saveApplicant(db, { name, phone, applied_to = '', job = '' }, userId, source = 'manual') {
  const p = normalizePhone(phone);
  const n = clip(name, 50);
  if (!n) return { ok: false, error: '이름을 적어 주세요.' };
  if (!isValidMobile(p)) return { ok: false, error: '휴대폰 번호를 확인해 주세요. (예: 010-1234-5678)' };
  const now = Date.now();
  let row = await first(db, `SELECT id FROM applicants WHERE phone=?`, p);
  let created = false;
  if (!row) {
    const r = await run(db, `INSERT INTO applicants (name, phone, source, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?)`,
      n, p, source, userId ?? null, now, now);
    row = { id: Number(r.meta.last_row_id) };
    created = true;
    await addEvent(db, row.id, 'create', source === 'paste' ? '붙여넣기 등록' : '직접 등록', userId, now);
  }
  const a = clip(applied_to, 100), j = clip(job, 100);
  if (a || j) {
    const dup = await first(db, `SELECT id FROM applicant_applications WHERE applicant_id=? AND applied_to=? AND job=?`, row.id, a, j);
    if (!dup) {
      await run(db, `INSERT INTO applicant_applications (applicant_id, applied_to, job, created_by, created_at) VALUES (?,?,?,?,?)`,
        row.id, a, j, userId ?? null, now);
      if (!created) await addEvent(db, row.id, 'apply', '지원 건 추가', userId, now);
    }
  }
  return { ok: true, id: row.id, created };
}

// 여러 명 붙여넣기 등록. Workers 의 호출 수 한도 때문에 묶어서(batch) 처리한다.
export async function bulkSave(db, rows, userId) {
  const now = Date.now();
  const rejected = [];
  const byPhone = new Map();
  rows.slice(0, MAX_PASTE).forEach((r, i) => {
    const phone = normalizePhone(r.phone);
    const name = clip(r.name, 50);
    if (!isValidMobile(phone)) return rejected.push({ row: i + 1, reason: `휴대폰 번호 오류(${clip(r.phone, 20)})` });
    if (!name) return rejected.push({ row: i + 1, reason: '이름 없음' });
    if (!byPhone.has(phone)) byPhone.set(phone, { name, apps: [] });
    const a = clip(r.applied_to, 100), j = clip(r.job, 100);
    if (a || j) byPhone.get(phone).apps.push({ a, j });
  });
  const phones = [...byPhone.keys()];
  const existing = new Set();
  for (let i = 0; i < phones.length; i += 80) {
    const chunk = phones.slice(i, i + 80);
    const found = await all(db, `SELECT phone FROM applicants WHERE phone IN (${chunk.map(() => '?').join(',')})`, ...chunk);
    found.forEach((f) => existing.add(f.phone));
  }
  const stmts = [];
  let created = 0, updated = 0;
  for (const [phone, v] of byPhone) {
    if (!existing.has(phone)) {
      created++;
      stmts.push(stmt(db, `INSERT INTO applicants (name, phone, source, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?)`,
        v.name, phone, 'paste', userId ?? null, now, now));
      stmts.push(stmt(db,
        `INSERT INTO applicant_events (applicant_id, action, detail, user_id, at)
         VALUES ((SELECT id FROM applicants WHERE phone=?), 'create', '붙여넣기 등록', ?, ?)`, phone, userId ?? null, now));
    } else updated++;
    const seen = new Set();
    for (const { a, j } of v.apps) {
      const key = `${a}|${j}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // 같은 지원 건이 이미 있으면 넣지 않는다
      stmts.push(stmt(db,
        `INSERT INTO applicant_applications (applicant_id, applied_to, job, created_by, created_at)
         SELECT id, ?, ?, ?, ? FROM applicants WHERE phone=?
           AND NOT EXISTS (SELECT 1 FROM applicant_applications x WHERE x.applicant_id=applicants.id AND x.applied_to=? AND x.job=?)`,
        a, j, userId ?? null, now, phone, a, j));
    }
  }
  for (let i = 0; i < stmts.length; i += 40) await db.batch(stmts.slice(i, i + 40));
  return { created, updated, rejected, truncated: rows.length > MAX_PASTE };
}

// ---------------- 화면 ----------------
const statusBadge = (blActive) => (blActive
  ? '<span class="badge no">블랙리스트</span>'
  : '<span class="badge mute">일반</span>');

export async function renderApplicantList(db, { q = '', status = '' } = {}) {
  const term = clip(q, 60);
  const where = [], args = [];
  if (term) {
    const digits = term.replace(/\D/g, '');
    where.push(`(a.name LIKE ? OR (? != '' AND a.phone LIKE ?) OR EXISTS (SELECT 1 FROM applicant_applications x WHERE x.applicant_id=a.id AND (x.applied_to LIKE ? OR x.job LIKE ?)))`);
    args.push(`%${term}%`, digits, `%${digits}%`, `%${term}%`, `%${term}%`);
  }
  if (status === 'bl') where.push('b.id IS NOT NULL');
  else if (status === 'ok') where.push('b.id IS NULL');
  const rows = await all(db,
    `SELECT a.id, a.name, a.phone, a.created_at, b.id bl_id, b.reason_code, b.reason_text,
        (SELECT applied_to FROM applicant_applications WHERE applicant_id=a.id ORDER BY id DESC LIMIT 1) applied_to,
        (SELECT job FROM applicant_applications WHERE applicant_id=a.id ORDER BY id DESC LIMIT 1) job,
        (SELECT COUNT(*) FROM applicant_applications WHERE applicant_id=a.id) apps
       FROM applicants a LEFT JOIN blacklist b ON b.applicant_id=a.id AND b.status='active'
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY (b.id IS NULL), a.updated_at DESC, a.id DESC LIMIT 300`, ...args);
  const c = await first(db,
    `SELECT COUNT(*) total,
            COALESCE(SUM(EXISTS (SELECT 1 FROM blacklist b WHERE b.applicant_id=a.id AND b.status='active')),0) bl
       FROM applicants a`);
  const tab = (key, label, n) =>
    `<a href="/applicants?${term ? `q=${encodeURIComponent(term)}&` : ''}${key ? `status=${key}` : ''}"${(status || '') === key ? ' aria-current="page"' : ''}>${label} <span class="n">${n}</span></a>`;
  const body = rows.length
    ? tableWrap(`<table class="cards"><thead><tr><th>이름</th><th>전화번호</th><th>지원한 곳</th><th>직무</th><th>상태</th><th>등록일</th></tr></thead><tbody>
      ${rows.map((r) => `<tr>
        <td><a href="/applicants/${r.id}"><b>${esc(r.name)}</b></a></td>
        <td class="nowrap" data-label="전화번호">${esc(fmtPhone(r.phone))}</td>
        <td data-label="지원한 곳">${esc(r.applied_to || '-')}${r.apps > 1 ? ` <small>외 ${r.apps - 1}건</small>` : ''}</td>
        <td data-label="직무">${esc(r.job || '-')}</td>
        <td data-label="상태">${statusBadge(r.bl_id)}${r.bl_id ? ` <small>${esc(reasonLabel(r.reason_code, r.reason_text))}</small>` : ''}</td>
        <td data-label="등록일">${esc(fmtTime(r.created_at).slice(0, 10))}</td></tr>`).join('')}
      </tbody></table>`)
    : emptyState({ title: term || status ? '찾는 지원자가 없어요' : '아직 등록된 지원자가 없어요', desc: '오른쪽 위 "지원자 등록"으로 시작해 보세요.' });
  return `${pageHeader({ title: '지원자 관리', desc: '지원자를 등록하고 블랙리스트를 관리해요. 문자 발송과는 별개로 동작해요.',
    actions: `<a class="btn" href="/applicants/new">${icon('plus', 18)}지원자 등록</a><a class="btn secondary" href="/applicants/export.csv">${icon('download', 18)}엑셀로 저장</a>` })}
    <form method="get" style="display:flex;gap:8px;margin-bottom:16px;max-width:520px">
      ${status ? `<input type="hidden" name="status" value="${esc(status)}">` : ''}
      <input name="q" value="${esc(term)}" placeholder="이름, 전화번호, 지원한 곳, 직무" aria-label="검색">
      <button class="secondary" style="flex:none">찾기</button></form>
    <div class="tabs">${tab('', '전체', c.total)}${tab('bl', '블랙리스트', c.bl)}${tab('ok', '일반', c.total - c.bl)}</div>
    <div class="card" style="padding:0">${body}</div>`;
}

export function renderApplicantNew({ error = '', values = {}, result = null } = {}) {
  const resultHtml = result
    ? `<div class="notice ok">${icon('check')}<div><b>${result.created}명을 새로 등록했어요.</b>${result.updated ? ` 이미 있던 ${result.updated}명은 지원 건만 반영했어요.` : ''}${result.truncated ? ` (한 번에 ${MAX_PASTE}명까지만 처리해요)` : ''}</div></div>
       ${result.rejected.length ? `<div class="notice warn" role="alert">${icon('alert')}<div><b>${result.rejected.length}건은 등록하지 못했어요.</b><ul style="margin:8px 0 0;padding-left:20px">${result.rejected.slice(0, 30).map((x) => `<li>${x.row}번째 줄: ${esc(x.reason)}</li>`).join('')}</ul></div></div>` : ''}`
    : '';
  return `${pageHeader({ title: '지원자 등록', back: { href: '/applicants', label: '지원자 관리' } })}
    <div class="col">
      ${resultHtml}
      ${error ? `<div class="notice warn" role="alert">${icon('alert')}<div>${esc(error)}</div></div>` : ''}
      <form method="post" action="/applicants/new" class="card stack" style="max-width:720px">
        <h3>한 명 등록</h3>
        <label>이름<input name="name" value="${esc(values.name || '')}" required autocomplete="off"></label>
        <label>전화번호<input name="phone" type="tel" inputmode="tel" value="${esc(values.phone || '')}" placeholder="010-1234-5678" required autocomplete="off"></label>
        <label>지원한 곳<input name="applied_to" value="${esc(values.applied_to || '')}" placeholder="예: 아마노코리아(현장HR)" autocomplete="off"></label>
        <label>직무<input name="job" value="${esc(values.job || '')}" placeholder="예: 현장 관리" autocomplete="off"></label>
        <div class="form-actions"><button class="btn">등록하기</button></div>
      </form>
      <form method="post" action="/applicants/bulk" class="card stack" style="max-width:720px">
        <h3>엑셀에서 복사해서 여러 명 등록</h3>
        <p class="muted">엑셀에서 표를 복사(Ctrl+C)해서 아래에 붙여넣기(Ctrl+V) 하세요. 열 순서는 <b>이름 · 전화번호 · 지원한 곳 · 직무</b>를 권해요. 제목 줄이 있으면 순서가 달라도 알아봐요. (한 번에 ${MAX_PASTE}명까지)</p>
        <textarea name="text" rows="7" required aria-label="명단 붙여넣기" placeholder="홍길동&#9;010-1234-5678&#9;아마노코리아(현장HR)&#9;현장 관리"></textarea>
        <div class="form-actions"><button class="btn secondary">붙여넣은 명단 등록</button></div>
      </form>
    </div>`;
}

export async function renderApplicantDetail(db, id, { user, notice = '' } = {}) {
  const a = await first(db, `SELECT * FROM applicants WHERE id=?`, id);
  if (!a) return null;
  const apps = await all(db, `SELECT * FROM applicant_applications WHERE applicant_id=? ORDER BY id DESC`, id);
  const bls = await all(db,
    `SELECT b.*, COALESCE(NULLIF(u.name,''), u.username) by_name, COALESCE(NULLIF(r.name,''), r.username) rel_name
       FROM blacklist b LEFT JOIN users u ON u.id=b.created_by LEFT JOIN users r ON r.id=b.released_by
      WHERE b.applicant_id=? ORDER BY b.id DESC`, id);
  const evs = await all(db,
    `SELECT e.*, COALESCE(NULLIF(u.name,''), u.username) who FROM applicant_events e LEFT JOIN users u ON u.id=e.user_id
      WHERE e.applicant_id=? ORDER BY e.id DESC LIMIT 50`, id);
  const active = bls.find((b) => b.status === 'active');

  const blBox = active
    ? `<div class="notice warn" role="status">${icon('alert')}<div>
         <b>블랙리스트에 등록되어 있어요.</b><br>사유: ${esc(reasonLabel(active.reason_code, active.reason_text))}<br>
         <small>${esc(fmtTime(active.created_at))} · ${esc(active.by_name || '-')}</small>
         <form method="post" action="/applicants/${a.id}/release" class="stack" style="margin-top:12px" data-confirm="블랙리스트에서 해제할까요?">
           <label>해제 메모 <small>(선택)</small><input name="note" maxlength="200" placeholder="예: 본인 확인 후 해제"></label>
           <div><button class="btn secondary">블랙리스트 해제</button></div>
         </form></div></div>`
    : `<details class="card"><summary><b>블랙리스트에 등록하기</b></summary>
         <form method="post" action="/applicants/${a.id}/blacklist" class="stack" style="margin-top:12px">
           <label>사유<select name="reason_code" id="bl-reason" required>
             ${REASONS.map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></label>
           <label>사유 설명 <small id="bl-hint">(선택)</small>
             <textarea name="reason_text" id="bl-text" rows="3" maxlength="300" placeholder="사실만 적어 주세요. 예: 10/20 면접에 연락 없이 불참"></textarea></label>
           <div><button class="btn danger">블랙리스트 등록</button></div>
         </form>
         <script>(function(){var s=document.getElementById('bl-reason'),t=document.getElementById('bl-text'),h=document.getElementById('bl-hint');
           function u(){var o=s.value==='other';t.required=o;h.textContent=o?'(필수)':'(선택)';}s.addEventListener('change',u);u();})();</script>
       </details>`;

  const pastBl = bls.filter((b) => b.status !== 'active');
  return `${pageHeader({ title: a.name, back: { href: '/applicants', label: '지원자 관리' },
    desc: `${esc(fmtPhone(a.phone))} · ${statusBadge(!!active)}` })}
    ${notice}
    <div class="col">
      ${blBox}
      <section class="section"><div class="shead"><h2>지원 이력</h2></div>
        <div class="card" style="padding:0">${apps.length ? tableWrap(`<table><thead><tr><th>지원한 곳</th><th>직무</th><th>등록일</th></tr></thead><tbody>
          ${apps.map((x) => `<tr><td>${esc(x.applied_to || '-')}</td><td>${esc(x.job || '-')}</td><td>${esc(fmtTime(x.created_at).slice(0, 10))}</td></tr>`).join('')}</tbody></table>`)
          : emptyState({ title: '등록된 지원 이력이 없어요' })}</div>
        <details style="margin-top:12px"><summary>지원 건 추가</summary>
          <form method="post" action="/applicants/${a.id}/apply" class="stack card" style="margin-top:8px;max-width:520px">
            <label>지원한 곳<input name="applied_to" autocomplete="off"></label>
            <label>직무<input name="job" autocomplete="off"></label>
            <div><button class="btn secondary">추가</button></div>
          </form></details>
      </section>
      <section class="section"><div class="shead"><h2>기본 정보 수정</h2></div>
        <details><summary>이름·전화번호 수정</summary>
          <form method="post" action="/applicants/${a.id}/edit" class="stack card" style="margin-top:8px;max-width:520px">
            <label>이름<input name="name" value="${esc(a.name)}" required></label>
            <label>전화번호<input name="phone" type="tel" value="${esc(fmtPhone(a.phone))}" required></label>
            <label>메모 <small>(사실만, 선택)</small><textarea name="memo" rows="3" maxlength="500">${esc(a.memo)}</textarea></label>
            <div><button class="btn secondary">저장</button></div>
          </form></details>
        ${a.memo ? `<p class="muted" style="margin-top:8px">메모: ${esc(a.memo)}</p>` : ''}
      </section>
      ${pastBl.length ? `<section class="section"><div class="shead"><h2>이전 블랙리스트 기록</h2></div>
        <div class="card" style="padding:0">${tableWrap(`<table><thead><tr><th>사유</th><th>등록</th><th>해제</th></tr></thead><tbody>
          ${pastBl.map((b) => `<tr><td>${esc(reasonLabel(b.reason_code, b.reason_text))}</td>
            <td>${esc(fmtTime(b.created_at).slice(0, 10))}<br><small>${esc(b.by_name || '-')}</small></td>
            <td>${esc(fmtTime(b.released_at).slice(0, 10))}<br><small>${esc(b.rel_name || '-')}${b.release_note ? ` · ${esc(b.release_note)}` : ''}</small></td></tr>`).join('')}</tbody></table>`)}</div></section>` : ''}
      <section class="section"><div class="shead"><h2>변경 기록</h2></div>
        <div class="card" style="padding:0">${evs.length ? `<ul class="feed">${evs.map((e) => `<li>
          <span class="who">${esc(ACTION_LABEL[e.action] || e.action)}</span>
          <span class="what">${esc(e.detail)}${e.who ? ` · ${esc(e.who)}` : ''}</span>
          <span class="when">${esc(fmtTime(e.at))}</span></li>`).join('')}</ul>` : emptyState({ title: '기록이 없어요' })}</div>
      </section>
      ${user && user.role === 'super' ? `<form method="post" action="/applicants/${a.id}/delete" data-confirm="이 지원자와 모든 기록을 삭제할까요? 되돌릴 수 없어요.">
        <button class="btn danger">지원자 삭제 (관리자)</button></form>` : ''}
    </div>`;
}

export async function exportApplicantsCsv(db) {
  const rows = await all(db,
    `SELECT a.name, a.phone, a.created_at, a.memo, b.reason_code, b.reason_text,
        (SELECT applied_to FROM applicant_applications WHERE applicant_id=a.id ORDER BY id DESC LIMIT 1) applied_to,
        (SELECT job FROM applicant_applications WHERE applicant_id=a.id ORDER BY id DESC LIMIT 1) job
       FROM applicants a LEFT JOIN blacklist b ON b.applicant_id=a.id AND b.status='active' ORDER BY a.id`);
  return toCsv([['이름', '전화번호', '지원한 곳(최근)', '직무(최근)', '상태', '블랙리스트 사유', '메모', '등록일']].concat(
    rows.map((r) => [r.name, r.phone, r.applied_to || '', r.job || '', r.reason_code ? '블랙리스트' : '일반',
      r.reason_code ? reasonLabel(r.reason_code, r.reason_text) : '', r.memo, fmtTime(r.created_at)])));
}

// ---------------- 라우팅 ----------------
// c: { request, url, path, method, db, user, readForm, html, redirect, pg, audit }
// 해당하지 않는 경로면 null 을 돌려준다.
export async function handleApplicants(c) {
  const { url, path, method, db, user, readForm, html, redirect, pg, audit, request } = c;
  if (!path.startsWith('/applicants')) return null;
  if (!canUseApplicants(user)) return html(pg('접근 불가', '<p>이 화면을 볼 권한이 없어요.</p>', 'applicants'), 403);
  const page = (title, body) => html(pg(title, body, 'applicants'));

  if (path === '/applicants' && method === 'GET') {
    return page('지원자 관리', await renderApplicantList(db, { q: url.searchParams.get('q') || '', status: url.searchParams.get('status') || '' }));
  }
  if (path === '/applicants/export.csv' && method === 'GET') {
    await audit(db, user, 'applicant.export', '');
    return new Response(await exportApplicantsCsv(db), {
      headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="applicants.csv"' }
    });
  }
  if (path === '/applicants/new' && method === 'GET') return page('지원자 등록', renderApplicantNew());
  if (path === '/applicants/new' && method === 'POST') {
    const f = await readForm(request);
    const r = await saveApplicant(db, f, user.id, 'manual');
    if (!r.ok) return html(pg('지원자 등록', renderApplicantNew({ error: r.error, values: f }), 'applicants'), 400);
    await audit(db, user, r.created ? 'applicant.create' : 'applicant.apply', `id=${r.id}`);
    return redirect(`/applicants/${r.id}`);
  }
  if (path === '/applicants/bulk' && method === 'POST') {
    const f = await readForm(request);
    const parsed = applicantsFromText(f.text || '');
    if (parsed.errors.length) return html(pg('지원자 등록', renderApplicantNew({ error: parsed.errors[0] }), 'applicants'), 400);
    const result = await bulkSave(db, parsed.rows, user.id);
    await audit(db, user, 'applicant.bulk', `created=${result.created} updated=${result.updated} rejected=${result.rejected.length}`);
    return page('지원자 등록', renderApplicantNew({ result }));
  }

  const m = path.match(/^\/applicants\/(\d+)(?:\/(blacklist|release|edit|apply|delete))?$/);
  if (!m) return null;
  const id = Number(m[1]);
  const action = m[2];

  if (method === 'GET' && !action) {
    const body = await renderApplicantDetail(db, id, { user });
    if (!body) return html(pg('없음', '<p>지원자를 찾을 수 없어요.</p>', 'applicants'), 404);
    await audit(db, user, 'applicant.view', `id=${id}`);
    return page('지원자 상세', body);
  }
  if (method !== 'POST' || !action) return null;

  const person = await first(db, `SELECT id FROM applicants WHERE id=?`, id);
  if (!person) return html(pg('없음', '<p>지원자를 찾을 수 없어요.</p>', 'applicants'), 404);
  const f = await readForm(request);
  const now = Date.now();

  if (action === 'blacklist') {
    const code = String(f.reason_code || '');
    const text = clip(f.reason_text, 300);
    if (!REASON_LABEL[code]) return redirect(`/applicants/${id}`);
    if (code === 'other' && !text) {
      const body = await renderApplicantDetail(db, id, { user,
        notice: `<div class="notice warn" role="alert">${icon('alert')}<div>"기타"를 고르면 사유 설명을 꼭 적어 주세요.</div></div>` });
      return html(pg('지원자 상세', body, 'applicants'), 400);
    }
    const dup = await first(db, `SELECT id FROM blacklist WHERE applicant_id=? AND status='active'`, id);
    if (!dup) {
      await run(db, `INSERT INTO blacklist (applicant_id, reason_code, reason_text, created_by, created_at) VALUES (?,?,?,?,?)`,
        id, code, text, user.id, now);
      await run(db, `UPDATE applicants SET updated_at=? WHERE id=?`, now, id);
      await addEvent(db, id, 'blacklist', REASON_LABEL[code], user.id, now);
      await audit(db, user, 'applicant.blacklist', `id=${id} reason=${code}`);
    }
  } else if (action === 'release') {
    const r = await run(db,
      `UPDATE blacklist SET status='released', released_by=?, released_at=?, release_note=? WHERE applicant_id=? AND status='active'`,
      user.id, now, clip(f.note, 200), id);
    if (r.meta.changes) {
      await run(db, `UPDATE applicants SET updated_at=? WHERE id=?`, now, id);
      await addEvent(db, id, 'release', clip(f.note, 100) || '해제', user.id, now);
      await audit(db, user, 'applicant.release', `id=${id}`);
    }
  } else if (action === 'edit') {
    const p = normalizePhone(f.phone);
    const n = clip(f.name, 50);
    if (!n || !isValidMobile(p)) {
      const body = await renderApplicantDetail(db, id, { user,
        notice: `<div class="notice warn" role="alert">${icon('alert')}<div>이름과 휴대폰 번호를 확인해 주세요.</div></div>` });
      return html(pg('지원자 상세', body, 'applicants'), 400);
    }
    const clash = await first(db, `SELECT id FROM applicants WHERE phone=? AND id!=?`, p, id);
    if (clash) {
      const body = await renderApplicantDetail(db, id, { user,
        notice: `<div class="notice warn" role="alert">${icon('alert')}<div>같은 번호의 다른 지원자가 이미 있어요.</div></div>` });
      return html(pg('지원자 상세', body, 'applicants'), 400);
    }
    await run(db, `UPDATE applicants SET name=?, phone=?, memo=?, updated_at=? WHERE id=?`, n, p, clip(f.memo, 500), now, id);
    await addEvent(db, id, 'edit', '이름·전화번호·메모 수정', user.id, now);
    await audit(db, user, 'applicant.edit', `id=${id}`);
  } else if (action === 'apply') {
    const a = clip(f.applied_to, 100), j = clip(f.job, 100);
    if (a || j) {
      await run(db, `INSERT INTO applicant_applications (applicant_id, applied_to, job, created_by, created_at) VALUES (?,?,?,?,?)`,
        id, a, j, user.id, now);
      await run(db, `UPDATE applicants SET updated_at=? WHERE id=?`, now, id);
      await addEvent(db, id, 'apply', '지원 건 추가', user.id, now);
    }
  } else if (action === 'delete') {
    if (user.role !== 'super') return html(pg('접근 불가', '<p>삭제는 관리자만 할 수 있어요.</p>', 'applicants'), 403);
    await run(db, `DELETE FROM applicant_events WHERE applicant_id=?`, id);
    await run(db, `DELETE FROM blacklist WHERE applicant_id=?`, id);
    await run(db, `DELETE FROM applicant_applications WHERE applicant_id=?`, id);
    await run(db, `DELETE FROM applicants WHERE id=?`, id);
    await audit(db, user, 'applicant.delete', `id=${id}`);
    return redirect('/applicants');
  }
  return redirect(`/applicants/${id}`);
}
