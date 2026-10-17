// 답장 AI 해석(NVIDIA): 가짜 AI 응답만 쓴다. 실제 API 에는 접속하지 않는다(AGENTS 규칙 14).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openSqliteD1 } from '../src/node/d1-sqlite.js';
import { handleRequest } from '../src/worker.js';
import { encryptText } from '../src/crypto.js';
import { createCampaign, handleInbound, purgeExpired } from '../src/core.js';
import { normalizeAi, classifyReply, needsAi, aiReviewReply, AI_URL } from '../src/reply-ai.js';

// 가짜 AI: 답장 원문 → 돌려줄 판단. 보낸 요청을 기록한다.
function fakeAi(answers) {
  const sent = [];
  const fn = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push({ url, body, auth: init.headers.authorization });
    const user = body.messages[1].content;
    const msg = user.split('답장: ')[1];
    const a = answers[msg];
    if (a === 'fail') return new Response('busy', { status: 503 });
    return Response.json({ choices: [{ message: { content: a ? JSON.stringify(a) : '{"intent":"unclear","slot":null,"confidence":0.3,"note":"모름"}' } }] });
  };
  fn.sent = sent;
  return fn;
}

async function setup(answers = {}) {
  const db = openSqliteD1(':memory:', fileURLToPath(new URL('../migrations', import.meta.url)));
  await db.prepare(`INSERT INTO departments (name) VALUES ('인사팀')`).run();
  await db.prepare(`INSERT INTO gateways (department_id,name,username,password,hook_token) VALUES (1,'폰','u',?,'t')`).bind(await encryptText('k', 'pw')).run();
  const AI_FETCH = fakeAi(answers);
  const env = { DB: db, ENCRYPTION_KEY: 'k', NO_REAL_NETWORK: true, NVIDIA_API_KEY: 'nvapi-test', AI_FETCH };
  return { db, env, AI_FETCH };
}
async function campaign(db, { slots = [], at = '10/22(수) 10:00' } = {}) {
  await createCampaign(db, { departmentId: 1, gatewayId: 1, name: '안내', template: '', userId: null, slots,
    candidates: [{ site: '강남', name: '가나', phone: '01011110001', interview_at: at }, { site: '강남', name: '다라', phone: '01011110002', interview_at: at }] });
  await db.prepare(`UPDATE candidates SET status='sent', sent_at=?`).bind(Date.now()).run();
}
const cand = (db, phone = '01011110001') => db.prepare(`SELECT * FROM candidates WHERE phone=?`).bind(phone).first();
const queued = (db) => db.prepare(`SELECT * FROM messages ORDER BY id`).all().then((r) => r.results);
// 웹훅처럼: 규칙으로 저장 → AI 검토
async function reply(env, phone, message) {
  const r = await handleInbound(env.DB, 1, { sender: phone, message });
  return needsAi(r.result, message) ? aiReviewReply(env, { candidateId: r.candidateId, message, at: r.at }) : { applied: false, rule: r.result };
}
const SLOTS = ['10/22(수) 10:00', '10/23(목) 14:00'];

test('AI 응답 검사: JSON 만 받고 번호·확신도 범위를 지킴', () => {
  assert.deepEqual(normalizeAi('생각… {"intent":"attending","slot":2,"confidence":0.95,"note":"목요일 선택"}', 2),
    { intent: 'attending', slot: 2, confidence: 0.95, note: '목요일 선택' });
  assert.equal(normalizeAi('{"intent":"attending","slot":3,"confidence":1}', 2).slot, null);   // 없는 번호
  assert.equal(normalizeAi('{"intent":"party","confidence":1}', 2), null);
  assert.equal(normalizeAi('그냥 글', 2), null);
  assert.equal(normalizeAi('{"intent":"absent","confidence":7}', 0).confidence, 1);
});

test('AI 를 부를지: 확인 필요는 항상, 불참은 긴 문장만', () => {
  assert.ok(needsAi('unclear', '22일 10시요'));
  assert.ok(!needsAi('absent', '불참할께요'));
  assert.ok(needsAi('absent', '늦어서 죄송해요 참석할게요'));
  assert.ok(!needsAi('attending', '참석'));
});

test('키가 없거나 시험 중 실제 접속이면 AI 를 부르지 않음', async () => {
  assert.equal(await classifyReply({}, { message: 'x' }), null);
  assert.equal(await classifyReply({ NVIDIA_API_KEY: 'k', NO_REAL_NETWORK: true }, { message: 'x' }), null);  // 가짜 없으면 안 감
  assert.equal(await classifyReply({ NVIDIA_API_KEY: 'k', AI_REPLY: 'off', AI_FETCH: fakeAi({}) }, { message: 'x' }), null);
});

test('일정 고르기: "22일 10시요" → AI 가 1번 일정으로 확정 + 확정 문자, 이름·전화번호는 보내지 않음', async () => {
  const { db, env, AI_FETCH } = await setup({ '22일 10시요': { intent: 'attending', slot: 1, confidence: 0.95, note: '22일 10시 선택' } });
  await campaign(db, { slots: SLOTS });
  const a = await reply(env, '01011110001', '22일 10시요');
  assert.equal(a.applied, true);
  const c = await cand(db);
  assert.equal(c.status, 'attending');
  assert.equal(c.interview_at, '10/22(수) 10:00');
  assert.match(c.ai_note, /^AI: 참석\(1번 일정\)/);
  const ms = await queued(db);
  assert.equal(ms.length, 1);
  assert.match(ms[0].text, /가나님, 면접 일정이 10\/22\(수\) 10:00/);
  // 보낸 내용 확인
  const s = AI_FETCH.sent[0];
  assert.equal(s.url, AI_URL);
  assert.equal(s.auth, 'Bearer nvapi-test');
  const all = JSON.stringify(s.body);
  assert.ok(!all.includes('가나') && !all.includes('01011110001') && !all.includes('1111'), '개인정보를 보내면 안 됨');
  assert.match(all, /1\) 10\/22\(수\) 10:00 \/ 2\) 10\/23\(목\) 14:00/);
  const inb = await db.prepare(`SELECT result FROM inbound`).first();
  assert.equal(inb.result, 'attending');
});

test('정해진 일정: 다른 곳 합격 → 불참, 후보에 없는 날짜 → 일정 변경 요청, 질문 → 확인 필요 유지', async () => {
  const { db, env } = await setup({
    '다른데 붙어서요 ㅠ': { intent: 'absent', confidence: 0.9, note: '다른 곳 합격' },
    '24일은 안되나요?': { intent: 'reschedule', confidence: 0.95, note: '24일 희망' },
    '주차 되나요': { intent: 'question', confidence: 0.95, note: '주차 문의' }
  });
  await campaign(db);
  await reply(env, '01011110001', '다른데 붙어서요 ㅠ');
  let c = await cand(db);
  assert.equal(c.status, 'absent');
  assert.match(c.ai_note, /AI: 불참 · 다른 곳 합격/);

  await reply(env, '01011110002', '24일은 안되나요?');
  c = await cand(db, '01011110002');
  assert.equal(c.status, 'unclear');
  assert.equal(c.reply_kind, 'reschedule');

  await reply(env, '01011110002', '주차 되나요');
  c = await cand(db, '01011110002');
  assert.equal(c.status, 'unclear');
  assert.match(c.ai_note, /AI: 질문 · 주차 문의/);
  assert.equal((await queued(db)).length, 0);   // 정해진 일정에는 문자를 보내지 않음
});

test('"죄송"이 들어간 참석 답장: 규칙은 불참 → AI 가 확실하면 참석으로 고침', async () => {
  const { db, env } = await setup({ '늦게 답해서 죄송해요 참석할게요': { intent: 'attending', confidence: 0.95, note: '참석' } });
  await campaign(db);
  await reply(env, '01011110001', '늦게 답해서 죄송해요 참석할게요');
  assert.equal((await cand(db)).status, 'attending');
});

test('확신이 낮거나 AI 가 실패하면 바꾸지 않음(담당자 확인)', async () => {
  const { db, env } = await setup({
    '음 아마요': { intent: 'attending', confidence: 0.6, note: '애매' },
    '22일이요': 'fail'
  });
  await campaign(db, { slots: SLOTS });
  const a = await reply(env, '01011110001', '음 아마요');
  assert.equal(a.applied, false);
  let c = await cand(db);
  assert.equal(c.status, 'unclear');
  assert.match(c.ai_note, /추정/);
  const b = await reply(env, '01011110002', '22일이요');
  assert.equal(b.error, 'http 503');
  c = await cand(db, '01011110002');
  assert.equal(c.status, 'unclear');
  assert.equal(c.ai_note, '');
  assert.equal((await queued(db)).length, 0);
});

test('AI 가 보는 사이 새 답장이 오거나 담당자가 직접 정했으면 덮어쓰지 않음', async () => {
  const { db, env } = await setup({ '22일 10시요': { intent: 'attending', slot: 1, confidence: 0.95, note: '' } });
  await campaign(db, { slots: SLOTS });
  const r = await handleInbound(db, 1, { sender: '01011110001', message: '22일 10시요' });
  await db.prepare(`UPDATE candidates SET replied_at=replied_at+1`).run();   // 새 답장이 온 것처럼
  assert.equal((await aiReviewReply(env, { candidateId: r.candidateId, message: '22일 10시요', at: r.at })).applied, false);
  const r2 = await handleInbound(db, 1, { sender: '01011110002', message: '22일 10시요' });
  await db.prepare(`UPDATE candidates SET manual=1 WHERE phone='01011110002'`).run();
  assert.equal((await aiReviewReply(env, { candidateId: r2.candidateId, message: '22일 10시요', at: r2.at })).applied, false);
  assert.equal((await queued(db)).length, 0);
});

test('웹훅: 답장 저장 후 뒤에서 AI 적용, 감사 기록에는 개인정보 없음', async () => {
  const { db, env } = await setup({ '목요일 오후 두시 괜찮아요': { intent: 'attending', slot: 2, confidence: 0.95, note: '목요일 선택' } });
  await campaign(db, { slots: SLOTS });
  const pending = [];
  const res = await handleRequest(new Request('https://example.test/hook/1/t', { method: 'POST',
    body: JSON.stringify({ event: 'sms:received', payload: { sender: '+821011110001', message: '목요일 오후 두시 괜찮아요' } }) }), env, { waitUntil: (p) => pending.push(p) });
  assert.equal(res.status, 200);
  await Promise.all(pending);
  const c = await cand(db);
  assert.equal(c.status, 'attending');
  assert.equal(c.interview_at, '10/23(목) 14:00');
  const log = await db.prepare(`SELECT detail FROM audit WHERE action='reply.ai'`).first();
  assert.match(log.detail, /applied result=attending/);
  assert.ok(!log.detail.includes('목요일') && !log.detail.includes('1111'));
});

test('새 답장이 오면 이전 AI 설명은 지우고, 보관 기간이 지나면 파기', async () => {
  const { db, env } = await setup({ '주차 되나요': { intent: 'question', confidence: 0.9, note: '주차 문의' } });
  await campaign(db);
  await reply(env, '01011110001', '주차 되나요');
  assert.notEqual((await cand(db)).ai_note, '');
  await handleInbound(db, 1, { sender: '01011110001', message: '참석합니다' });
  assert.equal((await cand(db)).ai_note, '');
  await reply(env, '01011110001', '주차 되나요');
  await db.prepare(`UPDATE campaigns SET status='done', retention_days=0`).run();
  await purgeExpired(db, Date.now() + 1000);
  assert.equal((await db.prepare(`SELECT ai_note FROM candidates WHERE id=1`).first()).ai_note, '');
});
