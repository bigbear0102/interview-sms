// 지원자·블랙리스트 관리 모듈: 문자 관리 시스템과 별개의 데이터(applicants, blacklist ...)
// 지금은 로그인한 모두가 사용할 수 있다. 권한을 좁힐 때는 canUseApplicants() 한 곳만 바꾼다.
// 데이터는 자동으로 지우지 않는다(오래 쓰지 않은 지원자도 계속 보관). 삭제는 관리자가 직접 한다.
import { all, first, run, stmt } from './d1.js';
import { esc, icon, fmtTime } from './views.js';
import { fmtPhone, pageHeader, tableWrap, emptyState, fmtWhen } from './ui.js';
import { normalizePhone, isValidMobile } from './parser.js';
import { parseCsv, toCsv } from './csv.js';
import {
  getLinkSettings, saveLinkSettings, campaignHistory, noshowSuggestions, dismissSuggestion, DEFAULT_THRESHOLD, latestStages
} from './applicants-link.js';
import { peopleTabs, handleInbox } from './applicants-inbox.js';
import { handlePostings } from './applicants-postings.js';
import { unclassifiedPostings, suggestForTitles } from './workspace.js';
import { pendingInboxCount } from './mail-intake.js';

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

const ACTION_LABEL = {
  create: '등록', edit: '정보 수정', apply: '지원 건 추가',
  blacklist: '블랙리스트 등록', release: '블랙리스트 해제', blacklist_edit: '블랙리스트 사유 수정', merge: '지원자 병합'
};
const MAX_PASTE = 200;
const PAGE_SIZE = 50;
const KST = 9 * 3600000;

// ---------------- 붙여넣기 해석 ----------------
const ALIAS = {
  name: ['이름', '성명', '지원자', '지원자명', 'name'],
  phone: ['전화번호', '휴대폰', '휴대폰번호', '연락처', '핸드폰', '핸드폰번호', 'phone', 'mobile'],
  applied_to: ['원가중심점', '원가중심', '지원한곳', '지원처', '지원회사', '지원사', '회사', '회사명', '사업장', '사업장명', '지원사업장', 'applied', '근무지'],
  job: ['직무', '직종', '지원직무', '포지션', 'job', 'position'],
  blacklist: ['블랙리스트', '블랙리스트여부', '블랙', '블랙여부', 'blacklist'],
  reason: ['사유', '블랙리스트사유', '등록사유', '사유구분', 'reason'],
  reason_text: ['사유설명', '사유상세', '상세사유', '설명', '비고', 'reason_text']
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
    // 제목 줄이 없으면 내용으로 추정: 번호 모양인 칸 = 전화번호, 나머지는 이름 → 지원한 곳 → 직무 → 블랙리스트 → 사유 → 사유 설명 순
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
    idx.blacklist = rest[3] ?? -1;
    idx.reason = rest[4] ?? -1;
    idx.reason_text = rest[5] ?? -1;
    data = isPhoneCell(rows[0][phone] ?? '') ? rows : rows.slice(1);
  } else if (rows.length < 2) {
    return { rows: [], errors: ['데이터 행이 없어요.'] };
  }
  const get = (r, k) => (idx[k] >= 0 ? (r[idx[k]] ?? '').trim() : '');
  return {
    rows: data.map((r, k) => ({
      line: rows.length - data.length + k + 1,
      name: get(r, 'name'), phone: get(r, 'phone'), applied_to: get(r, 'applied_to'), job: get(r, 'job'),
      blacklist: get(r, 'blacklist'), reason: get(r, 'reason'), reason_text: get(r, 'reason_text')
    })),
    errors: []
  };
}

// ---------------- 데이터 처리 ----------------
const clip = (s, n) => String(s ?? '').trim().slice(0, n);

export async function addEvent(db, applicantId, action, detail, userId, at = Date.now()) {
  await run(db, `INSERT INTO applicant_events (applicant_id, action, detail, user_id, at) VALUES (?,?,?,?,?)`,
    applicantId, action, clip(detail, 200), userId ?? null, at);
}

// 한 명 등록(또는 같은 번호가 있으면 지원 건만 추가). 반환: { ok, id, created, error }
export async function saveApplicant(db, { name, phone, applied_to = '', job = '', recruit_no = '', posting_title = '', company_raw = '' }, userId, source = 'manual') {
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
  const a = clip(applied_to, 100), j = clip(job, 100), rn = clip(recruit_no, 30);
  if (a || j || rn) {
    // 같은 공고로 다시 지원한 건은 한 번만 남긴다(공고번호가 있을 때)
    const dup = rn
      ? await first(db, `SELECT id FROM applicant_applications WHERE applicant_id=? AND recruit_no=?`, row.id, rn)
      : await first(db, `SELECT id FROM applicant_applications WHERE applicant_id=? AND applied_to=? AND job=?`, row.id, a, j);
    if (!dup) {
      await run(db, `INSERT INTO applicant_applications (applicant_id, applied_to, job, created_by, created_at, recruit_no, posting_title, company_raw) VALUES (?,?,?,?,?,?,?,?)`,
        row.id, a, j, userId ?? null, now, rn, clip(posting_title, 200), clip(company_raw, 100));
      if (!created) await addEvent(db, row.id, 'apply', '지원 건 추가', userId, now);
    }
  }
  return { ok: true, id: row.id, created };
}

// 업로드 행의 블랙리스트 여부·사유 해석
//  - 여부: Y/예/O/1/블랙/블랙리스트 → 등록, N/아니오/일반/비어 있음 → 등록 안 함. 여부 열이 비었는데 사유가 있으면 등록으로 본다.
//  - 사유: 목록 이름이나 비슷한 말(노쇼, 무단 불참, 이탈, 허위 ...)을 코드로 바꾼다. 알 수 없는 말은 "기타" + 그 말을 설명으로 남긴다.
const YES = new Set(['y', 'yes', 'o', '1', 'true', '예', '네', '블랙', '블랙리스트', '등록', '대상']);
const NO = new Set(['n', 'no', 'x', '0', 'false', '아니오', '아니요', '일반', '해제', '']);
export function interpretBlacklist(r) {
  const flag = String(r.blacklist ?? '').trim().toLowerCase();
  const reasonRaw = String(r.reason ?? '').trim();
  const text = clip(r.reason_text, 300);
  let on;
  if (YES.has(flag)) on = true;
  else if (NO.has(flag)) on = flag === '' ? !!(reasonRaw || text) : false;
  else return { bl: false, warn: `블랙리스트 여부 값을 알 수 없어서 일반으로 등록했어요(${clip(r.blacklist, 20)})` };
  if (!on) return { bl: false };
  let code = '';
  const t = reasonRaw.replace(/\s/g, '').toLowerCase();
  if (REASON_LABEL[t]) code = t;
  else if (t) {
    const hit = REASONS.find(([, label]) => label.replace(/\s/g, '') === reasonRaw.replace(/\s/g, ''));
    if (hit) code = hit[0];
    else if (/불참|노쇼|noshow/.test(t)) code = 'noshow';
    else if (/이탈|결근/.test(t)) code = 'absent';
    else if (/허위/.test(t)) code = 'false_info';
    else if (/부적절|폭언|폭행|행위/.test(t)) code = 'misconduct';
    else if (/^(기타|other)$/.test(t)) code = 'other';
    else return { bl: true, code: 'other', text: clip(text ? `${reasonRaw} - ${text}` : reasonRaw, 300) };
  }
  if (!code) return { bl: false, warn: '블랙리스트 사유가 없어서 일반으로 등록했어요' };
  if (code === 'other' && !text) return { bl: false, warn: '"기타"는 사유 설명이 필요해서 일반으로 등록했어요' };
  return { bl: true, code, text };
}

// 여러 명 업로드. 이미 있는 내용(같은 번호 + 같은 지원 건, 이미 등록 중인 블랙리스트)은 올리지 않고 새 내용만 반영한다.
// Workers 의 호출 수 한도 때문에 묶어서(batch) 처리한다.
export async function bulkSave(db, rows, userId, { limit = MAX_PASTE, source = 'paste', label = '업로드' } = {}) {
  const now = Date.now();
  const batchId = `b${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const rejected = [];
  const warnings = [];
  const valid = [];
  rows.slice(0, limit).forEach((r, i) => {
    const line = r.line ?? i + 1;
    const phone = normalizePhone(r.phone);
    const name = clip(r.name, 50);
    if (!isValidMobile(phone)) return rejected.push({ row: line, reason: `휴대폰 번호 오류(${clip(r.phone, 20)})` });
    if (!name) return rejected.push({ row: line, reason: '이름 없음' });
    valid.push({ line, phone, name, a: clip(r.applied_to, 100), j: clip(r.job, 100), ib: interpretBlacklist(r) });
  });

  // 이미 있는 사람·지원 건·블랙리스트를 미리 읽는다
  const phones = [...new Set(valid.map((v) => v.phone))];
  const knownName = new Map();
  const knownApps = new Map();
  const blActive = new Set();
  for (let i = 0; i < phones.length; i += 80) {
    const chunk = phones.slice(i, i + 80);
    const ph = chunk.map(() => '?').join(',');
    for (const p of await all(db, `SELECT phone, name FROM applicants WHERE phone IN (${ph})`, ...chunk)) knownName.set(p.phone, p.name);
    for (const x of await all(db,
      `SELECT a.phone, x.applied_to, x.job FROM applicants a JOIN applicant_applications x ON x.applicant_id=a.id WHERE a.phone IN (${ph})`, ...chunk)) {
      if (!knownApps.has(x.phone)) knownApps.set(x.phone, new Set());
      knownApps.get(x.phone).add(`${x.applied_to}|${x.job}`);
    }
    for (const b of await all(db,
      `SELECT a.phone FROM applicants a JOIN blacklist b ON b.applicant_id=a.id AND b.status='active' WHERE a.phone IN (${ph})`, ...chunk)) blActive.add(b.phone);
  }

  const stmts = [];
  const plan = new Map();
  const blSkipped = new Set();
  let created = 0, added = 0, duplicates = 0, blacklisted = 0;
  for (const v of valid) {
    const existed = knownName.has(v.phone);
    let p = plan.get(v.phone);
    if (!p) {
      p = { name: existed ? knownName.get(v.phone) : v.name, apps: new Set(knownApps.get(v.phone) || []), bl: false, createdDone: false, addedDone: false };
      plan.set(v.phone, p);
    }
    let contributes = false;
    if (!existed && !p.createdDone) {
      p.createdDone = true;
      created++;
      contributes = true;
      stmts.push(stmt(db,
        `INSERT INTO applicants (name, phone, source, created_by, created_at, updated_at, batch_id) VALUES (?,?,?,?,?,?,?)`,
        v.name, v.phone, source, userId ?? null, now, now, batchId));
      stmts.push(stmt(db,
        `INSERT INTO applicant_events (applicant_id, action, detail, user_id, at, batch_id)
         SELECT id, 'create', ?, ?, ?, ? FROM applicants WHERE phone=?`, `${label} 등록`, userId ?? null, now, batchId, v.phone));
    }
    if (v.ib.warn) warnings.push({ row: v.line, reason: v.ib.warn });
    if (p.name !== v.name) {
      warnings.push({ row: v.line, reason: `같은 번호가 이미 "${p.name}" 이름으로 있어서 기존 이름을 유지했어요(올린 이름: ${v.name})` });
    }
    const key = `${v.a}|${v.j}`;
    // 직무가 비어 있고 같은 '지원한 곳'이 이미 있으면 새 내용이 없는 것으로 본다
    const sameWithoutJob = !!v.a && !v.j && [...p.apps].some((k) => k.startsWith(`${v.a}|`));
    if ((v.a || v.j) && !p.apps.has(key) && !sameWithoutJob) {
      p.apps.add(key);
      contributes = true;
      stmts.push(stmt(db,
        `INSERT INTO applicant_applications (applicant_id, applied_to, job, created_by, created_at, batch_id)
         SELECT id, ?, ?, ?, ?, ? FROM applicants WHERE phone=?`, v.a, v.j, userId ?? null, now, batchId, v.phone));
      if (existed) {
        stmts.push(stmt(db,
          `INSERT INTO applicant_events (applicant_id, action, detail, user_id, at, batch_id)
           SELECT id, 'apply', '지원 건 추가 (업로드)', ?, ?, ? FROM applicants WHERE phone=?`, userId ?? null, now, batchId, v.phone));
      }
    }
    if (v.ib.bl) {
      if (blActive.has(v.phone) || p.bl) blSkipped.add(v.phone);
      else {
        p.bl = true;
        blacklisted++;
        contributes = true;
        stmts.push(stmt(db,
          `INSERT INTO blacklist (applicant_id, reason_code, reason_text, created_by, created_at, batch_id)
           SELECT id, ?, ?, ?, ?, ? FROM applicants WHERE phone=?`, v.ib.code, v.ib.text, userId ?? null, now, batchId, v.phone));
        stmts.push(stmt(db,
          `INSERT INTO applicant_events (applicant_id, action, detail, user_id, at, batch_id)
           SELECT id, 'blacklist', ?, ?, ?, ? FROM applicants WHERE phone=?`,
        `${REASON_LABEL[v.ib.code]} (업로드)`, userId ?? null, now, batchId, v.phone));
      }
    }
    if (existed && contributes && !p.addedDone) {
      p.addedDone = true;
      added++;
      stmts.push(stmt(db, `UPDATE applicants SET updated_at=? WHERE phone=?`, now, v.phone));
    }
    if (!contributes) duplicates++;
  }
  const contributed = created + added + blacklisted > 0;
  if (contributed) {
    stmts.push(stmt(db,
      `INSERT INTO applicant_batches (id, user_id, created_at, rows_total, created, added, blacklisted, duplicates) VALUES (?,?,?,?,?,?,?,?)`,
      batchId, userId ?? null, now, rows.length, created, added, blacklisted, duplicates));
  }
  for (let i = 0; i < stmts.length; i += 40) await db.batch(stmts.slice(i, i + 40));
  return {
    created, added, duplicates, rejected, warnings, blacklisted, blSkipped: blSkipped.size,
    truncated: rows.length > limit, batchId: contributed ? batchId : ''
  };
}

// 면접 안내(캠페인) 명단을 지원자로 등록한다(연결 설정이 켜져 있을 때 호출). 지원한 곳에는 사업장을 넣는다.
export async function registerFromCampaign(db, campaignId, userId, { limit = 400 } = {}) {
  const rows = await all(db, `SELECT name, phone, site FROM candidates WHERE campaign_id=? AND phone != '' ORDER BY id`, campaignId);
  return bulkSave(db, rows.map((r, i) => ({ line: i + 1, name: r.name || '지원자', phone: r.phone, applied_to: r.site, job: '' })),
    userId, { limit, source: 'linked', label: '면접 안내 연동' });
}

// 지원자 병합: source 를 target 에 합친다(지원 이력·블랙리스트·기록을 옮기고 source 는 삭제).
// 둘 다 블랙리스트 등록 중이면 target 의 것을 남기고 source 의 것은 "병합"으로 해제 처리한다.
export async function mergeApplicants(db, targetId, sourceId, userId) {
  if (targetId === sourceId) return { ok: false, error: 'self' };
  const t = await first(db, `SELECT * FROM applicants WHERE id=?`, targetId);
  const src = await first(db, `SELECT * FROM applicants WHERE id=?`, sourceId);
  if (!t || !src) return { ok: false, error: 'missing' };
  const now = Date.now();
  const tAct = await first(db, `SELECT id FROM blacklist WHERE applicant_id=? AND status='active'`, targetId);
  const sAct = await first(db, `SELECT id FROM blacklist WHERE applicant_id=? AND status='active'`, sourceId);
  const memo = [t.memo, src.memo].filter((x) => x && x.trim()).join('\n').slice(0, 500);
  const stmts = [];
  if (tAct && sAct) {
    stmts.push(stmt(db,
      `UPDATE blacklist SET status='released', released_by=?, released_at=?, release_note='병합(중복 정리)' WHERE id=?`, userId ?? null, now, sAct.id));
  }
  stmts.push(stmt(db, `UPDATE blacklist SET applicant_id=? WHERE applicant_id=?`, targetId, sourceId));
  stmts.push(stmt(db, `UPDATE applicant_applications SET applicant_id=? WHERE applicant_id=?`, targetId, sourceId));
  stmts.push(stmt(db, `UPDATE applicant_events SET applicant_id=? WHERE applicant_id=?`, targetId, sourceId));
  stmts.push(stmt(db,
    `DELETE FROM applicant_applications WHERE applicant_id=? AND id NOT IN
       (SELECT MIN(id) FROM applicant_applications WHERE applicant_id=? GROUP BY applied_to, job)`, targetId, targetId));
  stmts.push(stmt(db, `DELETE FROM applicants WHERE id=?`, sourceId));
  stmts.push(stmt(db, `UPDATE applicants SET memo=?, updated_at=? WHERE id=?`, memo, now, targetId));
  stmts.push(stmt(db,
    `INSERT INTO applicant_events (applicant_id, action, detail, user_id, at) VALUES (?,?,?,?,?)`,
    targetId, 'merge', clip(`${src.name} (끝번호 ${String(src.phone).slice(-4)}) 기록을 합침`, 200), userId ?? null, now));
  await db.batch(stmts);
  return { ok: true };
}

// 업로드 되돌리기: 그 업로드로 생긴 지원 건·블랙리스트·기록을 지우고, 이후 다른 변경이 없는 사람은 삭제한다.
export async function undoBatch(db, batchId) {
  const b = await first(db, `SELECT * FROM applicant_batches WHERE id=?`, batchId);
  if (!b || b.undone_at) return { ok: false };
  const before = (await first(db, `SELECT COUNT(*) n FROM applicants WHERE batch_id=?`, batchId)).n;
  await db.batch([
    stmt(db, `DELETE FROM blacklist WHERE batch_id=?`, batchId),
    stmt(db, `DELETE FROM applicant_applications WHERE batch_id=?`, batchId),
    stmt(db, `DELETE FROM applicant_events WHERE batch_id=?`, batchId),
    stmt(db,
      `DELETE FROM applicants WHERE batch_id=?
         AND NOT EXISTS (SELECT 1 FROM applicant_applications x WHERE x.applicant_id=applicants.id)
         AND NOT EXISTS (SELECT 1 FROM blacklist k WHERE k.applicant_id=applicants.id)
         AND NOT EXISTS (SELECT 1 FROM applicant_events e WHERE e.applicant_id=applicants.id)`, batchId),
    stmt(db, `UPDATE applicant_batches SET undone_at=? WHERE id=?`, Date.now(), batchId)
  ]);
  const kept = (await first(db, `SELECT COUNT(*) n FROM applicants WHERE batch_id=?`, batchId)).n;
  return { ok: true, removed: before - kept, kept };
}

// ---------------- 화면 공통 ----------------
const statusBadge = (blActive) => (blActive
  ? '<span class="badge no">블랙리스트</span>'
  : '<span class="badge mute">일반</span>');

// 진행 단계(가장 최근 면접 안내 기준). 면접 안내 전이면 흐린 글자로 다음 할 일을 보여 준다.
const stageCell = (st) => (st
  ? `<span class="badge ${st.tone}">${esc(st.label)}</span>${st.interviewAt ? `<span class="sub">면접 ${esc(st.interviewAt)}</span>` : ''}<span class="sub">면접 안내 ${st.times}회${st.noshow ? ` · <b style="color:var(--red-t)">노쇼 ${st.noshow}</b>` : ''}</span>`
  : '<span class="muted" style="font-size:14px">면접 안내 전</span>');

const STATUS_LABEL = { pending: '보내는 중', sending: '보내는 중', sent: '답 없음', attending: '참석', absent: '불참', unclear: '확인 필요', failed: '못 보냄' };
const OUTCOME_LABEL = { showed: '출석', noshow: '노쇼', passed: '합격', hired: '입사', rejected: '불합격' };
function historyHtml(list) {
  if (!list.length) return '<p class="muted">면접 안내 기록이 없어요.</p>';
  return `<ul>${list.map((h) => `<li><a href="/campaigns/${h.campaign_id}">${esc(h.campaign)}</a> · ${esc(h.site || '-')}${h.interview_at ? ` · ${esc(h.interview_at)}` : ''}
    — ${esc(STATUS_LABEL[h.status] || h.status)}${h.outcome ? ` / <b>${esc(OUTCOME_LABEL[h.outcome] || h.outcome)}</b>` : ''}</li>`).join('')}</ul>`;
}

const reasonSelect = (selected = '') => `<select name="reason_code" class="bl-reason" required aria-label="사유">${
  REASONS.map(([k, v]) => `<option value="${k}"${selected === k ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select>`;

export function renderApplicantNew({ error = '', values = {} } = {}) {
  return `${pageHeader({ title: '지원자 등록', back: { href: '/applicants', label: '지원자 관리' } })}
    <div class="col">
      ${error ? `<div class="notice warn" role="alert">${icon('alert')}<div>${esc(error)}</div></div>` : ''}
      <form method="post" action="/applicants/new" class="card stack" style="max-width:720px">
        <h3>한 명 등록</h3>
        <label>이름<input name="name" value="${esc(values.name || '')}" required autocomplete="off"></label>
        <label>전화번호<input name="phone" type="tel" inputmode="tel" value="${esc(values.phone || '')}" placeholder="010-1234-5678" required autocomplete="off"></label>
        <label>원가중심점<input name="applied_to" value="${esc(values.applied_to || '')}" placeholder="예: 아마노코리아(현장HR)" autocomplete="off"></label>
        <label>직무<input name="job" value="${esc(values.job || '')}" placeholder="예: 현장 관리" autocomplete="off"></label>
        <div class="form-actions"><button class="btn">등록하기</button></div>
      </form>
    </div>`;
}

export async function renderApplicantDetail(db, id, { user, notice = '', link = null } = {}) {
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
  const hist = link && link.history ? await campaignHistory(db, a.phone, user) : null;
  const sameName = await all(db, `SELECT id, phone FROM applicants WHERE name=? AND id!=? ORDER BY id LIMIT 10`, a.name, a.id);
  const dlA = await all(db, `SELECT DISTINCT applied_to v FROM applicant_applications WHERE applied_to != '' ORDER BY v LIMIT 100`);
  const dlJ = await all(db, `SELECT DISTINCT job v FROM applicant_applications WHERE job != '' ORDER BY v LIMIT 100`);

  const pastBl = bls.filter((b) => b.status !== 'active');
  const latest = apps[0] || {};
  const sugg = await suggestForTitles(db, apps.filter((x) => !x.applied_to && x.recruit_no).map((x) => x.posting_title));
  const created = fmtTime(a.created_at).slice(0, 10);
  const dialog = (idd, title, body) => `<dialog id="${idd}" class="sheet" aria-labelledby="${idd}-t"><div class="dlgbox"><h2 id="${idd}-t">${esc(title)}</h2>${body}</div></dialog>`;
  const cancel = '<button type="button" class="secondary" data-close>닫기</button>';

  const statusPanel = active
    ? `<section class="panel bad" role="status"><h2>${icon('alert', 18)} 블랙리스트</h2>
        <p><b>사유</b> ${esc(reasonLabel(active.reason_code, active.reason_text))}</p>
        <p class="muted" style="font-size:14px;margin-top:4px">${esc(fmtTime(active.created_at))} · ${esc(active.by_name || '-')}</p>
        <div class="row" style="margin-top:12px"><button type="button" class="secondary small" data-dialog="dlg-blr">사유 수정</button><button type="button" class="secondary small" data-dialog="dlg-rel">블랙리스트 해제</button></div></section>`
    : `<section class="panel good"><h2>${icon('check', 18)} 일반 지원자</h2>
        <p class="muted" style="font-size:14px">블랙리스트에 등록되어 있지 않아요.</p>
        <div style="margin-top:12px"><button type="button" class="secondary small" data-dialog="dlg-bl">블랙리스트로 등록</button></div></section>`;

  const appsPanel = apps.length ? apps.map((x) => `<div class="aitem">
      <div class="t">${esc(x.posting_title || x.job || x.applied_to || '지원')}</div>
      <div class="chips">${x.applied_to ? `<span class="badge info">${esc(x.applied_to)}</span>` : (x.recruit_no ? '<span class="badge wait">원가중심점 정리 필요</span>' : '')}${x.job ? `<span class="badge">${esc(x.job)}</span>` : ''}</div>
      ${!x.applied_to && x.recruit_no && (sugg.get(x.posting_title) || []).length ? `<div class="sugg"><span>제안</span>${sugg.get(x.posting_title).map((nm) => `<form method="post" action="/applicants/postings/save" class="inline"><input type="hidden" name="recruit_no" value="${esc(x.recruit_no)}"><input type="hidden" name="cost_center" value="${esc(nm)}"><input type="hidden" name="job" value="${esc(x.job || '')}"><input type="hidden" name="back" value="/applicants/${a.id}"><button class="chipbtn" title="이 공고로 지원한 모든 사람에게 적용돼요">${esc(nm)}</button></form>`).join('')}<small class="muted">누르면 같은 공고 지원자 전체에 적용돼요</small></div>` : ''}
      <small class="muted">${esc(fmtTime(x.created_at).slice(0, 10))}${x.recruit_no ? ` · 공고번호 ${esc(x.recruit_no)}` : ''}${x.company_raw ? ` · ${esc(x.company_raw)}` : ''}${x.recruit_no && !x.applied_to ? ' · <a href="/applicants/postings">공고 정리에서 정하기</a>' : ''}</small></div>`).join('')
    : '<p class="muted">등록된 지원 이력이 없어요.</p>';

  const evPanel = evs.length ? `<ul class="feed">${evs.slice(0, 8).map((e) => `<li>
      <span class="who">${esc(ACTION_LABEL[e.action] || e.action)}</span>
      <span class="what">${esc(e.detail)}${e.who ? ` · ${esc(e.who)}` : ''}</span>
      <span class="when">${esc(fmtTime(e.at))}</span></li>`).join('')}</ul>${evs.length > 8 ? `<details><summary class="muted" style="padding:10px 16px">이전 기록 ${evs.length - 8}건 더 보기</summary><ul class="feed">${evs.slice(8).map((e) => `<li>
      <span class="who">${esc(ACTION_LABEL[e.action] || e.action)}</span><span class="what">${esc(e.detail)}${e.who ? ` · ${esc(e.who)}` : ''}</span><span class="when">${esc(fmtTime(e.at))}</span></li>`).join('')}</ul></details>` : ''}` : emptyState({ title: '기록이 없어요' });

  const dialogs = [
    dialog('dlg-edit', '정보 수정', `<form method="post" action="/applicants/${a.id}/edit" class="stack">
        <label>이름<input name="name" value="${esc(a.name)}" required></label>
        <label>전화번호<input name="phone" type="tel" value="${esc(fmtPhone(a.phone))}" required></label>
        ${apps.length ? `<label><span>원가중심점 <small>(가장 최근 지원 건)</small></span><input name="applied_to" list="dl-applied" value="${esc(latest.applied_to || '')}" autocomplete="off"></label>
        <label><span>직무 <small>(가장 최근 지원 건)</small></span><input name="job" list="dl-job" value="${esc(latest.job || '')}" autocomplete="off"></label>` : ''}
        <label><span>메모 <small>(사실만, 선택)</small></span><textarea name="memo" rows="3" maxlength="500">${esc(a.memo)}</textarea></label>
        <div class="dlg-actions">${cancel}<button class="btn">저장</button></div></form>`),
    dialog('dlg-app', '지원 건 추가', `<form method="post" action="/applicants/${a.id}/apply" class="stack">
        <label>원가중심점<input name="applied_to" list="dl-applied" autocomplete="off" placeholder="예: 아마노코리아(현장HR)"></label>
        <label>직무<input name="job" list="dl-job" autocomplete="off" placeholder="예: 주차관리"></label>
        <div class="dlg-actions">${cancel}<button class="btn">추가</button></div></form>`),
    active
      ? dialog('dlg-blr', '블랙리스트 사유 수정', `<form method="post" action="/applicants/${a.id}/reason" class="stack">
          <label>사유${reasonSelect(active.reason_code)}</label>
          <label><span>사유 설명 <small>(기타는 필수)</small></span><textarea name="reason_text" rows="3" maxlength="300">${esc(active.reason_text)}</textarea></label>
          <div class="dlg-actions">${cancel}<button class="btn">사유 저장</button></div></form>`)
        + dialog('dlg-rel', '블랙리스트 해제', `<form method="post" action="/applicants/${a.id}/release" class="stack" data-confirm="블랙리스트에서 해제할까요?">
          <label><span>해제 메모 <small>(선택)</small></span><input name="note" maxlength="200" placeholder="예: 본인 확인 후 해제"></label>
          <div class="dlg-actions">${cancel}<button class="btn">해제하기</button></div></form>`)
      : dialog('dlg-bl', '블랙리스트로 등록', `<form method="post" action="/applicants/${a.id}/blacklist" class="stack">
          <label>사유${reasonSelect()}</label>
          <label>사유 설명 <small id="bl-hint">(선택)</small><textarea name="reason_text" rows="3" maxlength="300" placeholder="사실만 적어 주세요. 예: 10/20 면접에 연락 없이 불참"></textarea></label>
          <div class="dlg-actions">${cancel}<button class="btn danger">등록하기</button></div></form>`),
    dialog('dlg-merge', '같은 사람 합치기', `<p class="muted" style="font-size:14px">번호를 바꾼 지원자가 두 건으로 나뉘어 있다면 하나로 합쳐요. 합칠 쪽의 지원 이력·블랙리스트·기록이 <b>이 지원자</b>로 옮겨지고, 합친 쪽은 삭제돼요.</p>
        ${sameName.length ? `<div><b>이름이 같은 지원자</b><ul style="margin:8px 0 0;padding-left:18px">${sameName.map((x) => `<li style="margin:6px 0">${esc(fmtPhone(x.phone))}
          <form method="post" action="/applicants/${a.id}/merge" class="inline" data-confirm="이 사람의 기록을 ${esc(a.name)}에게 합칠까요? 되돌릴 수 없어요."><input type="hidden" name="other_id" value="${x.id}"><button class="small secondary">합치기</button></form></li>`).join('')}</ul></div>` : ''}
        <form method="post" action="/applicants/${a.id}/merge" class="stack" data-confirm="입력한 번호의 지원자를 이 사람에게 합칠까요? 되돌릴 수 없어요.">
          <label>합칠 지원자의 전화번호<input name="other_phone" type="tel" placeholder="010-1234-5678" required></label>
          <div class="dlg-actions">${cancel}<button class="btn secondary">합치기</button></div></form>`)
  ].join('');

  const stage = (await latestStages(db, [a.phone], user).catch(() => new Map())).get(a.phone);
  return `<a class="back" href="/applicants" style="display:inline-block;font-size:14px;margin-bottom:10px">← 지원자</a>
    ${notice}
    <header class="pd-hero">
      <div class="avatar" aria-hidden="true">${esc(String(a.name).trim().slice(0, 1) || '?')}</div>
      <div><h1 class="nm">${esc(a.name)}</h1>
        <div class="ph"><a href="tel:${esc(a.phone)}">${esc(fmtPhone(a.phone))}</a><button type="button" class="lk" data-copy="${esc(fmtPhone(a.phone))}" style="background:none;border:0;color:var(--blue);min-height:32px;padding:4px 8px;font-size:14px">복사</button>${statusBadge(!!active)}${stage ? ` <a class="badge ${stage.tone}" href="/campaigns/${stage.campaignId}" title="가장 최근 면접 안내">${esc(stage.label)}</a>` : ''}</div>
        <div class="muted" style="font-size:14px;margin-top:2px">등록 ${esc(created)} · 지원 ${apps.length}건</div></div>
      <div class="acts"><a class="btn" href="/campaigns/new?ids=${a.id}">${icon('calendar', 18)}면접 안내 만들기</a><a class="btn secondary" href="/send?to=${encodeURIComponent(a.phone)}">${icon('send', 18)}문자 보내기</a><button type="button" class="btn secondary" data-dialog="dlg-edit">정보 수정</button></div>
    </header>
    <div class="pd">
      <div class="pd-main">
        <section class="panel"><div class="shead" style="margin-bottom:6px"><h2 style="margin:0">지원 이력</h2><button type="button" class="tertiary small" data-dialog="dlg-app">${icon('plus', 16)}지원 건 추가</button></div>${appsPanel}</section>
        ${hist ? `<section class="panel"><h2>면접 안내 이력 <small class="muted" style="font-weight:400">문자 시스템 연결</small></h2>${historyHtml(hist)}</section>` : ''}
        ${a.memo ? `<section class="panel"><h2>메모</h2><p>${esc(a.memo)}</p></section>` : ''}
        ${pastBl.length ? `<section class="panel"><h2>이전 블랙리스트 기록</h2>${tableWrap(`<table><thead><tr><th>사유</th><th>등록</th><th>해제</th></tr></thead><tbody>
          ${pastBl.map((b) => `<tr><td>${esc(reasonLabel(b.reason_code, b.reason_text))}</td>
            <td>${esc(fmtTime(b.created_at).slice(0, 10))}<br><small>${esc(b.by_name || '-')}</small></td>
            <td>${esc(fmtTime(b.released_at).slice(0, 10))}<br><small>${esc(b.rel_name || '-')}${b.release_note ? ` · ${esc(b.release_note)}` : ''}</small></td></tr>`).join('')}</tbody></table>`)}</section>` : ''}
        <section class="panel" style="padding:0"><h2 style="padding:18px 20px 0">변경 기록</h2>${evPanel}</section>
      </div>
      <aside class="pd-side">
        ${statusPanel}
      </aside>
      <aside class="pd-manage">
        <section class="panel"><h2>관리</h2>
          <div class="stack" style="gap:10px">
            <button type="button" class="secondary small" data-dialog="dlg-merge">같은 사람 합치기</button>
            ${user && user.role === 'super' ? `<form method="post" action="/applicants/${a.id}/delete" data-confirm="이 지원자와 모든 기록을 삭제할까요? 되돌릴 수 없어요."><button class="btn danger small">지원자 삭제 (관리자)</button></form>` : ''}
          </div></section>
      </aside>
    </div>
    ${dialogs}
    <datalist id="dl-applied">${dlA.map((o) => `<option value="${esc(o.v)}">`).join('')}</datalist>
    <datalist id="dl-job">${dlJ.map((o) => `<option value="${esc(o.v)}">`).join('')}</datalist>
    <script>(function(){document.addEventListener('change',function(e){var s=e.target.closest&&e.target.closest('select.bl-reason');if(!s)return;var t=s.form.querySelector('[name=reason_text]');var o=s.value==='other';t.required=o;var h=s.form.querySelector('#bl-hint');if(h)h.textContent=o?'(필수)':'(선택)';});
      document.addEventListener('click',function(e){var b=e.target.closest('[data-copy]');if(!b)return;navigator.clipboard.writeText(b.getAttribute('data-copy')).then(function(){var t=b.textContent;b.textContent='복사됐어요 ✓';setTimeout(function(){b.textContent=t;},1500);});});})();</script>`;
}

export async function exportApplicantsCsv(db) {
  const rows = await all(db,
    `SELECT a.name, a.phone, a.created_at, a.memo, b.reason_code, b.reason_text,
        (SELECT applied_to FROM applicant_applications WHERE applicant_id=a.id ORDER BY id DESC LIMIT 1) applied_to,
        (SELECT job FROM applicant_applications WHERE applicant_id=a.id ORDER BY id DESC LIMIT 1) job
       FROM applicants a LEFT JOIN blacklist b ON b.applicant_id=a.id AND b.status='active' ORDER BY a.id`);
  return toCsv([['이름', '전화번호', '원가중심점(최근)', '직무(최근)', '상태', '블랙리스트 사유', '메모', '등록일']].concat(
    rows.map((r) => [r.name, r.phone, r.applied_to || '', r.job || '', r.reason_code ? '블랙리스트' : '일반',
      r.reason_code ? reasonLabel(r.reason_code, r.reason_text) : '', r.memo, fmtTime(r.created_at)])));
}

// ---------------- 한 화면 표(스프레드시트형) ----------------
const FLASH = {
  added: '지원자를 등록했어요.',
  settings: '연결 설정을 저장했어요.',
  edited: '수정했어요.',
  blacklisted: '블랙리스트에 등록했어요.',
  released: '블랙리스트를 해제했어요.',
  reasoned: '블랙리스트 사유를 수정했어요.',
  deleted: '삭제했어요.',
  merged: '지원자를 합쳤어요.'
};
const FLASH_ERR = {
  invalid: '이름과 휴대폰 번호를 확인해 주세요. (예: 010-1234-5678)',
  reason: '"기타"를 고르면 사유 설명을 꼭 적어 주세요.',
  clash: '같은 번호의 다른 지원자가 이미 있어요.',
  noactive: '블랙리스트에 등록되어 있지 않아요.',
  nopick: '먼저 처리할 사람을 선택해 주세요.',
  nomerge: '합칠 지원자를 찾지 못했어요. 번호를 확인해 주세요.',
  mergeself: '같은 지원자끼리는 합칠 수 없어요.'
};

// 안전한 되돌아가기 주소(지원자 관리 화면만 허용)
export function safeBack(b) {
  const s = String(b || '');
  return /^\/applicants(\?[^#\s]*)?$/.test(s) ? s : '';
}
export const withParam = (url, key, val) => `${url}${url.includes('?') ? '&' : '?'}${key}=${encodeURIComponent(val)}`;

const SORTS = [['updated', '최근 변경순'], ['created', '등록일 최신순'], ['name', '이름순']];
const FILTER_KEYS = ['q', 'status', 'applied', 'job', 'reason', 'from', 'to', 'sort'];

// 목록 주소 만들기(필터·정렬·쪽을 유지)
export function listUrl(params, over = {}) {
  const p = { ...params, ...over };
  const parts = [];
  for (const k of [...FILTER_KEYS, 'page']) {
    const v = p[k];
    if (v !== undefined && v !== null && String(v) !== '' && !(k === 'page' && Number(v) <= 1) && !(k === 'sort' && v === 'updated')) {
      parts.push(`${k}=${encodeURIComponent(v)}`);
    }
  }
  return '/applicants' + (parts.length ? '?' + parts.join('&') : '');
}

export function paramsFrom(sp) {
  const g = (k) => String(sp.get(k) || '').trim().slice(0, 100);
  const page = Math.max(1, Math.min(10000, parseInt(sp.get('page') || '1', 10) || 1));
  const sort = SORTS.some(([k]) => k === g('sort')) ? g('sort') : 'updated';
  const date = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '');
  const status = ['bl', 'ok', 'noshow'].includes(g('status')) ? g('status') : '';
  const reason = REASON_LABEL[g('reason')] ? g('reason') : '';
  return { q: g('q'), status, applied: g('applied'), job: g('job'), reason, from: date(g('from')), to: date(g('to')), sort, page };
}

const kstDay = (s, plusDays = 0) => {
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d) - KST + plusDays * 86400000;
};

const SHEET_CSS = `<style>
.searchbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
.searchbar>input[type=search]{flex:1 1 260px;min-width:0}
.filterbox{flex:none}
.filterbox>summary{list-style:none}
.filterbox>summary::-webkit-details-marker{display:none}
.filterbox[open]{flex:1 1 100%;order:3}
.filters{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px;margin-top:12px}
.pager{display:flex;gap:8px;align-items:center;justify-content:center;margin:16px 0;flex-wrap:wrap}
fieldset.linkopts{border:0;margin:0;padding:0 0 0 28px;display:grid;gap:12px;min-width:0}
fieldset.linkopts:disabled{opacity:.45}
fieldset.linkopts:disabled label{cursor:not-allowed}
.plistwrap{background:var(--surface);border:1px solid var(--line);border-radius:var(--r-l);overflow:hidden}
.plist{width:100%;border-collapse:collapse}
.plist th{font-size:13px;color:var(--muted);font-weight:600;text-align:left;background:var(--surface-2);padding:12px 16px;white-space:nowrap}
.plist td{padding:14px 16px;border-top:1px solid var(--line-soft);vertical-align:middle}
.plist tbody tr{cursor:pointer}
.plist tbody tr:hover td{background:var(--surface-2)}
.plist .sel{width:34px;padding-right:0}
.plist .sel input{width:18px;height:18px;min-height:0}
.plist .pname{font-size:16px;font-weight:700;color:var(--ink);display:block}
.plist .sub{display:block;color:var(--muted);font-size:14px;font-variant-numeric:tabular-nums}
.plist .cc{font-weight:600}
.plist .go{width:28px;color:var(--muted);font-size:20px;text-align:right}
.plist .when{white-space:nowrap;color:var(--muted);font-size:14px}
@media (max-width:720px){
  .plist thead{display:none}
  .plist,.plist tbody{display:block}
  .plist tr{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:4px 12px;padding:14px 14px;border-top:1px solid var(--line-soft)}
  .plist tbody tr:first-child{border-top:0}
  .plist td{display:block;padding:0;border:0}
  .plist tbody tr:hover td{background:none}
  .plist td.sel{grid-row:1/4;grid-column:1;padding-top:3px}
  .plist td.who{grid-column:2}
  .plist td.st{grid-column:3;grid-row:1;text-align:right}
  .plist td.what{grid-column:2/4}
  .plist td.stage{grid-column:2/4}
  .plist td.when{grid-column:2;color:var(--muted);font-size:13px}
  .plist td.go{display:none}
}
.bulkdock select,.bulkdock input[type=text]{width:auto;min-width:150px;min-height:38px;padding:6px 10px;background:var(--bg);color:var(--ink);border-color:transparent}
.bulkdock .only{display:none}
</style>`;

const SHEET_JS = `<script>
(function () {
  // 행을 누르면 상세 화면으로(체크칸·링크는 제외)
  document.addEventListener('click', function (e) {
    var tr = e.target.closest && e.target.closest('.plist tbody tr');
    if (!tr || e.target.closest('a,input,button,label,select')) return;
    window.location.href = tr.getAttribute('data-href');
  });
  document.addEventListener('change', function (e) {
    var s = e.target.closest && e.target.closest('select.bl-reason');
    if (!s) return;
    var t = s.form.querySelector('[name=reason_text]');
    t.required = s.value === 'other';
    t.placeholder = s.value === 'other' ? '사유를 적어 주세요 (필수)' : '사유 설명 (선택)';
  });
  // 일괄 선택
  var bar = document.getElementById('bulkform');
  if (bar) {
    var cnt = document.getElementById('selcount'), op = document.getElementById('bulkop'), all = document.getElementById('chkall');
    function boxes() { return Array.prototype.slice.call(document.querySelectorAll('.rowchk')); }
    function refresh() {
      var n = boxes().filter(function (b) { return b.checked; }).length;
      cnt.textContent = n + '명 선택';
      bar.classList.toggle('on', n > 0);
      if (all) all.checked = n > 0 && n === boxes().length;
      var v = op.value;
      bar.querySelectorAll('.only').forEach(function (el) { el.style.display = el.classList.contains('only-' + v) ? 'inline-flex' : 'none'; });
      var t = bar.querySelector('[name=reason_text]'), s = bar.querySelector('select.bl-reason');
      if (t && s) t.required = v === 'blacklist' && s.value === 'other';
      // 공통 스크립트가 이 문구로 확인 창을 띄운다
      var label = { blacklist: '블랙리스트로 등록', release: '블랙리스트 해제', 'delete': '삭제' }[v];
      // 면접 안내 만들기는 다음 화면에서 확인하고 보내므로 묻지 않는다
      if (v === 'interview') bar.removeAttribute('data-confirm');
      else bar.setAttribute('data-confirm', n + '명을 "' + label + '" 처리할까요?' + (v === 'delete' ? ' 되돌릴 수 없어요.' : ''));
      var go = document.getElementById('bulkgo');
      if (go) go.textContent = v === 'interview' ? '선택한 ' + n + '명으로 면접 안내 만들기' : '선택한 사람에게 적용';
    }
    document.addEventListener('change', function (e) {
      if (e.target.classList && (e.target.classList.contains('rowchk') || e.target.id === 'bulkop')) refresh();
      if (e.target.id === 'chkall') { boxes().forEach(function (b) { b.checked = e.target.checked; }); refresh(); }
    });
    refresh();
  }
  var lm = document.querySelector('#linkform input[name=enabled]'), lo = document.getElementById('linkopts');
  if (lm && lo) lm.addEventListener('change', function () { lo.disabled = !lm.checked; });
  var f = document.getElementById('csvfile');
  if (f) f.addEventListener('change', async function (e) {
    var file = e.target.files[0]; if (!file) return;
    var buf = await file.arrayBuffer();
    var s = new TextDecoder('utf-8').decode(buf);
    if (s.indexOf('\\uFFFD') >= 0) s = new TextDecoder('euc-kr').decode(buf);
    document.getElementById('bulktext').value = s;
    document.getElementById('csvname').textContent = '✓ ' + file.name + ' 파일을 불러왔어요. 아래 "등록하기"를 눌러 주세요.';
  });
})();
</script>`;

// 첫 화면: 빠른 조회 + 입력 줄 + CSV 업로드 + 필터 + 표 + 쪽 넘기기
export async function renderApplicantSheet(db, opts = {}) {
  const { params = paramsFrom(new URLSearchParams()), flash = '', err = '', bulk = null, extra = {}, lookup = '', link = null, isSuper = false, user = null } = opts;
  const back = opts.back || listUrl(params);
  const where = [], args = [];
  if (params.q) {
    const digits = params.q.replace(/\D/g, '');
    where.push(`(a.name LIKE ? OR (? != '' AND a.phone LIKE ?) OR EXISTS (SELECT 1 FROM applicant_applications x WHERE x.applicant_id=a.id AND (x.applied_to LIKE ? OR x.job LIKE ?)))`);
    args.push(`%${params.q}%`, digits, `%${digits}%`, `%${params.q}%`, `%${params.q}%`);
  }
  if (params.status === 'bl') where.push('b.id IS NOT NULL');
  else if (params.status === 'ok') where.push('b.id IS NULL');
  else if (params.status === 'noshow') where.push(`EXISTS (SELECT 1 FROM candidates ca WHERE ca.phone=a.phone AND ca.outcome='noshow')`);
  if (params.applied) { where.push('EXISTS (SELECT 1 FROM applicant_applications x WHERE x.applicant_id=a.id AND x.applied_to=?)'); args.push(params.applied); }
  if (params.job) { where.push('EXISTS (SELECT 1 FROM applicant_applications x WHERE x.applicant_id=a.id AND x.job=?)'); args.push(params.job); }
  if (params.reason) { where.push('b.reason_code=?'); args.push(params.reason); }
  if (params.from) { where.push('a.created_at>=?'); args.push(kstDay(params.from)); }
  if (params.to) { where.push('a.created_at<?'); args.push(kstDay(params.to, 1)); }
  const W = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const base = `FROM applicants a LEFT JOIN blacklist b ON b.applicant_id=a.id AND b.status='active'`;

  const total = (await first(db, `SELECT COUNT(*) n ${base} ${W}`, ...args)).n;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pageNo = Math.min(params.page, pages);
  const order = params.sort === 'name' ? 'a.name COLLATE NOCASE ASC, a.id ASC'
    : params.sort === 'created' ? 'a.created_at DESC, a.id DESC' : 'a.updated_at DESC, a.id DESC';
  const rows = await all(db,
    `SELECT a.id, a.name, a.phone, a.created_at, b.id bl_id, b.reason_code, b.reason_text,
        (SELECT applied_to FROM applicant_applications WHERE applicant_id=a.id ORDER BY id DESC LIMIT 1) applied_to,
        (SELECT job FROM applicant_applications WHERE applicant_id=a.id ORDER BY id DESC LIMIT 1) job,
        EXISTS (SELECT 1 FROM applicant_applications WHERE applicant_id=a.id AND applied_to='' AND recruit_no != '') unclassified,
        (SELECT COUNT(*) FROM applicant_applications WHERE applicant_id=a.id) apps
       ${base} ${W} ORDER BY ${order} LIMIT ${PAGE_SIZE} OFFSET ${(pageNo - 1) * PAGE_SIZE}`, ...args);
  const stages = await latestStages(db, rows.map((r) => r.phone), user || { role: isSuper ? 'super' : '', departments: [] }).catch(() => new Map());
  const c = await first(db,
    `SELECT COUNT(*) total,
            COALESCE(SUM(EXISTS (SELECT 1 FROM blacklist b WHERE b.applicant_id=a.id AND b.status='active')),0) bl,
            COALESCE(SUM(EXISTS (SELECT 1 FROM candidates ca WHERE ca.phone=a.phone AND ca.outcome='noshow')),0) noshow
       FROM applicants a`);
  // 면접 안내만 받고 지원자로 등록되지 않은 사람(예전 안내 등). 자동 등록을 켜면 새 안내부터는 생기지 않는다.
  const unreg = (await first(db,
    `SELECT COUNT(DISTINCT ca.phone) n FROM candidates ca JOIN campaigns k ON k.id=ca.campaign_id
      WHERE ca.phone!='' AND k.purged_at IS NULL AND NOT EXISTS (SELECT 1 FROM applicants x WHERE x.phone=ca.phone)`).catch(() => ({ n: 0 }))).n;
  const appliedOpts = await all(db, `SELECT applied_to v, COUNT(*) n FROM applicant_applications WHERE applied_to != '' GROUP BY applied_to ORDER BY n DESC, v LIMIT 100`);
  const jobOpts = await all(db, `SELECT job v, COUNT(*) n FROM applicant_applications WHERE job != '' GROUP BY job ORDER BY n DESC, v LIMIT 100`);
  const batches = await all(db,
    `SELECT b.*, COALESCE(NULLIF(u.name,''), u.username) who FROM applicant_batches b LEFT JOIN users u ON u.id=b.user_id
      WHERE b.undone_at IS NULL ORDER BY b.created_at DESC LIMIT 5`);

  const tab = (key, label, n) =>
    `<a href="${esc(listUrl(params, { status: key, page: 1 }))}"${params.status === key ? ' aria-current="page"' : ''}>${label} <span class="n">${n}</span></a>`;

  const notices = [];
  const suggestions = link && link.suggest ? await noshowSuggestions(db, link.threshold) : [];
  const inboxPending = await pendingInboxCount(db, opts.viewer || null).catch(() => 0);
  const needClass = await unclassifiedPostings(db).catch(() => 0);
  if (needClass) notices.push(`<div class="notice warn">${icon('alert')}<div>원가중심점이 아직 없는 공고가 <b>${needClass}개</b> 있어요. <a href="/applicants/postings"><b>공고별로 한꺼번에 정리하기 →</b></a></div></div>`);
  if (FLASH[flash]) notices.push(`<div class="notice ok">${icon('check')}<div>${esc(FLASH[flash])}</div></div>`);
  if (unreg) notices.push(`<div class="notice info">${icon('info')}<div>면접 안내만 받고 지원자로 등록되지 않은 사람이 <b>${unreg}명</b> 있어요. <a href="/people"><b>확인하고 등록하기 →</b></a></div></div>`);
  if (flash === 'undone') {
    notices.push(`<div class="notice ok">${icon('check')}<div><b>업로드를 되돌렸어요.</b> ${Number(extra.removed) || 0}명을 삭제했어요.${Number(extra.kept) ? ` ${Number(extra.kept)}명은 업로드 뒤에 정보가 바뀌어서 남겨 두었어요.` : ''}</div></div>`);
  }
  if (flash === 'bulkop') {
    notices.push(`<div class="notice ok">${icon('check')}<div><b>${Number(extra.removed) || 0}명을 처리했어요.</b>${Number(extra.kept) ? ` ${Number(extra.kept)}명은 해당하지 않아 건너뛰었어요(이미 등록 중이거나 등록되어 있지 않은 사람).` : ''}</div></div>`);
  }
  if (FLASH_ERR[err]) notices.push(`<div class="notice warn" role="alert">${icon('alert')}<div>${esc(FLASH_ERR[err])}</div></div>`);
  if (bulk) {
    if (bulk.error) notices.push(`<div class="notice warn" role="alert">${icon('alert')}<div>${esc(bulk.error)}</div></div>`);
    else {
      const parts = [];
      if (bulk.created) parts.push(`<b>${bulk.created}명을 새로 등록했어요.</b>`);
      if (bulk.added) parts.push(`이미 있던 ${bulk.added}명에게 새 내용을 추가했어요.`);
      if (!bulk.created && !bulk.added && !bulk.blacklisted) parts.push('<b>새로 올릴 내용이 없었어요.</b>');
      if (bulk.duplicates) parts.push(`중복 ${bulk.duplicates}건은 올리지 않았어요.`);
      if (bulk.truncated) parts.push(`(한 번에 ${MAX_PASTE}명까지만 처리해요)`);
      notices.push(`<div class="notice ok">${icon('check')}<div>${parts.join(' ')}${bulk.batchId ? `
        <form method="post" action="/applicants/batch/${esc(bulk.batchId)}/undo" class="inline" style="margin-left:8px" data-confirm="방금 올린 내용을 되돌릴까요?">
          <input type="hidden" name="back" value="${esc(back)}"><button class="small secondary">방금 업로드 되돌리기</button></form>` : ''}</div></div>`);
      if (bulk.blacklisted || bulk.blSkipped) notices.push(`<div class="notice info">${icon('info')}<div>${bulk.blacklisted ? `<b>블랙리스트 ${bulk.blacklisted}명을 등록했어요.</b>` : ''}${bulk.blSkipped ? ` 이미 블랙리스트로 등록 중인 ${bulk.blSkipped}명은 그대로 두었어요.` : ''}</div></div>`);
      if (bulk.warnings && bulk.warnings.length) notices.push(`<div class="notice warn" role="alert">${icon('alert')}<div><b>확인해 주세요 (${bulk.warnings.length}건)</b><ul style="margin:8px 0 0;padding-left:20px">${bulk.warnings.slice(0, 30).map((x) => `<li>${x.row}번째 줄: ${esc(x.reason)}</li>`).join('')}</ul></div></div>`);
      if (bulk.rejected.length) notices.push(`<div class="notice warn" role="alert">${icon('alert')}<div><b>${bulk.rejected.length}건은 등록하지 못했어요.</b><ul style="margin:8px 0 0;padding-left:20px">${bulk.rejected.slice(0, 30).map((x) => `<li>${x.row}번째 줄: ${esc(x.reason)}</li>`).join('')}</ul></div></div>`);
    }
  }

  // 번호 바로 확인
  let lookupHtml = '';
  if (lookup) {
    const p = normalizePhone(lookup);
    if (!isValidMobile(p)) {
      lookupHtml = `<div class="notice warn" role="alert">${icon('alert')}<div>휴대폰 번호를 확인해 주세요. (예: 010-1234-5678)</div></div>`;
    } else {
      const r = await first(db,
        `SELECT a.id, a.name, a.created_at, b.reason_code, b.reason_text, b.created_at bl_at,
                COALESCE(NULLIF(u.name,''), u.username) by_name
           FROM applicants a LEFT JOIN blacklist b ON b.applicant_id=a.id AND b.status='active' LEFT JOIN users u ON u.id=b.created_by
          WHERE a.phone=?`, p);
      if (!r) lookupHtml = `<div class="notice info">${icon('info')}<div><b>${esc(fmtPhone(p))}</b> — 등록된 지원자가 아니에요.</div></div>`;
      else if (r.reason_code) lookupHtml = `<div class="notice warn" role="alert">${icon('alert')}<div><b>${esc(fmtPhone(p))} ${esc(r.name)} — 블랙리스트예요.</b><br>사유: ${esc(reasonLabel(r.reason_code, r.reason_text))}<br><small>${esc(fmtTime(r.bl_at))} · ${esc(r.by_name || '-')}</small> · <a href="/applicants/${r.id}">상세 보기</a></div></div>`;
      else lookupHtml = `<div class="notice ok">${icon('check')}<div><b>${esc(fmtPhone(p))} ${esc(r.name)}</b> — 등록되어 있고 블랙리스트는 아니에요. <a href="/applicants/${r.id}">상세 보기</a></div></div>`;
    }
  }

  const hid = `<input type="hidden" name="back" value="${esc(back)}">`;
  const relDate = (ms) => fmtWhen(ms).replace(/ \d\d:\d\d$/, '');
  const table = rows.length ? `<div class="plistwrap"><table class="plist"><thead><tr><th class="sel"><input type="checkbox" id="chkall" aria-label="이 화면 전체 선택"></th><th scope="col">이름</th><th scope="col">원가중심점 · 직무</th><th scope="col">진행</th><th scope="col">상태</th><th scope="col">등록</th><th class="go"></th></tr></thead><tbody>
    ${rows.map((r) => `<tr data-href="/applicants/${r.id}">
      <td class="sel"><input type="checkbox" class="rowchk" name="ids" value="${r.id}" form="bulkform" aria-label="${esc(r.name)} 선택"></td>
      <td class="who"><a class="pname" href="/applicants/${r.id}">${esc(r.name)}</a><span class="sub">${esc(fmtPhone(r.phone))}</span></td>
      <td class="what">${r.applied_to ? `<span class="cc">${esc(r.applied_to)}</span>` : (r.unclassified ? '<span class="badge wait">정리 필요</span>' : '<span class="muted">-</span>')}${r.job ? `<span class="sub">${esc(r.job)}</span>` : ''}${r.apps > 1 ? `<span class="sub">지원 ${r.apps}건</span>` : ''}</td>
      <td class="stage">${stageCell(stages.get(r.phone))}</td>
      <td class="st">${statusBadge(r.bl_id)}${r.bl_id ? `<span class="sub">${esc(reasonLabel(r.reason_code, r.reason_text))}</span>` : ''}</td>
      <td class="when">${esc(relDate(r.created_at))}</td>
      <td class="go" aria-hidden="true">›</td></tr>`).join('')}
    </tbody></table></div>`
    : emptyState({ title: FILTER_KEYS.some((k) => k !== 'sort' && params[k]) ? '찾는 지원자가 없어요' : '아직 등록된 지원자가 없어요',
      desc: '오른쪽 위 "지원자 추가"로 한 명씩, 또는 "엑셀로 올리기"로 한꺼번에 등록해 보세요. 알바몬 지원자는 "새 지원"에서 등록해요.' });

  const filterActive = ['applied', 'job', 'reason', 'from', 'to'].some((k) => params[k]) || params.sort !== 'updated';
  const opt = (list, cur) => list.map((o) => `<option value="${esc(o.v)}"${cur === o.v ? ' selected' : ''}>${esc(o.v)} (${o.n})</option>`).join('');
  const pager = pages > 1 ? `<div class="pager">
      ${pageNo > 1 ? `<a class="btn secondary small" href="${esc(listUrl(params, { page: pageNo - 1 }))}">← 이전</a>` : ''}
      <span class="muted">${pageNo} / ${pages}쪽 · 총 ${total}명</span>
      ${pageNo < pages ? `<a class="btn secondary small" href="${esc(listUrl(params, { page: pageNo + 1 }))}">다음 →</a>` : ''}
    </div>` : `<p class="muted" style="margin-top:8px">${total ? `총 ${total}명` : ''}</p>`;

  const addDialog = `<dialog id="dlg-add" class="sheet" aria-labelledby="dlg-add-t"><form method="post" action="/applicants/new" class="stack">${hid}
      <h2 id="dlg-add-t">지원자 추가</h2>
      <label>이름<input name="name" required autocomplete="off"></label>
      <label>전화번호<input name="phone" type="tel" inputmode="tel" required autocomplete="off" placeholder="010-1234-5678"></label>
      <label><span>원가중심점 <small>(선택)</small></span><input name="applied_to" list="dl-applied" autocomplete="off" placeholder="예: 아마노코리아(현장HR)"></label>
      <label><span>직무 <small>(선택)</small></span><input name="job" list="dl-job" autocomplete="off" placeholder="예: 주차관리"></label>
      <div class="dlg-actions"><button type="button" class="secondary" data-close>취소</button><button class="btn">${icon('plus', 18)}추가</button></div></form></dialog>`;
  const importDialog = `<dialog id="dlg-import" class="sheet" aria-labelledby="dlg-imp-t"><form method="post" action="/applicants/bulk" class="stack">${hid}
      <h2 id="dlg-imp-t">엑셀·CSV로 올리기</h2>
      <div class="dropzone"><input type="file" id="csvfile" accept=".csv,.txt,.tsv" aria-label="CSV 파일 선택"><p id="csvname" class="muted" style="margin-top:8px">파일을 고르거나, 엑셀에서 복사해 아래에 붙여넣어요.</p></div>
      <textarea name="text" id="bulktext" rows="6" required aria-label="명단 붙여넣기" placeholder="이름&#9;전화번호&#9;원가중심점&#9;직무&#9;블랙리스트&#9;사유&#10;홍길동&#9;010-1234-5678&#9;아마노코리아(현장HR)&#9;주차관리"></textarea>
      <p class="muted" style="font-size:14px">열 순서는 <b>이름 · 전화번호 · 원가중심점 · 직무 · 블랙리스트 · 사유 · 사유 설명</b>을 권해요. 블랙리스트 칸에는 <b>Y</b>(또는 예)를 적고, 사유는 목록 이름이나 비슷한 말(노쇼, 무단 불참 등)을 적어요. 같은 번호는 중복으로 올리지 않아요.</p>
      ${batches.length ? `<details><summary>최근 올린 것 되돌리기 (${batches.length})</summary><ul style="margin:8px 0 0;padding-left:18px">${batches.map((b) => `<li style="margin:6px 0">${esc(fmtTime(b.created_at))} · ${esc(b.who || '-')} — 새로 ${b.created}명${b.added ? `, 추가 ${b.added}명` : ''}${b.blacklisted ? `, 블랙리스트 ${b.blacklisted}명` : ''}
          <button class="small secondary" formaction="/applicants/batch/${esc(b.id)}/undo" formnovalidate data-confirm="이 업로드를 되돌릴까요?">되돌리기</button></li>`).join('')}</ul></details>` : ''}
      <div class="dlg-actions"><button type="button" class="secondary" data-close>취소</button><button class="btn">등록하기</button></div></form></dialog>`;

  return `${SHEET_CSS}${pageHeader({ title: '지원자', desc: '등록된 지원자를 찾고, 골라서 면접 안내를 만들고, 블랙리스트를 관리해요.',
    actions: `<button type="button" class="btn" data-dialog="dlg-add">${icon('plus', 18)}지원자 추가</button><button type="button" class="btn secondary" data-dialog="dlg-import">엑셀로 올리기</button><a class="btn tertiary" href="/applicants/export.csv">${icon('download', 18)}엑셀로 저장</a>` })}
    ${peopleTabs('list', inboxPending, needClass)}
    ${notices.filter((x) => !/공고별로 한꺼번에/.test(x)).join('')}
    ${needClass ? `<div class="notice info">${icon('info')}<div>원가중심점이 정해지지 않은 공고가 <b>${needClass}개</b> 있어요. <a href="/applicants/postings"><b>공고 정리에서 한 번에 정하기 →</b></a></div></div>` : ''}
    ${suggestions.length ? `<details class="card" open style="margin-bottom:16px"><summary><b>블랙리스트 후보 제안 ${suggestions.length}명</b>
      <span class="muted">면접 결과를 "노쇼"로 기록한 횟수가 ${link.threshold}회 이상이에요. 사람이 확인하고 등록해요.</span></summary>
      <div style="margin-top:8px">${tableWrap(`<table class="cards"><thead><tr><th>이름</th><th>전화번호</th><th>노쇼</th><th></th></tr></thead><tbody>
        ${suggestions.map((x) => `<tr><td><b>${esc(x.name)}</b></td><td data-label="전화번호">${esc(fmtPhone(x.phone))}</td><td data-label="노쇼">${x.n}회</td>
          <td class="acts"><form method="post" action="/applicants/suggest/register" class="inline" data-confirm="블랙리스트로 등록할까요?">${hid}
              <input type="hidden" name="phone" value="${esc(x.phone)}"><input type="hidden" name="name" value="${esc(x.name)}"><input type="hidden" name="n" value="${x.n}">
              <button class="small btn danger">블랙리스트 등록</button></form>
            <form method="post" action="/applicants/suggest/dismiss" class="inline">${hid}
              <input type="hidden" name="phone" value="${esc(x.phone)}"><input type="hidden" name="n" value="${x.n}"><button class="small secondary">무시</button></form></td></tr>`).join('')}
        </tbody></table>`)}</div></details>` : ''}
    <form method="get" action="/applicants" class="searchbar">
      ${params.status ? `<input type="hidden" name="status" value="${esc(params.status)}">` : ''}
      <input name="q" value="${esc(params.q)}" placeholder="이름 · 전화번호 · 원가중심점 · 직무로 찾기" aria-label="검색" type="search">
      <button class="btn">찾기</button>
      <details class="filterbox"${filterActive ? ' open' : ''}><summary class="btn secondary">필터${filterActive ? ' ●' : ''}</summary>
        <div class="filters">
          <select name="applied" aria-label="원가중심점"><option value="">원가중심점 전체</option>${opt(appliedOpts, params.applied)}</select>
          <select name="job" aria-label="직무"><option value="">직무 전체</option>${opt(jobOpts, params.job)}</select>
          <select name="reason" aria-label="블랙리스트 사유"><option value="">사유 전체</option>${REASONS.map(([k, v]) => `<option value="${k}"${params.reason === k ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select>
          <label style="font-weight:400">등록일 시작<input type="date" name="from" value="${esc(params.from)}"></label>
          <label style="font-weight:400">등록일 끝<input type="date" name="to" value="${esc(params.to)}"></label>
          <select name="sort" aria-label="정렬">${SORTS.map(([k, v]) => `<option value="${k}"${params.sort === k ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select>
        </div>
        <p style="margin-top:8px"><a href="/applicants">필터 초기화</a></p>
      </details>
    </form>
    ${lookupHtml}
    <div class="tabs" style="margin-top:12px">${tab('', '전체', c.total)}${tab('bl', '블랙리스트', c.bl)}${tab('ok', '일반', c.total - c.bl)}${tab('noshow', '노쇼 있음', c.noshow)}</div>
    <form id="bulkform" method="post" action="/applicants/bulk-action" class="bulkdock" aria-live="polite">${hid}
      <b id="selcount">0명 선택</b>
      <select name="op" id="bulkop" aria-label="처리 방법">
        <option value="interview">면접 안내 만들기</option>
        <option value="blacklist">블랙리스트로 등록</option>
        <option value="release">블랙리스트 해제</option>
        ${isSuper ? '<option value="delete">삭제 (관리자)</option>' : ''}
      </select>
      <span class="only only-blacklist" style="gap:6px;flex-wrap:wrap">${reasonSelect()}<input type="text" name="reason_text" maxlength="300" placeholder="사유 설명 (선택)" aria-label="사유 설명"></span>
      <span class="only only-release"><input type="text" name="note" maxlength="200" placeholder="해제 메모 (선택)" aria-label="해제 메모"></span>
      <button id="bulkgo">선택한 사람에게 적용</button>
    </form>
    ${table}
    ${pager}
    ${link ? `<details class="card" style="margin-top:24px"><summary><b>문자 시스템 연결</b>
      <span class="muted">${link.enabled ? '켜짐' : '꺼짐 (기본)'} — 면접 안내와 지원자 관리를 이어 줘요. 발송은 막지 않아요.</span></summary>
      <form method="post" action="/applicants/settings" id="linkform" class="stack" style="margin-top:12px">${hid}
        <label class="check"><input type="checkbox" name="enabled" value="1"${link.enabled ? ' checked' : ''}${isSuper ? '' : ' disabled'}> <span><b>연결 사용</b> <small>켜야 아래 항목을 고를 수 있어요. 끄면 아래 항목은 모두 동작하지 않아요</small></span></label>
        <fieldset class="linkopts" id="linkopts"${link.enabled ? '' : ' disabled'}>
        <label class="check"><input type="checkbox" name="register" value="1"${link.raw.register ? ' checked' : ''}${isSuper ? '' : ' disabled'}> <span>면접 안내를 만들 때 명단을 지원자로 <b>자동 등록</b> <small>(중복은 올리지 않아요, 원가중심점에는 사업장을 넣어요)</small></span></label>
        <label class="check"><input type="checkbox" name="history" value="1"${link.raw.history ? ' checked' : ''}${isSuper ? '' : ' disabled'}> <span>지원자 상세·기록에 <b>면접 안내 이력</b> 보이기</span></label>
        <label class="check"><input type="checkbox" name="suggest" value="1"${link.raw.suggest ? ' checked' : ''}${isSuper ? '' : ' disabled'}> <span>노쇼 기록이 많은 사람을 <b>블랙리스트 후보로 제안</b> <small>(등록은 사람이 승인해요)</small></span></label>
        <label style="max-width:220px">제안 기준 (노쇼 횟수)<input type="number" name="threshold" min="1" max="20" value="${link.threshold}"${isSuper ? '' : ' disabled'}></label>
        <label class="check"><input type="checkbox" name="flag" value="1"${link.raw.flag ? ' checked' : ''}${isSuper ? '' : ' disabled'}> <span>면접 안내 명단을 올릴 때 블랙리스트 대상이 있으면 <b>참고용으로 표시</b></span></label>
        </fieldset>
        ${isSuper ? '<div><button class="btn secondary">설정 저장</button></div>' : '<p class="muted">설정은 관리자만 바꿀 수 있어요.</p>'}
      </form></details>` : ''}
    ${addDialog}${importDialog}
    <datalist id="dl-applied">${appliedOpts.map((o) => `<option value="${esc(o.v)}">`).join('')}</datalist>
    <datalist id="dl-job">${jobOpts.map((o) => `<option value="${esc(o.v)}">`).join('')}</datalist>
    ${SHEET_JS}`;
}

// 표에서 "기록"을 누르면 불러오는 작은 조각 (지원 이력, 이전 블랙리스트, 변경 기록)
export async function renderApplicantPanel(db, id, { user = null, link = null } = {}) {
  const a = await first(db, `SELECT id, phone FROM applicants WHERE id=?`, id);
  if (!a) return null;
  const apps = await all(db, `SELECT * FROM applicant_applications WHERE applicant_id=? ORDER BY id DESC LIMIT 20`, id);
  const bls = await all(db,
    `SELECT b.*, COALESCE(NULLIF(u.name,''), u.username) by_name, COALESCE(NULLIF(r.name,''), r.username) rel_name
       FROM blacklist b LEFT JOIN users u ON u.id=b.created_by LEFT JOIN users r ON r.id=b.released_by
      WHERE b.applicant_id=? ORDER BY b.id DESC LIMIT 20`, id);
  const evs = await all(db,
    `SELECT e.*, COALESCE(NULLIF(u.name,''), u.username) who FROM applicant_events e LEFT JOIN users u ON u.id=e.user_id
      WHERE e.applicant_id=? ORDER BY e.id DESC LIMIT 20`, id);
  const li = (items) => items.length ? `<ul>${items.join('')}</ul>` : '<p class="muted">없어요.</p>';
  const hist = link && link.history ? await campaignHistory(db, a.phone, user) : null;
  return `${hist ? `<h4>면접 안내 이력</h4>${historyHtml(hist)}` : ''}<h4>지원 이력</h4>${li(apps.map((x) => `<li>${esc(x.applied_to || '-')} · ${esc(x.job || '-')} <small class="muted">${esc(fmtTime(x.created_at).slice(0, 10))}</small></li>`))}
    <h4>블랙리스트 기록</h4>${li(bls.map((b) => `<li>${esc(reasonLabel(b.reason_code, b.reason_text))} — ${b.status === 'active' ? '<b>등록 중</b>' : '해제됨'}
      <small class="muted">${esc(fmtTime(b.created_at).slice(0, 10))} ${esc(b.by_name || '')}${b.released_at ? ` → ${esc(fmtTime(b.released_at).slice(0, 10))} ${esc(b.rel_name || '')}${b.release_note ? ` (${esc(b.release_note)})` : ''}` : ''}</small></li>`))}
    <h4>변경 기록</h4>${li(evs.map((e) => `<li>${esc(ACTION_LABEL[e.action] || e.action)}${e.detail ? ` — ${esc(e.detail)}` : ''} <small class="muted">${esc(fmtTime(e.at))} ${esc(e.who || '')}</small></li>`))}`;
}

export function applicantTemplateCsv() {
  return toCsv([
    ['이름', '전화번호', '지원한 곳', '직무', '블랙리스트', '사유', '사유 설명'],
    ['홍길동', '010-1234-5678', '아마노코리아(현장HR)', '현장 관리', '', '', ''],
    ['김영희', '010-2345-6789', '아마노코리아(현장HR)', '물류', 'Y', '면접 무단 불참', '10/20 연락 없이 불참']
  ]);
}

// ---------------- 라우팅 ----------------
// c: { request, url, path, method, db, user, readForm, html, redirect, pg, audit }
// 해당하지 않는 경로면 null 을 돌려준다.
export async function handleApplicants(c) {
  const { url, path, method, db, user, readForm, html, redirect, pg, audit, request, env } = c;
  if (!path.startsWith('/applicants')) return null;
  if (!canUseApplicants(user)) return html(pg('접근 불가', '<p>이 화면을 볼 권한이 없어요.</p>', 'applicants'), 403);
  const page = (title, body) => html(pg(title, body, 'applicants'));

  // 공고별 정리
  if (path.startsWith('/applicants/postings')) {
    const r = await handlePostings(c);
    if (r) return r;
  }

  // 메일 수신함(알바몬 지원 알림)
  if (path.startsWith('/applicants/inbox')) {
    const r = await handleInbox({ ...c, env: env || {} }, { saveApplicant, addEvent, safeBack, withParam });
    if (r) return r;
  }

  if (path === '/applicants' && method === 'GET') {
    const sp = url.searchParams;
    const params = paramsFrom(sp);
    const qRaw = String(sp.get('q') || '').trim().slice(0, 30);
    const lookup = String(sp.get('lookup') || (isValidMobile(normalizePhone(qRaw)) ? qRaw : '')).trim().slice(0, 30);
    if (lookup) await audit(db, user, 'applicant.lookup', '');
    const link = await getLinkSettings(db);
    return page('지원자 관리', await renderApplicantSheet(db, {
      viewer: { id: user.id, isSuper: user.role === 'super' }, user, params, back: listUrl(params), lookup, link, isSuper: user.role === 'super',
      flash: sp.get('ok') || '', err: sp.get('err') || '',
      extra: { removed: sp.get('n'), kept: sp.get('k') }
    }));
  }
  if (path === '/applicants/export.csv' && method === 'GET') {
    await audit(db, user, 'applicant.export', '');
    return new Response(await exportApplicantsCsv(db), {
      headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="applicants.csv"' }
    });
  }
  if (path === '/applicants/template.csv' && method === 'GET') {
    return new Response(applicantTemplateCsv(), {
      headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="applicants-template.csv"' }
    });
  }
  if (path === '/applicants/new' && method === 'GET') return redirect('/applicants');
  if (path === '/applicants/new' && method === 'POST') {
    const f = await readForm(request);
    const back = safeBack(f.back);
    const r = await saveApplicant(db, f, user.id, 'manual');
    if (!r.ok) {
      if (back) return redirect(withParam(back, 'err', 'invalid'));
      return html(pg('지원자 등록', renderApplicantNew({ error: r.error, values: f }), 'applicants'), 400);
    }
    await audit(db, user, r.created ? 'applicant.create' : 'applicant.apply', `id=${r.id}`);
    return redirect(back ? withParam(back, 'ok', 'added') : `/applicants/${r.id}`);
  }
  if (path === '/applicants/bulk' && method === 'POST') {
    const f = await readForm(request);
    const parsed = applicantsFromText(f.text || '');
    const back = safeBack(f.back) || '/applicants';
    const params = paramsFrom(new URLSearchParams());
    if (parsed.errors.length) {
      return html(pg('지원자 관리', await renderApplicantSheet(db, { viewer: { id: user.id, isSuper: user.role === 'super' }, params, back,
        bulk: { created: 0, added: 0, duplicates: 0, rejected: [], warnings: [], blacklisted: 0, blSkipped: 0, error: parsed.errors[0] } }), 'applicants'), 400);
    }
    const result = await bulkSave(db, parsed.rows, user.id);
    await audit(db, user, 'applicant.bulk',
      `created=${result.created} added=${result.added} duplicates=${result.duplicates} blacklisted=${result.blacklisted} rejected=${result.rejected.length}`);
    return page('지원자 관리', await renderApplicantSheet(db, { viewer: { id: user.id, isSuper: user.role === 'super' }, params, back, bulk: result }));
  }
  // 여러 명 한꺼번에 처리 (선택한 사람 번호 목록 ids 를 여러 개 받는다)
  if (path === '/applicants/bulk-action' && method === 'POST') {
    const sp = new URLSearchParams(await request.text());
    const back = safeBack(sp.get('back')) || '/applicants';
    const ids = [...new Set(sp.getAll('ids').map((x) => parseInt(x, 10)).filter((x) => Number.isInteger(x) && x > 0))].slice(0, 200);
    if (!ids.length) return redirect(withParam(back, 'err', 'nopick'));
    const op = sp.get('op');
    // 면접 안내 만들기: 고른 사람으로 명단을 채운 만들기 화면으로 보낸다(여기서는 아무것도 바꾸지 않음)
    if (op === 'interview') return redirect(`/campaigns/new?ids=${ids.join(',')}`);
    const now = Date.now();
    const ph = ids.map(() => '?').join(',');
    const existing = (await all(db, `SELECT id FROM applicants WHERE id IN (${ph})`, ...ids)).map((r) => r.id);
    let done = 0, skipped = ids.length - existing.length;
    const stmts = [];
    if (op === 'blacklist') {
      const code = String(sp.get('reason_code') || '');
      const text = clip(sp.get('reason_text'), 300);
      if (!REASON_LABEL[code] || (code === 'other' && !text)) return redirect(withParam(back, 'err', 'reason'));
      const active = new Set((await all(db, `SELECT applicant_id FROM blacklist WHERE status='active' AND applicant_id IN (${ph})`, ...ids)).map((r) => r.applicant_id));
      for (const id of existing) {
        if (active.has(id)) { skipped++; continue; }
        done++;
        stmts.push(stmt(db, `INSERT INTO blacklist (applicant_id, reason_code, reason_text, created_by, created_at) VALUES (?,?,?,?,?)`, id, code, text, user.id, now));
        stmts.push(stmt(db, `UPDATE applicants SET updated_at=? WHERE id=?`, now, id));
        stmts.push(stmt(db, `INSERT INTO applicant_events (applicant_id, action, detail, user_id, at) VALUES (?,?,?,?,?)`, id, 'blacklist', `${REASON_LABEL[code]} (일괄)`, user.id, now));
      }
    } else if (op === 'release') {
      const note = clip(sp.get('note'), 200);
      const active = new Set((await all(db, `SELECT applicant_id FROM blacklist WHERE status='active' AND applicant_id IN (${ph})`, ...ids)).map((r) => r.applicant_id));
      for (const id of existing) {
        if (!active.has(id)) { skipped++; continue; }
        done++;
        stmts.push(stmt(db, `UPDATE blacklist SET status='released', released_by=?, released_at=?, release_note=? WHERE applicant_id=? AND status='active'`, user.id, now, note, id));
        stmts.push(stmt(db, `UPDATE applicants SET updated_at=? WHERE id=?`, now, id));
        stmts.push(stmt(db, `INSERT INTO applicant_events (applicant_id, action, detail, user_id, at) VALUES (?,?,?,?,?)`, id, 'release', clip(`${note || '해제'} (일괄)`, 100), user.id, now));
      }
    } else if (op === 'delete') {
      if (user.role !== 'super') return html(pg('접근 불가', '<p>삭제는 관리자만 할 수 있어요.</p>', 'applicants'), 403);
      done = existing.length;
      for (const id of existing) {
        stmts.push(stmt(db, `DELETE FROM applicant_events WHERE applicant_id=?`, id));
        stmts.push(stmt(db, `DELETE FROM blacklist WHERE applicant_id=?`, id));
        stmts.push(stmt(db, `DELETE FROM applicant_applications WHERE applicant_id=?`, id));
        stmts.push(stmt(db, `DELETE FROM applicants WHERE id=?`, id));
      }
    } else {
      return redirect(back);
    }
    for (let i = 0; i < stmts.length; i += 40) await db.batch(stmts.slice(i, i + 40));
    await audit(db, user, 'applicant.bulk_action', `op=${op} done=${done} skipped=${skipped}`);
    return redirect(withParam(withParam(withParam(back, 'ok', 'bulkop'), 'n', done), 'k', skipped));
  }
  // 문자 시스템 연결 설정(관리자) / 노쇼 후보 제안 처리
  if (path === '/applicants/settings' && method === 'POST') {
    if (user.role !== 'super') return html(pg('접근 불가', '<p>연결 설정은 관리자만 바꿀 수 있어요.</p>', 'applicants'), 403);
    const f = await readForm(request);
    const cur = await getLinkSettings(db);
    const on = f.enabled === '1';
    await saveLinkSettings(db, on
      ? { enabled: true, register: f.register === '1', history: f.history === '1', suggest: f.suggest === '1', flag: f.flag === '1', threshold: f.threshold }
      : { enabled: false, register: cur.raw.register, history: cur.raw.history, suggest: cur.raw.suggest, flag: cur.raw.flag, threshold: cur.threshold });
    await audit(db, user, 'applicant.link_settings', `enabled=${f.enabled === '1' ? 1 : 0}`);
    return redirect(withParam(safeBack(f.back) || '/applicants', 'ok', 'settings'));
  }
  if (path === '/applicants/suggest/register' && method === 'POST') {
    const f = await readForm(request);
    const back = safeBack(f.back) || '/applicants';
    const phone = normalizePhone(f.phone);
    const n = Math.max(1, parseInt(f.n, 10) || 1);
    const r = await saveApplicant(db, { name: f.name || '지원자', phone }, user.id, 'linked');
    if (!r.ok) return redirect(withParam(back, 'err', 'invalid'));
    const now = Date.now();
    const dup = await first(db, `SELECT id FROM blacklist WHERE applicant_id=? AND status='active'`, r.id);
    if (!dup) {
      await run(db, `INSERT INTO blacklist (applicant_id, reason_code, reason_text, created_by, created_at) VALUES (?,?,?,?,?)`,
        r.id, 'noshow', `면접 노쇼 ${n}회 기록 (후보 제안 승인)`, user.id, now);
      await run(db, `UPDATE applicants SET updated_at=? WHERE id=?`, now, r.id);
      await addEvent(db, r.id, 'blacklist', '면접 무단 불참 (노쇼 후보 제안 승인)', user.id, now);
      await audit(db, user, 'applicant.suggest_register', `id=${r.id} n=${n}`);
    }
    return redirect(withParam(back, 'ok', 'blacklisted'));
  }
  if (path === '/applicants/suggest/dismiss' && method === 'POST') {
    const f = await readForm(request);
    await dismissSuggestion(db, normalizePhone(f.phone), f.n, user.id);
    await audit(db, user, 'applicant.suggest_dismiss', '');
    return redirect(safeBack(f.back) || '/applicants');
  }
  // 업로드 되돌리기
  const bm = path.match(/^\/applicants\/batch\/([A-Za-z0-9]+)\/undo$/);
  if (bm && method === 'POST') {
    const f = await readForm(request);
    const back = safeBack(f.back) || '/applicants';
    const r = await undoBatch(db, bm[1]);
    if (!r.ok) return redirect(withParam(back, 'err', 'noactive'));
    await audit(db, user, 'applicant.batch_undo', `batch=${bm[1]} removed=${r.removed} kept=${r.kept}`);
    return redirect(`${withParam(withParam(withParam(back, 'ok', 'undone'), 'n', r.removed), 'k', r.kept)}`);
  }

  const m = path.match(/^\/applicants\/(\d+)(?:\/(blacklist|release|reason|edit|apply|delete|merge|panel))?$/);
  if (!m) return null;
  const id = Number(m[1]);
  const action = m[2];

  if (method === 'GET' && action === 'panel') {
    const frag = await renderApplicantPanel(db, id, { user, link: await getLinkSettings(db) });
    if (frag === null) return html('', 404);
    return html(frag);
  }
  if (method === 'GET' && !action) {
    const sp = url.searchParams;
    const note = sp.get('ok') === 'posting'
      ? `<div class="notice ok">${icon('check')}<div>원가중심점을 정했어요. 같은 공고로 지원한 <b>${Number(sp.get('n')) || 0}건</b>에 적용했어요. 앞으로 같은 공고도 자동으로 정리돼요.${Number(sp.get('fr')) ? ` 대기 중인 ${Number(sp.get('fr'))}명의 연락처 가져오기도 요청했어요.` : ''}</div></div>`
      : (sp.get('err') === 'cclist' ? `<div class="notice warn" role="alert">${icon('alert')}<div>원가중심점 목록에 없는 이름이에요. 공고 정리에서 목록을 확인해 주세요.</div></div>` : '');
    const body = await renderApplicantDetail(db, id, { user, notice: note, link: await getLinkSettings(db) });
    if (!body) return html(pg('없음', '<p>지원자를 찾을 수 없어요.</p>', 'applicants'), 404);
    await audit(db, user, 'applicant.view', `id=${id}`);
    return page('지원자 상세', body);
  }
  if (method !== 'POST' || !action) return null;

  const person = await first(db, `SELECT id FROM applicants WHERE id=?`, id);
  if (!person) return html(pg('없음', '<p>지원자를 찾을 수 없어요.</p>', 'applicants'), 404);
  const f = await readForm(request);
  const now = Date.now();
  const back = safeBack(f.back);
  const done = (flash) => redirect(back ? withParam(back, 'ok', flash) : `/applicants/${id}`);
  const fail = (err) => redirect(back ? withParam(back, 'err', err) : `/applicants/${id}`);
  const detailError = async (message) => {
    const body = await renderApplicantDetail(db, id, { user,
      notice: `<div class="notice warn" role="alert">${icon('alert')}<div>${esc(message)}</div></div>` });
    return html(pg('지원자 상세', body, 'applicants'), 400);
  };

  if (action === 'blacklist') {
    const code = String(f.reason_code || '');
    const text = clip(f.reason_text, 300);
    if (!REASON_LABEL[code]) return redirect(`/applicants/${id}`);
    if (code === 'other' && !text) {
      if (back) return fail('reason');
      return detailError('"기타"를 고르면 사유 설명을 꼭 적어 주세요.');
    }
    const dup = await first(db, `SELECT id FROM blacklist WHERE applicant_id=? AND status='active'`, id);
    if (!dup) {
      await run(db, `INSERT INTO blacklist (applicant_id, reason_code, reason_text, created_by, created_at) VALUES (?,?,?,?,?)`,
        id, code, text, user.id, now);
      await run(db, `UPDATE applicants SET updated_at=? WHERE id=?`, now, id);
      await addEvent(db, id, 'blacklist', REASON_LABEL[code], user.id, now);
      await audit(db, user, 'applicant.blacklist', `id=${id} reason=${code}`);
    }
    return done('blacklisted');
  } else if (action === 'reason') {
    const code = String(f.reason_code || '');
    const text = clip(f.reason_text, 300);
    if (!REASON_LABEL[code]) return redirect(`/applicants/${id}`);
    if (code === 'other' && !text) {
      if (back) return fail('reason');
      return detailError('"기타"를 고르면 사유 설명을 꼭 적어 주세요.');
    }
    const cur = await first(db, `SELECT id, reason_code FROM blacklist WHERE applicant_id=? AND status='active'`, id);
    if (!cur) {
      if (back) return fail('noactive');
      return detailError('블랙리스트에 등록되어 있지 않아요.');
    }
    await run(db, `UPDATE blacklist SET reason_code=?, reason_text=? WHERE id=?`, code, text, cur.id);
    await run(db, `UPDATE applicants SET updated_at=? WHERE id=?`, now, id);
    await addEvent(db, id, 'blacklist_edit', `${REASON_LABEL[cur.reason_code] || cur.reason_code} → ${REASON_LABEL[code]}`, user.id, now);
    await audit(db, user, 'applicant.reason', `id=${id} reason=${code}`);
    return done('reasoned');
  } else if (action === 'release') {
    const r = await run(db,
      `UPDATE blacklist SET status='released', released_by=?, released_at=?, release_note=? WHERE applicant_id=? AND status='active'`,
      user.id, now, clip(f.note, 200), id);
    if (r.meta.changes) {
      await run(db, `UPDATE applicants SET updated_at=? WHERE id=?`, now, id);
      await addEvent(db, id, 'release', clip(f.note, 100) || '해제', user.id, now);
      await audit(db, user, 'applicant.release', `id=${id}`);
    }
    return done('released');
  } else if (action === 'edit') {
    const p = normalizePhone(f.phone);
    const n = clip(f.name, 50);
    if (!n || !isValidMobile(p)) {
      if (back) return fail('invalid');
      return detailError('이름과 휴대폰 번호를 확인해 주세요.');
    }
    const clash = await first(db, `SELECT id FROM applicants WHERE phone=? AND id!=?`, p, id);
    if (clash) {
      if (back) return fail('clash');
      return detailError('같은 번호의 다른 지원자가 이미 있어요.');
    }
    const cur = await first(db, `SELECT memo FROM applicants WHERE id=?`, id);
    await run(db, `UPDATE applicants SET name=?, phone=?, memo=?, updated_at=? WHERE id=?`, n, p,
      f.memo === undefined ? (cur ? cur.memo : '') : clip(f.memo, 500), now, id);
    // 표에서 고친 "지원한 곳/직무"는 가장 최근 지원 건에 반영한다
    if (f.applied_to !== undefined || f.job !== undefined) {
      const a = clip(f.applied_to, 100), j = clip(f.job, 100);
      const latest = await first(db, `SELECT id FROM applicant_applications WHERE applicant_id=? ORDER BY id DESC LIMIT 1`, id);
      if (latest) await run(db, `UPDATE applicant_applications SET applied_to=?, job=? WHERE id=?`, a, j, latest.id);
      else if (a || j) await run(db, `INSERT INTO applicant_applications (applicant_id, applied_to, job, created_by, created_at) VALUES (?,?,?,?,?)`, id, a, j, user.id, now);
    }
    await addEvent(db, id, 'edit', '이름·전화번호·메모 수정', user.id, now);
    await audit(db, user, 'applicant.edit', `id=${id}`);
    return done('edited');
  } else if (action === 'apply') {
    const a = clip(f.applied_to, 100), j = clip(f.job, 100);
    if (a || j) {
      await run(db, `INSERT INTO applicant_applications (applicant_id, applied_to, job, created_by, created_at) VALUES (?,?,?,?,?)`,
        id, a, j, user.id, now);
      await run(db, `UPDATE applicants SET updated_at=? WHERE id=?`, now, id);
      await addEvent(db, id, 'apply', '지원 건 추가', user.id, now);
    }
  } else if (action === 'merge') {
    let other = null;
    if (f.other_id) other = await first(db, `SELECT id FROM applicants WHERE id=?`, parseInt(f.other_id, 10) || 0);
    else if (f.other_phone) other = await first(db, `SELECT id FROM applicants WHERE phone=?`, normalizePhone(f.other_phone));
    if (!other) {
      if (back) return fail('nomerge');
      return detailError('합칠 지원자를 찾지 못했어요. 번호를 확인해 주세요.');
    }
    if (other.id === id) {
      if (back) return fail('mergeself');
      return detailError('같은 지원자끼리는 합칠 수 없어요.');
    }
    await mergeApplicants(db, id, other.id, user.id);
    await audit(db, user, 'applicant.merge', `into=${id} from=${other.id}`);
    return redirect(withParam(`/applicants/${id}`, 'ok', 'merged'));
  } else if (action === 'delete') {
    if (user.role !== 'super') return html(pg('접근 불가', '<p>삭제는 관리자만 할 수 있어요.</p>', 'applicants'), 403);
    await run(db, `DELETE FROM applicant_events WHERE applicant_id=?`, id);
    await run(db, `DELETE FROM blacklist WHERE applicant_id=?`, id);
    await run(db, `DELETE FROM applicant_applications WHERE applicant_id=?`, id);
    await run(db, `DELETE FROM applicants WHERE id=?`, id);
    await audit(db, user, 'applicant.delete', `id=${id}`);
    return redirect(withParam('/applicants', 'ok', 'deleted'));
  }
  return done('edited');
}
