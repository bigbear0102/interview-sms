import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openSqliteD1 } from '../src/node/d1-sqlite.js';
import { handleRequest } from '../src/worker.js';
import { createSession } from '../src/auth.js';
import { encryptText, hashPassword } from '../src/crypto.js';
import { createCampaign, scheduleCampaign, processQueue } from '../src/core.js';
import { candidatesFromCsv } from '../src/csv.js';
import { applyDeliveryEvent, pollDelivery, notifyNewReply, planRetry, isRetryable } from '../src/delivery.js';
import { registerWebhook } from '../src/gateway.js';

const CSV = '사업장,이름,전화번호\nA점,홍길동,010-1111-2222\nB점,김철수,010-3333-4444\n';

async function setup() {
  const db = openSqliteD1(':memory:', fileURLToPath(new URL('../migrations', import.meta.url)));
  const mails = [];
  const env = { DB: db, ENCRYPTION_KEY: 'k', PUBLIC_BASE_URL: 'https://example.test', MAIL_SEND: async (m) => { mails.push(m); } };
  await db.prepare(`INSERT INTO gateways (department_id,name,username,password,hook_token) VALUES (7,'HR 폰','u',?, 't')`)
    .bind(await encryptText('k', 'pw')).run();
  const call = (path, init = {}) => handleRequest(new Request('https://example.test' + path, init), env, { waitUntil() {} });
  return { db, env, mails, call };
}
async function sentCampaign(db, env, sendId = (n) => ({ id: `gw-${n}` })) {
  const r = await createCampaign(db, { departmentId: 7, gatewayId: 1, name: 't', candidates: candidatesFromCsv(CSV).candidates, userId: null });
  await scheduleCampaign(db, r.campaignId, Date.now() - 1);
  let n = 0;
  await processQueue(env, { send: async () => sendId(++n), log: {} });
  return r.campaignId;
}
const hook = (call, event, payload) => call('/hook/1/t', { method: 'POST', body: JSON.stringify({ event, payload }) });

test('재시도 정책: 영구 오류는 바로 실패, 일시 오류는 3번까지', () => {
  assert.equal(isRetryable('게이트웨이 응답 400: {"message":"invalid phone number"}'), false);
  assert.equal(isRetryable('게이트웨이 응답 401'), false);
  assert.equal(isRetryable('게이트웨이 응답 503: busy'), true);
  assert.equal(isRetryable('fetch failed'), true);
  const t = 1000000;
  assert.equal(planRetry(1, 'boom', t).at, t + 2 * 60000);
  assert.equal(planRetry(2, 'boom', t).at, t + 10 * 60000);
  assert.equal(planRetry(3, 'boom', t).retry, false);
  assert.equal(planRetry(1, '400 invalid phone number', t).retry, false);
});

test('발송 응답의 메시지 id 를 저장하고 전달 이벤트로 "전달됨"이 된다', async () => {
  const { db, env, call } = await setup();
  const cid = await sentCampaign(db, env);
  const rows = (await db.prepare(`SELECT gw_msg_id, delivery, status FROM candidates ORDER BY id`).all()).results;
  assert.deepEqual(rows.map((r) => r.gw_msg_id), ['gw-1', 'gw-2']);
  assert.ok(rows.every((r) => r.delivery === 'queued' && r.status === 'sent'));

  assert.equal((await hook(call, 'sms:sent', { messageId: 'gw-1' })).status, 200);
  assert.equal((await db.prepare(`SELECT delivery FROM candidates WHERE gw_msg_id='gw-1'`).first()).delivery, 'sent');
  await hook(call, 'sms:delivered', { messageId: 'gw-1' });
  const c = await db.prepare(`SELECT delivery, delivered_at FROM candidates WHERE gw_msg_id='gw-1'`).first();
  assert.equal(c.delivery, 'delivered');
  assert.ok(c.delivered_at > 0);
  // 늦게 온 sent 이벤트가 delivered 를 되돌리지 않는다
  await hook(call, 'sms:sent', { messageId: 'gw-1' });
  assert.equal((await db.prepare(`SELECT delivery FROM candidates WHERE gw_msg_id='gw-1'`).first()).delivery, 'delivered');
  assert.ok(cid);
});

test('전달 실패 이벤트 → 자동 재시도 대기 → 캠페인이 다시 발송 중으로 → 재발송', async () => {
  const { db, env, call } = await setup();
  const cid = await sentCampaign(db, env);
  assert.equal((await db.prepare(`SELECT status FROM campaigns WHERE id=?`).bind(cid).first()).status, 'done');

  await hook(call, 'sms:failed', { messageId: 'gw-2', reason: 'Radio off' });
  const c = await db.prepare(`SELECT status, attempts, next_retry_at, delivery, error FROM candidates WHERE gw_msg_id='gw-2'`).first();
  assert.equal(c.status, 'pending');
  assert.equal(c.attempts, 1);
  assert.equal(c.delivery, 'failed');
  assert.ok(c.next_retry_at > Date.now());
  assert.match(c.error, /다시 시도해요 \(1\/3\).*Radio off/);
  assert.equal((await db.prepare(`SELECT status FROM campaigns WHERE id=?`).bind(cid).first()).status, 'sending');

  // 시각이 되면 그 한 명만 다시 보낸다
  await db.prepare(`UPDATE candidates SET next_retry_at=1`).run();
  const phones = [];
  await processQueue(env, { send: async (gw, p) => { phones.push(p); return { id: 'gw-retry' }; }, log: {} });
  assert.deepEqual(phones, ['01033334444']);
  const after = await db.prepare(`SELECT status, gw_msg_id, delivery FROM candidates WHERE phone='01033334444'`).first();
  assert.deepEqual({ ...after }, { status: 'sent', gw_msg_id: 'gw-retry', delivery: 'queued' });
  assert.equal((await db.prepare(`SELECT status FROM campaigns WHERE id=?`).bind(cid).first()).status, 'done');
});

test('답장을 이미 한 사람의 전달 실패 이벤트는 상태를 바꾸지 않는다, 3번째 실패는 failed', async () => {
  const { db, env } = await setup();
  await sentCampaign(db, env);
  await db.prepare(`UPDATE candidates SET status='attending' WHERE gw_msg_id='gw-1'`).run();
  await applyDeliveryEvent(db, { gwMsgId: 'gw-1', event: 'failed', reason: 'x' });
  assert.equal((await db.prepare(`SELECT status FROM candidates WHERE gw_msg_id='gw-1'`).first()).status, 'attending');

  await db.prepare(`UPDATE candidates SET attempts=2 WHERE gw_msg_id='gw-2'`).run();
  await applyDeliveryEvent(db, { gwMsgId: 'gw-2', event: 'failed', reason: '통신사 오류' });
  const c = await db.prepare(`SELECT status, attempts, error FROM candidates WHERE gw_msg_id='gw-2'`).first();
  assert.equal(c.status, 'failed');
  assert.equal(c.attempts, 3);
  assert.match(c.error, /통신사 오류/);
});

test('직접 보낸 문자도 전달 결과가 반영되고 문자함에 "전달됨"으로 보인다', async () => {
  const { db, env, call } = await setup();
  await db.prepare(`INSERT INTO users (username,pass_hash,role,email_verified_at,name,email) VALUES ('boss',?,'super',1,'관리자','boss@willvi.co.kr')`)
    .bind(await hashPassword('x')).run();
  const sid = await createSession(db, 1);
  await db.prepare(`INSERT INTO messages (gateway_id,phone,text,status,at,gw_msg_id,delivery) VALUES (1,'01011112222','안녕','sent',?,'m-1','queued')`).bind(Date.now()).run();
  await hook(call, 'sms:delivered', { messageId: 'm-1' });
  const html = await (await call('/messages?dir=out', { headers: { cookie: `sid=${sid}` } })).text();
  assert.match(html, /<span class="badge ok">전달됨<\/span>/);
});

test('웹훅을 놓친 건은 서버 조회로 보완한다', async () => {
  const { db, env } = await setup();
  await sentCampaign(db, env);
  await db.prepare(`UPDATE candidates SET sent_at=?`).bind(Date.now() - 10 * 60000).run();
  const asked = [];
  const n = await pollDelivery(env, {
    fetchMessage: async (gw, id) => { asked.push(id); return id === 'gw-1' ? { state: 'Delivered' } : { state: 'Failed', recipients: [{ error: 'no service' }] }; }
  });
  assert.equal(n, 2);
  assert.deepEqual(asked.sort(), ['gw-1', 'gw-2']);
  assert.equal((await db.prepare(`SELECT delivery FROM candidates WHERE gw_msg_id='gw-1'`).first()).delivery, 'delivered');
  const c2 = await db.prepare(`SELECT status, delivery FROM candidates WHERE gw_msg_id='gw-2'`).first();
  assert.deepEqual({ ...c2 }, { status: 'pending', delivery: 'failed' }); // 재시도 대기
});

test('웹훅 등록: 수신 + 발송/전달/실패 4종', async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push([init?.method, String(url), init?.body ? JSON.parse(init.body) : null]); return new Response('{}', { status: 201 }); };
  try {
    await registerWebhook({ id: 3, base_url: 'https://api.sms-gate.app/3rdparty/v1', username: 'u', password: 'p', hook_token: 'tok' }, 'https://example.test');
  } finally { globalThis.fetch = original; }
  const posted = calls.filter(([m]) => m === 'POST').map(([, , b]) => b);
  assert.deepEqual(posted.map((b) => b.event), ['sms:received', 'sms:sent', 'sms:delivered', 'sms:failed']);
  assert.ok(posted.every((b) => b.url === 'https://example.test/hook/3/tok'));
  assert.deepEqual(posted.map((b) => b.id), ['interview-sms-3', 'interview-sms-3-sent', 'interview-sms-3-delivered', 'interview-sms-3-failed']);
});

test('새 답장 알림: 선택한 사람만, 5분에 한 번, 내용/번호는 메일에 없다', async () => {
  const { db, env, mails } = await setup();
  const dep7 = (await db.prepare(`SELECT id FROM departments WHERE id=7`).first()).id;
  const mk = async (name, email, notify, deptId) => {
    const r = await db.prepare(`INSERT INTO users (username,pass_hash,role,email_verified_at,name,email,notify_replies) VALUES (?,?,'admin',1,?,?,?)`)
      .bind(email, 'x', name, email, notify).run();
    await db.prepare(`INSERT INTO user_departments VALUES (?,?)`).bind(Number(r.meta.last_row_id), deptId).run();
  };
  await mk('알림켬', 'on@willvi.co.kr', 1, dep7);
  await mk('알림끔', 'off@willvi.co.kr', 0, dep7);
  await mk('다른부서', 'other@willvi.co.kr', 1, 1);

  assert.equal(await notifyNewReply(env, 1), 1);
  assert.deepEqual(mails.map((m) => m.to), ['on@willvi.co.kr']);
  assert.ok(!mails[0].text.includes('010') && !mails[0].html.includes('010'));
  assert.match(mails[0].text, /\/messages\?dir=in/);
  // 5분 안에 또 와도 보내지 않는다
  assert.equal(await notifyNewReply(env, 1), 0);
  assert.equal(mails.length, 1);
});

test('안 읽은 문자: 메뉴에 개수가 보이고 문자함을 열면 읽음 처리', async () => {
  const { db, call } = await setup();
  await db.prepare(`INSERT INTO users (username,pass_hash,role,email_verified_at,name,email) VALUES ('boss','x','super',1,'관리자','boss@willvi.co.kr')`).run();
  const sid = await createSession(db, 1);
  const hdr = { headers: { cookie: `sid=${sid}` } };
  await db.prepare(`INSERT INTO inbound (gateway_id,sender,message,received_at,result) VALUES (1,'01011112222','참석',?, 'unmatched'),(1,'01033334444','불참',?, 'unmatched')`)
    .bind(Date.now(), Date.now()).run();

  const home = await (await call('/', hdr)).text();
  assert.match(home, /<i class="dot"[^>]*>2<\/i>/);
  const inbox = await call('/messages?dir=in', hdr);
  assert.equal(inbox.status, 200);
  assert.equal((await db.prepare(`SELECT COUNT(*) n FROM inbound WHERE read_at IS NULL`).first()).n, 0);
  const home2 = await (await call('/', hdr)).text();
  assert.doesNotMatch(home2, /class="dot"/);
});
