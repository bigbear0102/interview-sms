// AI 보조 기능(NVIDIA, src/ai.js): 언제나 "규칙이 먼저, AI 는 규칙이 못 할 때만, 결정은 사람이" 원칙.
//  (지원 메일 본문을 AI 로 읽는 기능은 이력 정보가 외부로 나가서 넣지 않았다 — 사용자 결정 대기)
//  2) 공고 → 원가중심점 추천(aiSuggestPostings) — 목록(cost_centers)에 있는 이름만, 확정은 사람이 "적용".
//  3) 명단 열 맞추기(aiMapColumns) — 제목 줄과 모양만(값은 가림) 보낸다.
//  4) 면접일시 형식 맞추기(aiNormalizeWhens) — "다음주 화 2시" → "10/21(화) 14:00". 바꾼 내용은 화면에 보여 준다.
//  5) 안내 문구 점검(aiCheckTemplate) — 자리 표시({이름} 등)가 빠지면 버린다. 바꾸기는 사람이 누른다.
import { all, first, run } from './d1.js';
import { askJson, todayKst, aiEnabled, WHEN_SPEC, resolveWhen } from './ai.js';
import { parseInterviewAt } from './reminders.js';
import { normalizePhone, isValidMobile } from './parser.js';

const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

// ---------------- 2) 공고 → 원가중심점 추천 ----------------
const POSTING_SYSTEM = `채용 공고를 회사 내부 원가중심점(현장 이름) 목록 중 하나에 연결한다. JSON 한 개만 출력한다.
형식: {"costCenter":"목록에 있는 이름 그대로 또는 빈 문자열","job":"직무(10자 이내, 예: 주차관리)","confidence":0~1,"reason":"근거(20자 이내)"}
- 공고 제목·회사명에 나온 고객사·지점·현장 이름과 같은 것을 고른다. 근거가 약하면 빈 문자열과 낮은 confidence.
- 목록에 없는 이름을 만들지 않는다.`;

// 정리 안 된 공고 중 아직 추천이 없는 것을 몇 개씩 추천해 둔다(주기 작업). 반환: 추천한 공고 수
export async function aiSuggestPostings(env, { now = Date.now(), limit = 2 } = {}) {
  if (!aiEnabled(env)) return 0;
  const db = env.DB;
  const todo = await all(db, `
    SELECT recruit_no, MAX(title) title, MAX(company) company FROM (
      SELECT recruit_no, posting_title title, company_raw company FROM applicant_applications WHERE recruit_no != '' AND applied_to = ''
      UNION ALL
      SELECT recruit_no, job_title, company FROM applicant_inbox WHERE status='pending' AND recruit_no != '' AND cost_center = ''
    ) WHERE recruit_no NOT IN (SELECT recruit_no FROM ai_postings) GROUP BY recruit_no LIMIT ?`, limit);
  if (!todo.length) return 0;
  const names = (await all(db, `SELECT name FROM cost_centers ORDER BY name LIMIT 1500`)).map((r) => r.name);
  if (!names.length) return 0;
  const set = new Set(names);
  const jobs = (await all(db, `SELECT job FROM applicant_applications WHERE job != '' GROUP BY job ORDER BY COUNT(*) DESC LIMIT 30`)).map((r) => r.job);
  let n = 0;
  for (const g of todo) {
    const j = await askJson(env, { system: POSTING_SYSTEM, maxTokens: 2000,
      user: `공고 제목: ${clip(g.title, 200)}\n회사명: ${clip(g.company, 100)}\n자주 쓰는 직무: ${jobs.join(', ') || '없음'}\n원가중심점 목록:\n${names.join('\n')}` });
    if (!j || j.error) break;   // 실패하면 다음 주기에 다시
    const cc = set.has(String(j.costCenter || '')) && Number(j.confidence) >= 0.6 ? j.costCenter : '';
    await run(db, `INSERT OR REPLACE INTO ai_postings (recruit_no, cost_center, job, note, at) VALUES (?,?,?,?,?)`,
      g.recruit_no, cc, cc ? clip(j.job, 20) : '', cc ? clip(j.reason, 40) : '', now);
    n++;
  }
  return n;
}

export async function aiPostingSuggestion(db, recruitNo) {
  return first(db, `SELECT cost_center, job, note FROM ai_postings WHERE recruit_no=? AND cost_center != ''`, recruitNo).catch(() => null);
}

// ---------------- 3) 명단 열 맞추기 ----------------
// 값은 모양만 남긴다(한글→가, 영문→a, 숫자→0): 개인정보를 보내지 않는다
export const shapeOf = (v) => String(v ?? '').trim().slice(0, 30).replace(/[가-힣]/g, '가').replace(/[a-z]/gi, 'a').replace(/\d/g, '0');
const COLS_SYSTEM = `엑셀 명단의 각 열이 무엇인지 맞힌다. JSON 한 개만 출력한다.
형식: {"hasHeader":true|false,"site":열 번호 또는 -1,"name":열 번호 또는 -1,"phone":열 번호 또는 -1,"interview_at":열 번호 또는 -1}
- 열 번호는 0부터. site=사업장·근무지·현장·원가중심점, name=이름, phone=휴대폰 번호, interview_at=면접 일시.
- 값은 개인정보 보호를 위해 모양만 보인다(가=한글, a=영문, 0=숫자).`;

// rows: parseCsv 결과. 반환: { idx, hasHeader } | null
export async function aiMapColumns(env, rows) {
  if (!rows.length) return null;
  const width = Math.min(30, Math.max(...rows.slice(0, 5).map((r) => r.length)));
  const head = rows[0].slice(0, width).map((h) => clip(h, 30));
  const sample = rows.slice(1, 4).map((r) => r.slice(0, width).map(shapeOf));
  const firstShape = rows[0].slice(0, width).map(shapeOf);
  const j = await askJson(env, { system: COLS_SYSTEM, maxTokens: 800,
    user: `열 수: ${width}\n첫 줄(제목일 수도 있음): ${JSON.stringify(head)}\n첫 줄 모양: ${JSON.stringify(firstShape)}\n다음 줄 모양: ${JSON.stringify(sample)}` });
  if (!j || j.error) return null;
  const col = (k) => (Number.isInteger(j[k]) && j[k] >= 0 && j[k] < width ? j[k] : -1);
  const idx = { site: col('site'), name: col('name'), phone: col('phone'), interview_at: col('interview_at') };
  if (idx.phone < 0) return null;
  // 전화번호 칸은 실제 값으로 확인한다(절반 넘게 휴대폰 번호여야 함)
  const data = j.hasHeader === false ? rows : rows.slice(1);
  const vals = data.slice(0, 30).map((r) => (r[idx.phone] ?? '').trim()).filter(Boolean);
  if (!vals.length || vals.filter((v) => isValidMobile(normalizePhone(v))).length / vals.length < 0.5) return null;
  return { idx, hasHeader: j.hasHeader !== false };
}

// ---------------- 4) 면접일시 형식 맞추기 ----------------
const WHEN_SYSTEM = `면접 일시 표현 하나를 일시 객체로 나눈다. 일시 객체 JSON 한 개만 출력한다(알 수 없으면 null).
${WHEN_SPEC}`;

// values: 읽을 수 없는 면접일시 표현들(같은 값은 한 번, 최대 12개). 하나씩 묻는다(여러 개를 한 번에 물으면 JSON 이 깨지는 일이 있었다).
// 날짜 계산과 원문 확인은 코드가 한다(resolveWhen). 반환: Map(원래 → 바꾼 값)
export async function aiNormalizeWhens(env, values, now = Date.now()) {
  const out = new Map();
  const list = [...new Set(values.map((v) => String(v || '').trim()).filter(Boolean))].slice(0, 12);
  for (let i = 0; i < list.length; i += 4) {   // 4개씩 동시에
    await Promise.all(list.slice(i, i + 4).map(async (from) => {
      const j = await askJson(env, { system: WHEN_SYSTEM, maxTokens: 800, user: `오늘: ${todayKst(now)}\n표현: ${clip(from, 60)}` }).catch(() => null);
      if (!j || j.error) return;
      const to = resolveWhen(j, now, from);
      const at = to ? parseInterviewAt(to, now) : NaN;
      // 시스템이 읽을 수 있고, 지난 날짜가 아니고, 1년 안인 것만
      if (Number.isFinite(at) && at > now - 86400000 && at < now + 366 * 86400000) out.set(from, to);
    }));
  }
  return new Map(list.filter((v) => out.has(v)).map((v) => [v, out.get(v)]));
}

// ---------------- 5) 안내 문구 점검 ----------------
const TPL_SYSTEM = `면접 안내 문자 문구를 점검하고 다듬는다. JSON 한 개만 출력한다.
형식: {"text":"다듬은 문구","issues":["빠지거나 고칠 점(각 30자 이내, 최대 4개)"]}
- 중괄호 자리 표시({이름} {면접일시} {일정목록} {사업장})는 글자 그대로 남긴다. 새 자리 표시를 만들지 않는다.
- 답장 방법 안내("참석"/"불참" 또는 번호로 답장)는 반드시 남긴다.
- 쉽고 정중하게, 원래 정보는 빼지 않고, 없는 정보(주소·연락처 등)를 지어내지 않는다. 빠진 정보는 issues 에 적는다(예: 면접 장소가 없어요).
- 단문(한글 45자) 넘으면 장문 요금이라는 점은 신경 쓰지 말고 읽기 쉽게.`;
const PLACEHOLDERS = ['{이름}', '{면접일시}', '{일정목록}', '{사업장}'];

// 반환: { text, issues } | { error }
export async function aiCheckTemplate(env, { template, kind }) {
  const src = String(template || '').replace(/\r\n?/g, '\n').trim().slice(0, 1500);
  if (!src) return { error: 'empty' };
  const j = await askJson(env, { system: TPL_SYSTEM, maxTokens: 2000,
    user: `안내 방식: ${kind === 'slots' ? '후보 일정 중 번호로 고르게 함({일정목록})' : '정해진 면접일시를 알리고 참석/불참 답장을 받음'}\n문구:\n${src}` });
  if (!j) return { error: 'off' };
  if (j.error) return { error: j.error };
  const text = String(j.text ?? '').replace(/\r\n?/g, '\n').trim().slice(0, 1500);
  // 원래 있던 자리 표시가 빠졌거나 없던 자리 표시가 생기면 쓰지 않는다
  const used = (s) => PLACEHOLDERS.filter((p) => s.includes(p)).join();
  if (!text || used(text) !== used(src) || /\{[^}]*\}/.test(text.replace(/\{(이름|면접일시|일정목록|사업장)\}/g, ''))) return { error: 'placeholder' };
  const issues = (Array.isArray(j.issues) ? j.issues : []).map((x) => clip(x, 40)).filter(Boolean).slice(0, 4);
  return { text, issues };
}
