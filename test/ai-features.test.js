// AI 보조 기능(일정 변경 희망 일시, 질문 답장 초안, 일반 문자 분류, 공고 추천, 명단 열·면접일시 맞추기, 문구 점검).
// 가짜 AI 만 쓴다(실제 API 접속 없음, AGENTS 규칙 14). 보낸 내용에 개인정보가 없는지도 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openSqliteD1 } from '../src/node/d1-sqlite.js';
import { handleRequest } from '../src/worker.js';
import { createSession } from '../src/auth.js';
import { hashPassword, encryptText } from '../src/crypto.js';
import { createCampaign, handleInbound } from '../src/core.js';
import { aiReviewReply, maskGuide } from '../src/reply-ai.js';
import { aiSuggestPostings, aiNormalizeWhens, aiCheckTemplate, shapeOf } from '../src/ai-features.js';
import { resolveWhen } from '../src/ai.js';

// 가짜 AI: (system, user) → 돌려줄 객체(또는 'fail'). 보낸 요청을 기록한다.
function fakeAi(route) {
  const sent = [];
  const fn = async (url, init) => {
    const body = JSON.parse(init.body);
    const system = body.messages[0].content, user = body.messages[1].content;
    sent.push({ system, user });
    const a = route(system, user);
    if (a === 'fail' || a === undefined) return new Response('busy', { status: 503 });
    return Response.json({ choices: [{ message: { content: typeof a === 'string' ? a : JSON.stringify(a) } }] });
  };
  fn.sent = sent;
  return fn;
}

async function setup(route = () => undefined, { ai = true } = {}) {
  const db = openSqliteD1(':memory:', fileURLToPath(new URL('../migrations', import.meta.url)));
  const AI_FETCH = fakeAi(route);
  const env = { DB: db, ENCRYPTION_KEY: 'k', PUBLIC_BASE_URL: 'https://example.test', GATEWAY_URL: 'https://sms.example.test/api/3rdparty/v1', NO_REAL_NETWORK: true,
    ...(ai ? { NVIDIA_API_KEY: 'nvapi-test', AI_FETCH } : {}) };
  const u = await db.prepare(`INSERT INTO users (username,pass_hash,role,email_verified_at,name,email) VALUES ('boss',?,'super',1,'김관리','boss@willvi.co.kr')`).bind(await hashPassword('password123')).run();
  const sid = await createSession(db, Number(u.meta.last_row_id));
  await db.prepare(`INSERT INTO departments (name) VALUES ('인사팀')`).run();
  await db.prepare(`INSERT INTO gateways (department_id,name,username,password,hook_token) VALUES (1,'폰','u',?,'t')`).bind(await encryptText('k', 'pw')).run();
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p) };
  const call = (path, init = {}) => handleRequest(new Request('https://example.test' + path, {
    ...init, headers: { cookie: `sid=${sid}`, origin: 'https://example.test', ...(init.headers || {}) }
  }), env, ctx);
  const post = (path, fields) => call(path, { method: 'POST', body: new URLSearchParams(fields).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });
  const settle = async () => { while (pending.length) await pending.shift(); };
  return { db, env, call, post, settle, AI_FETCH };
}
const GUIDE = '{이름}님, 강남 주차장 면접 안내입니다.\n일시: {면접일시}\n장소: 서울 강남구 테헤란로 1, 3층\n준비물: 신분증\n참석/불참으로 답장 주세요.';
async function campaign(db, { slots = [] } = {}) {
  await createCampaign(db, { departmentId: 1, gatewayId: 1, name: '안내', template: GUIDE, userId: null, slots,
    candidates: [{ site: '강남', name: '가나다', phone: '01011110001', interview_at: '10/22 10:00' }] });
  await db.prepare(`UPDATE candidates SET status='sent', sent_at=?, message_text=?`).bind(Date.now(),
    '가나다님, 강남 주차장 면접 안내입니다.\n일시: 10/22 10:00\n장소: 서울 강남구 테헤란로 1, 3층\n준비물: 신분증\n참석/불참으로 답장 주세요. 문의 010-9999-8888').run();
  await db.prepare(`UPDATE campaigns SET status='done'`).run();
}
const cand = (db) => db.prepare(`SELECT * FROM candidates WHERE phone='01011110001'`).first();
async function reply(env, message) {
  const r = await handleInbound(env.DB, 1, { sender: '01011110001', message });
  return aiReviewReply(env, { candidateId: r.candidateId, message, at: r.at });
}

test('일정 변경 요청: 원하는 일시를 뽑아 "다시 안내" 칸에 미리 채움(보내기는 담당자)', async () => {
  const { db, env, call } = await setup((sys) => sys.includes('지원자 답장을 분류') ? { intent: 'reschedule', wanted: { month: 10, day: 25, time: '10:00' }, confidence: 0.95, note: '25일 오전 희망' } : undefined);
  await campaign(db);
  await reply(env, '25일 오전 10시는 안될까요?');
  const c = await cand(db);
  assert.equal(c.reply_kind, 'reschedule');
  assert.match(c.ai_wanted, /^10\/25\(.\) 10:00$/);
  assert.match(c.ai_note, /AI: 일정 변경 요청\(10\/25\(.\) 10:00 희망\)/);
  const page = await (await call('/campaigns/1')).text();
  assert.match(page, /name="when" required value="10\/25\(.\) 10:00"/);
  assert.equal((await db.prepare(`SELECT COUNT(*) n FROM messages`).first()).n, 0);   // 자동으로 보내지 않음
});

test('일정 변경 요청: 읽을 수 없는 희망 일시는 채우지 않음', async () => {
  const { db, env } = await setup(() => ({ intent: 'reschedule', wanted: { weekOffset: 1, time: null }, confidence: 0.95, note: '' }));
  await campaign(db);
  await reply(env, '다음주쯤 가능할까요');
  assert.equal((await cand(db)).ai_wanted, '');
});

test('질문: 안내 문자 안의 정보로 답장 초안 → 담당자가 보내기, 이름·번호는 AI 에 보내지 않음', async () => {
  const { db, env, call, post, AI_FETCH } = await setup((sys) => sys.includes('지원자 답장을 분류')
    ? { intent: 'question', confidence: 0.95, note: '준비물 문의' }
    : sys.includes('답장 문자 초안') ? { answerable: true, reply: '신분증만 챙겨 오시면 됩니다.' } : undefined);
  await campaign(db);
  await reply(env, '준비물 있나요?');
  const c = await cand(db);
  assert.equal(c.status, 'unclear');
  assert.equal(c.ai_draft, '신분증만 챙겨 오시면 됩니다.');
  const draftReq = AI_FETCH.sent.find((x) => x.system.includes('답장 문자 초안'));
  assert.match(draftReq.user, /OOO님, 강남 주차장/);
  assert.ok(!draftReq.user.includes('가나다') && !draftReq.user.includes('9999') && !draftReq.user.includes('1111'));
  const page = await (await call('/campaigns/1')).text();
  assert.match(page, /AI 답장 초안/);
  const res = await post('/campaigns/1/answer', { id: String(c.id), text: '신분증만 챙겨 오세요!' });
  assert.equal(res.status, 303);
  const m = await db.prepare(`SELECT * FROM messages`).first();
  assert.equal(m.phone, '01011110001');
  assert.equal(m.text, '신분증만 챙겨 오세요!');
  assert.equal((await cand(db)).ai_draft, '');
});

test('질문: 안내에 답이 없으면 초안을 만들지 않음', async () => {
  const { db, env } = await setup((sys) => sys.includes('지원자 답장을 분류') ? { intent: 'question', confidence: 0.95, note: '주차 문의' } : { answerable: false, reply: '' });
  await campaign(db);
  await reply(env, '주차 되나요?');
  assert.equal((await cand(db)).ai_draft, '');
});

test('안내 문자 가리기', () => {
  assert.equal(maskGuide('홍길동님 010-1234-5678 로 연락', { name: '홍길동' }), 'OOO님 010-XXXX-XXXX 로 연락');
});

test('일반 문자(면접 안내와 연결 안 됨): 종류·요약을 문자함에 표시', async () => {
  const { db, call, settle } = await setup((sys) => sys.includes('채용 담당 휴대폰으로 온 문자') ? { kind: 'apply', note: '주말 근무 가능 여부 문의' } : undefined);
  const res = await call('/hook/1/t', { method: 'POST', body: JSON.stringify({ event: 'sms:received', payload: { sender: '01055556666', message: '주말 알바 아직 뽑나요?' } }) });
  assert.equal(res.status, 200);
  await settle();
  const r = await db.prepare(`SELECT ai_note FROM inbound`).first();
  assert.equal(r.ai_note, 'AI: 지원 문의 · 주말 근무 가능 여부 문의');
  const page = await (await call('/messages')).text();
  assert.match(page, /AI: 지원 문의/);
});

test('공고 원가중심점 추천: 목록에 있는 이름만, 확정은 사람이', async () => {
  const { db, env, call } = await setup((sys, user) => sys.includes('원가중심점(현장 이름)')
    ? (user.includes('공고 제목: [아마노') ? { costCenter: '아마노코리아(현장HR)', job: '상담', confidence: 0.9, reason: '제목의 고객사' } : { costCenter: '없는현장', job: 'x', confidence: 0.99, reason: '' })
    : undefined);
  for (const n of ['아마노코리아(현장HR)', '효성안양공장(도급)']) await db.prepare(`INSERT INTO cost_centers (name, created_at) VALUES (?, ?)`).bind(n, Date.now()).run();
  const ins = `INSERT INTO applicant_inbox (source, apply_no, recruit_no, company, job_title, name, received_at, status) VALUES ('albamon',?,?,?,?,?,?,'pending')`;
  await db.prepare(ins).bind('1', '111', '윌앤비전', '[아마노코리아(주)] 상담 직원 모집', '가', Date.now()).run();
  await db.prepare(ins).bind('2', '222', '윌앤비전', '이상한 공고', '나', Date.now()).run();
  assert.equal(await aiSuggestPostings(env), 2);
  const rows = (await db.prepare(`SELECT * FROM ai_postings ORDER BY recruit_no`).all()).results;
  assert.equal(rows[0].cost_center, '아마노코리아(현장HR)');
  assert.equal(rows[1].cost_center, '');                       // 목록에 없는 이름은 버림
  assert.equal(await aiSuggestPostings(env), 0);                // 한 번 본 공고는 다시 묻지 않음
  const page = await (await call('/applicants/postings')).text();
  assert.match(page, /AI 추천: <button[^>]*data-fill="아마노코리아\(현장HR\)" data-fill-job="상담"/);
  assert.equal((await db.prepare(`SELECT cost_center FROM applicant_inbox WHERE recruit_no='111'`).first()).cost_center, '');   // 자동 적용 안 함
});

test('명단 열 맞추기: 규칙이 못 찾으면 AI 가 모양만 보고 맞춤(값은 보내지 않음)', async () => {
  const { db, post, AI_FETCH } = await setup((sys) => sys.includes('엑셀 명단의 각 열') ? { hasHeader: true, site: 2, name: 0, phone: 1, interview_at: 3 } : undefined);
  const res = await post('/campaigns/new', {
    mode: 'many', csv: '성명,핸폰,근무지명,일정\n홍길동,010-8000-0001,강남점,10/20 14:00\n김영희,010-8000-0002,강남점,10/20 14:30\n',
    gateway_id: '1', template: '{이름}님', send_mode: 'manual', name: '열 시험'
  });
  assert.equal(res.status, 200);
  const page = await res.text();
  assert.match(page, /AI가 명단의 칸을 맞췄어요: 사업장=&quot;근무지명&quot;, 이름=&quot;성명&quot;, 전화번호=&quot;핸폰&quot;, 면접일시=&quot;일정&quot;/);
  const cs = (await db.prepare(`SELECT site, name, phone, interview_at FROM candidates ORDER BY id`).all()).results;
  assert.deepEqual(cs[0], { site: '강남점', name: '홍길동', phone: '01080000001', interview_at: '10/20 14:00' });
  const sent = AI_FETCH.sent[0].user;
  assert.ok(!sent.includes('홍길동') && !sent.includes('8000') && !sent.includes('강남점'), '값은 모양만');
  assert.equal(shapeOf('홍길동 010-8000-0001'), '가가가 000-0000-0000');
});

test('명단 열 맞추기: AI 가 고른 전화번호 칸이 번호가 아니면 쓰지 않고 규칙 결과 그대로', async () => {
  const { db, post } = await setup(() => ({ hasHeader: true, site: 2, name: 1, phone: 0, interview_at: -1 }));
  const res = await post('/campaigns/new', { mode: 'many', csv: '성명,핸폰,근무지명\n홍길동,010-8000-0001,강남점\n', gateway_id: '1', template: '{이름}님', send_mode: 'manual', name: 'x' });
  assert.equal(res.status, 200);
  assert.doesNotMatch(await res.text(), /AI가 명단의 칸/);
  assert.equal((await db.prepare(`SELECT phone FROM candidates`).first()).phone, '01080000001');
});

test('면접일시 형식 맞추기: 날짜 계산은 코드가, 모호한 것은 버림', async () => {
  const now = Date.UTC(2026, 9, 17, 3);   // 2026-10-17(토) 12:00 KST
  const answers = {
    '다음주 화 2시': { weekday: '화', weekOffset: 1, time: '14:00' },
    '모레 오전': { dayOffset: 2, time: null },
    '23일 10시반': { day: 23, time: '10:30' }
  };
  const { env } = await setup((sys, user) => sys.includes('면접 일시 표현') ? (answers[user.split('표현: ')[1]] ?? 'null') : undefined);
  const map = await aiNormalizeWhens(env, ['다음주 화 2시', '모레 오전', '23일 10시반', '다음주 화 2시'], now);
  assert.deepEqual([...map], [['다음주 화 2시', '10/20(화) 14:00'], ['23일 10시반', '10/23(금) 10:30']]);
});

test('날짜 계산(resolveWhen): 토요일 기준 다음주·요일·내일·지난 날', () => {
  const sat = Date.UTC(2026, 9, 17, 3);   // 2026-10-17(토)
  assert.equal(resolveWhen({ weekday: '월', weekOffset: 1, time: '15:00' }, sat), '10/19(월) 15:00');
  assert.equal(resolveWhen({ weekday: '화', weekOffset: 1, time: '14:00' }, sat), '10/20(화) 14:00');
  assert.equal(resolveWhen({ weekday: '월', weekOffset: 2, time: '09:00' }, sat), '10/26(월) 09:00');
  assert.equal(resolveWhen({ weekday: '수', weekOffset: null, time: '10:00' }, sat), '10/21(수) 10:00');
  assert.equal(resolveWhen({ weekday: '토', weekOffset: 0, time: '18:00' }, sat), '10/17(토) 18:00');
  assert.equal(resolveWhen({ weekday: '금', weekOffset: 0, time: '18:00' }, sat), '');            // 이번주 금요일은 지남
  assert.equal(resolveWhen({ dayOffset: 1, time: '09:30' }, sat), '10/18(일) 09:30');
  assert.equal(resolveWhen({ day: 5, time: '10:00' }, sat), '11/05(목) 10:00');                  // 월 없이 지난 날 → 다음 달
  assert.equal(resolveWhen({ month: 1, day: 5, time: '10:00' }, sat), '01/05(화) 10:00');        // 한참 전 → 내년(2027-01-05 화)
  assert.equal(resolveWhen({ month: 2, day: 30, time: '10:00' }, sat), '');                      // 없는 날짜
  assert.equal(resolveWhen({ weekday: '화', weekOffset: 1, time: null }, sat), '');              // 시각 없음
  assert.equal(resolveWhen({ weekday: '화', weekOffset: 1, time: '25:00' }, sat), '');
  // 원문으로 다시 확인: AI 가 요일을 날짜로 잘못 계산해도 원문의 "다음주 화요일"로 계산
  assert.equal(resolveWhen({ month: 10, day: 24, time: '14:00' }, sat, '다음주 화요일 오후 2시 괜찮을까요'), '10/20(화) 14:00');
  assert.equal(resolveWhen({ weekday: '화', time: '14:00' }, sat, '내일 2시요'), '10/18(일) 14:00');
  assert.equal(resolveWhen({ month: 10, day: 27, time: '10:00' }, sat, '27일(화) 10시'), '10/27(화) 10:00');
  assert.equal(resolveWhen({ month: 10, day: 27, time: '10:00' }, sat, '27일(수) 10시'), '');          // 날짜·요일 안 맞음
  assert.equal(resolveWhen({ month: 10, day: 20, time: '14:00' }, sat, '좀 늦게 2시쯤'), '');           // 원문에 날짜 없음
  assert.equal(resolveWhen({ dayOffset: 1, time: '15:00' }, sat, '내일 2시'), '');                     // 시각이 원문과 다름
});

test('면접 안내 만들기: 면접일시를 AI 가 바꾸면 결과 화면에 알려 줌', async () => {
  const { db, post } = await setup((sys) => sys.includes('면접 일시 표현') ? { weekday: '수', weekOffset: 1, time: '15:00' } : undefined);
  const res = await post('/campaigns/new', { mode: 'many', csv: '사업장,이름,전화번호,면접일시\nA,홍길동,010-8000-0001,다음주 수 3시\nA,김,010-8000-0002,10/20 14:00\n',
    gateway_id: '1', template: '{이름}님 {면접일시}', send_mode: 'manual', name: 'x', remind_prev: '1' });
  const page = await res.text();
  assert.match(page, /AI가 면접일시 1개를 읽을 수 있는 형식으로 바꿨어요/);
  assert.match((await db.prepare(`SELECT interview_at FROM candidates WHERE id=1`).first()).interview_at, /^\d\d\/\d\d\(수\) 15:00$/);
  assert.equal((await db.prepare(`SELECT interview_at FROM candidates WHERE id=2`).first()).interview_at, '10/20 14:00');
});

test('문구 점검: 자리 표시가 바뀌면 버리고, 맞으면 다듬은 문구·빠진 정보를 돌려줌', async () => {
  let answer;
  const { env, call, post } = await setup(() => answer);
  answer = { text: '{이름}님, 면접 안내드려요. {면접일시}에 와 주세요. 참석/불참으로 답장 부탁드려요.', issues: ['면접 장소가 없어요'] };
  const ok = await aiCheckTemplate(env, { template: '{이름}님 {면접일시} 면접. 참석/불참 답장', kind: 'fixed' });
  assert.deepEqual(ok.issues, ['면접 장소가 없어요']);
  answer = { text: '홍길동님, {면접일시}에 오세요', issues: [] };
  assert.equal((await aiCheckTemplate(env, { template: '{이름}님 {면접일시}', kind: 'fixed' })).error, 'placeholder');
  answer = { text: '{이름}님 {면접일시} {주소}', issues: [] };
  assert.equal((await aiCheckTemplate(env, { template: '{이름}님 {면접일시}', kind: 'fixed' })).error, 'placeholder');
  // 화면 버튼과 연결 주소
  assert.match(await (await call('/campaigns/new')).text(), /id="aitpl"/);
  answer = { text: '{이름}님 안녕하세요', issues: [] };
  const j = await (await post('/campaigns/ai-template', { template: '{이름}님', kind: 'fixed' })).json();
  assert.equal(j.text, '{이름}님 안녕하세요');
});

test('키가 없으면 AI 기능이 화면에 나오지 않고 아무것도 묻지 않음', async () => {
  const { db, env, call } = await setup(() => { throw new Error('부르면 안 됨'); }, { ai: false });
  assert.doesNotMatch(await (await call('/campaigns/new')).text(), /id="aitpl"/);
  assert.equal(await aiSuggestPostings(env), 0);
  await campaign(db);
  const a = await reply(env, '22일이요');
  assert.equal(a.applied, false);
});
