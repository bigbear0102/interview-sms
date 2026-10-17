// 알바몬 이력서 전체 저장·정리(확장 v1.9 가 이력서 화면의 글 전체·항목 쌍·제목을 보낸다).
// - 화면 구조를 미리 알 수 없으므로 원본(글 전체, 항목 쌍)을 그대로 남기고, 아는 항목만 규칙으로 정리한다(parsed).
// - 이력서는 개인정보다: AI 로 보내지 않는다. 지원자를 지우면 그 사람 이력서도 지운다(deleteResumesOf).
import { all, first, run } from './d1.js';
import { esc } from './views.js';

const MAX_TEXT = 60000;
const clip = (s, n) => String(s ?? '').replace(/\r/g, '').slice(0, n);
const one = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// 항목 이름 → 정리한 이름(앞에서부터 맞는 것)
const KNOWN = [
  ['email', /e-?mail|이메일|메일/i],
  ['birth', /생년월일|출생/],
  ['age', /^나이$|연령/],
  ['gender', /^성별$/],
  ['address', /주소|거주지/],
  ['education', /최종\s*학력|^학력$/],
  ['school', /학교명|출신\s*학교/],
  ['major', /전공/],
  ['career', /총\s*경력|^경력$|경력\s*사항/],
  ['license', /자격증|자격\s*사항|면허/],
  ['military', /병역/],
  ['hopeJob', /희망\s*(업직종|직종|업종|직무)/],
  ['hopeArea', /희망\s*(근무)?\s*(지역|근무지)/],
  ['hopeType', /희망\s*근무\s*형태|근무\s*형태|고용\s*형태/],
  ['hopePay', /희망\s*(급여|연봉|시급|월급)/],
  ['hopeTime', /희망\s*근무\s*(요일|시간|기간)|근무\s*가능\s*(요일|시간)/],
  ['skills', /보유\s*기술|컴퓨터\s*활용|외국어|어학/],
  ['disability', /장애/],
  ['veteran', /보훈/]
];
export const KNOWN_LABEL = {
  email: '이메일', birth: '생년월일', age: '나이', gender: '성별', address: '주소', education: '최종 학력', school: '학교', major: '전공',
  career: '경력', license: '자격증', military: '병역', hopeJob: '희망 직종', hopeArea: '희망 근무지', hopeType: '근무 형태',
  hopePay: '희망 급여', hopeTime: '근무 가능 시간', skills: '기술·어학', disability: '장애', veteran: '보훈', intro: '자기소개'
};

// 이력서 화면 내용(확장이 보낸 것) → 저장할 모양으로 검사·정리
export function normalizeResume(r) {
  if (!r || typeof r !== 'object') return null;
  const text = clip(r.text, MAX_TEXT).replace(/\n{3,}/g, '\n\n').trim();
  if (text.length < 20) return null;
  const pairs = (Array.isArray(r.pairs) ? r.pairs : []).slice(0, 300)
    .map((p) => (Array.isArray(p) ? [one(p[0]).slice(0, 40), clip(p[1], 1000).trim()] : null))
    .filter((p) => p && p[0] && p[1]);
  const sections = (Array.isArray(r.sections) ? r.sections : []).map((s) => one(s).slice(0, 40)).filter(Boolean).slice(0, 80);
  return { text, pairs, sections, url: clip(r.url, 500), title: one(r.title).slice(0, 200) };
}

// 아는 항목만 정리한다. 반환: { email, birth, ..., intro }
export function parseResume({ text, pairs, sections }) {
  const out = {};
  for (const [k, v] of pairs) {
    const hit = KNOWN.find(([, re]) => re.test(k));
    if (hit && !out[hit[0]]) out[hit[0]] = one(v).slice(0, 300);
  }
  // 이메일은 글에서도 찾는다
  if (!out.email) { const m = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/); if (m && !/albamon/i.test(m[0])) out.email = m[0]; }
  // 자기소개: "자기소개" 제목 다음부터 다음 제목 전까지
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^\s*자기\s*소개/.test(l));
  if (start >= 0) {
    const heads = new Set(sections);
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) if (heads.has(one(lines[i])) && !/자기\s*소개/.test(lines[i])) { end = i; break; }
    const intro = lines.slice(start + 1, end).join('\n').trim();
    if (intro) out.intro = intro.slice(0, 4000);
  }
  return out;
}

// 확장 결과 저장(연락처 결과와 함께 온다)
export async function saveResume(db, inboxId, applyNo, raw, now = Date.now()) {
  const r = normalizeResume(raw);
  if (!r) return false;
  const parsed = parseResume(r);
  await run(db, `INSERT INTO applicant_resumes (inbox_id, apply_no, page_url, page_title, text, pairs, sections, parsed, fetched_at) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(inbox_id) DO UPDATE SET apply_no=excluded.apply_no, page_url=excluded.page_url, page_title=excluded.page_title, text=excluded.text,
        pairs=excluded.pairs, sections=excluded.sections, parsed=excluded.parsed, fetched_at=excluded.fetched_at`,
    inboxId, String(applyNo || ''), r.url, r.title, r.text, JSON.stringify(r.pairs), JSON.stringify(r.sections), JSON.stringify(parsed), now);
  return true;
}

const parseJson = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const rowOut = (x) => x && { ...x, pairs: parseJson(x.pairs, []), sections: parseJson(x.sections, []), parsed: parseJson(x.parsed, {}) };

export async function resumeOfInbox(db, inboxId) {
  return rowOut(await first(db, `SELECT * FROM applicant_resumes WHERE inbox_id=?`, inboxId));
}
// 지원자(등록된 사람)의 가장 최근 이력서
export async function resumeOfApplicant(db, applicantId, phone) {
  return rowOut(await first(db, `SELECT r.* FROM applicant_resumes r JOIN applicant_inbox i ON i.id=r.inbox_id
      WHERE i.applicant_id=? OR (i.phone != '' AND i.phone=?) ORDER BY r.fetched_at DESC LIMIT 1`, applicantId, phone || '-'));
}

export async function deleteResumesOf(db, applicantId) {
  await run(db, `DELETE FROM applicant_resumes WHERE inbox_id IN (SELECT id FROM applicant_inbox WHERE applicant_id=?)`, applicantId);
}

// 화면 조각: 정리한 항목 + 모든 항목 + 화면 글 전체(접힘)
export function resumePanel(r, { mailFields = null } = {}) {
  if (!r) return '';
  const p = r.parsed || {};
  const known = Object.keys(KNOWN_LABEL).filter((k) => p[k] && k !== 'intro');
  const when = new Date(r.fetched_at + 9 * 3600000).toISOString().slice(0, 16).replace('T', ' ');
  return `<section class="panel resume" id="resume"><h2>알바몬 이력서 <small class="muted" style="font-weight:400">${esc(when)} 가져옴</small></h2>
    ${known.length ? `<dl class="rkv">${known.map((k) => `<dt>${esc(KNOWN_LABEL[k])}</dt><dd>${esc(p[k])}</dd>`).join('')}</dl>` : ''}
    ${p.intro ? `<details class="rsec"><summary>자기소개</summary><p class="msg">${esc(p.intro)}</p></details>` : ''}
    ${r.pairs.length ? `<details class="rsec"><summary>이력서의 모든 항목 (${r.pairs.length})</summary><dl class="rkv">${r.pairs.map(([k, v]) => `<dt>${esc(k)}</dt><dd class="msg">${esc(v)}</dd>`).join('')}</dl></details>` : ''}
    ${mailFields && Object.keys(mailFields).length ? `<details class="rsec"><summary>지원 메일 항목 (${Object.keys(mailFields).length})</summary><dl class="rkv">${Object.entries(mailFields).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl></details>` : ''}
    <details class="rsec"><summary>이력서 화면 글 전체</summary><p class="msg rtext">${esc(r.text)}</p></details>
    ${r.page_url ? `<p class="muted" style="font-size:13px;margin-top:8px"><a href="${esc(r.page_url)}" target="_blank" rel="noopener">알바몬에서 원본 보기 ↗</a></p>` : ''}
  </section>`;
}

export const RESUME_CSS = `<style>
.resume .rkv{display:grid;grid-template-columns:minmax(90px,max-content) 1fr;gap:6px 14px;margin:8px 0 0;font-size:14px}
.resume .rkv dt{color:var(--muted)}
.resume .rkv dd{margin:0;overflow-wrap:anywhere}
.resume .rsec{margin-top:10px;border-top:1px solid var(--line-soft);padding-top:8px}
.resume .rsec>summary{cursor:pointer;color:var(--blue);font-size:14px}
.resume .rtext{font-size:13px;max-height:420px;overflow:auto;background:var(--surface-2);border-radius:10px;padding:10px 12px;margin-top:6px}
@media (max-width:520px){.resume .rkv{grid-template-columns:1fr}.resume .rkv dt{margin-top:6px}}
</style>`;

// 분석: 저장된 이력서·메일에서 어떤 항목을 얼마나 가져왔는지(관리자 화면)
export async function resumeFieldStats(db) {
  const rows = await all(db, `SELECT pairs, sections, parsed FROM applicant_resumes ORDER BY fetched_at DESC LIMIT 500`);
  const labels = new Map(), secs = new Map(), known = new Map();
  for (const r of rows) {
    for (const [k] of parseJson(r.pairs, [])) labels.set(k, (labels.get(k) || 0) + 1);
    for (const s of parseJson(r.sections, [])) secs.set(s, (secs.get(s) || 0) + 1);
    for (const k of Object.keys(parseJson(r.parsed, {}))) known.set(k, (known.get(k) || 0) + 1);
  }
  const mails = await all(db, `SELECT mail_fields FROM applicant_inbox WHERE mail_fields != '' ORDER BY id DESC LIMIT 500`);
  const mailLabels = new Map();
  for (const m of mails) for (const k of Object.keys(parseJson(m.mail_fields, {}))) mailLabels.set(k, (mailLabels.get(k) || 0) + 1);
  const top = (m, n) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n);
  const inbox = await first(db, `SELECT COUNT(*) n, SUM(resume_url != '') url, SUM(phone != '') phone FROM applicant_inbox`);
  return { resumes: rows.length, mails: mails.length, labels: top(labels, 150), sections: top(secs, 80), known: top(known, 30), mailLabels: top(mailLabels, 60), inbox };
}
