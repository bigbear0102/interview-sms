// 진행 기록: 작업 번호(_op)를 붙인 요청은 서버 단계를 남기고, 본인만 /ops/<번호> 로 읽는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openSqliteD1 } from '../src/node/d1-sqlite.js';
import { handleRequest } from '../src/worker.js';
import { createSession } from '../src/auth.js';
import { hashPassword, encryptText } from '../src/crypto.js';
import { purgeOpLogs } from '../src/oplog.js';
import { APP_JS } from '../src/appjs.js';

async function setup() {
  const db = openSqliteD1(':memory:', fileURLToPath(new URL('../migrations', import.meta.url)));
  const env = { DB: db, ENCRYPTION_KEY: 'k', PUBLIC_BASE_URL: 'https://example.test', GATEWAY_URL: 'https://sms.example.test/api/3rdparty/v1', NO_REAL_NETWORK: true };
  await db.prepare(`INSERT INTO departments (name) VALUES ('인사팀')`).run();
  await db.prepare(`INSERT INTO gateways (department_id,name,username,password,hook_token) VALUES (1,'폰','u',?,'t')`).bind(await encryptText('k', 'pw')).run();
  const users = {};
  for (const name of ['boss', 'lee']) {
    const r = await db.prepare(`INSERT INTO users (username,pass_hash,role,email_verified_at,name,email) VALUES (?,?,'super',1,?,?)`).bind(name, await hashPassword('password123'), name, `${name}@willvi.co.kr`).run();
    const sid = await createSession(db, Number(r.meta.last_row_id));
    const call = (path, init = {}) => handleRequest(new Request('https://example.test' + path, { ...init, headers: { cookie: `sid=${sid}`, origin: 'https://example.test', ...(init.headers || {}) } }), env, { waitUntil() {} });
    users[name] = { call, post: (path, fields) => call(path, { method: 'POST', body: new URLSearchParams(fields).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'manual' }) };
  }
  return { db, env, users };
}
const ops = async (u, id) => (await (await u.call('/ops/' + id)).json()).lines.map((l) => l.msg);

test('명단 올리기: 요청 받음 → 명단 읽음 → 저장 → 마침, 본인만 읽음', async () => {
  const { users } = await setup();
  const id = 'abc123def456ghi7';
  const r = await users.boss.post('/campaigns/new?_op=' + id, {
    mode: 'many', csv: '사업장,이름,전화번호,면접일시\nA,홍길동,010-8000-0001,10/20 14:00\nA,김영희,010-8000-0002,10/20 14:30\n',
    gateway_id: '1', template: '{이름}님', send_mode: 'manual', name: '시험'
  });
  assert.equal(r.status, 200);
  assert.deepEqual(await ops(users.boss, id), ['서버가 요청을 받았어요', '명단 2줄을 읽었어요', '2명을 저장했어요', '처리를 마쳤어요 · 화면을 여는 중']);
  assert.deepEqual(await ops(users.lee, id), []);                 // 다른 사람 기록은 안 보임
  const lines = (await (await users.boss.call('/ops/' + id)).json()).lines;
  assert.ok(lines.every((l) => !/홍길동|8000/.test(l.msg)), '개인정보 없음');
});

test('작업 번호가 없거나 이상하면 기록하지 않음, 실패는 "문제가 생겨"로 끝남', async () => {
  const { db, users } = await setup();
  await users.boss.post('/campaigns/new', { mode: 'one', one_site: '', gateway_id: '1', template: 'x' });
  await users.boss.post('/campaigns/new?_op=../../x', { mode: 'one', one_site: '', gateway_id: '1', template: 'x' });
  assert.equal((await db.prepare(`SELECT COUNT(*) n FROM op_logs`).first()).n, 0);
  const id = 'zzzz0000yyyy1111';
  const r = await users.boss.post('/campaigns/new?_op=' + id, { mode: 'one', one_site: '', gateway_id: '1', template: 'x' });
  assert.equal(r.status, 400);
  assert.deepEqual(await ops(users.boss, id), ['서버가 요청을 받았어요', '문제가 생겨 처리하지 못했어요']);
});

test('AI 찾기(GET)도 단계 기록, 하루 지난 기록은 지움', async () => {
  const { db, users } = await setup();
  const id = 'ask0000000000001';
  await users.boss.call('/applicants/ask?q=' + encodeURIComponent('안양 사무') + '&_op=' + id);
  const m = await ops(users.boss, id);
  assert.deepEqual(m.slice(0, 3), ['서버가 요청을 받았어요', 'AI가 찾는 조건을 읽는 중…', 'AI 대신 낱말로 찾는 중…']);
  assert.match(m[3], /^\d+명을 찾았어요$/);
  await purgeOpLogs(db, Date.now() + 2 * 86400000);
  assert.equal((await db.prepare(`SELECT COUNT(*) n FROM op_logs`).first()).n, 0);
});

test('화면 스크립트: 진행 카드가 들어 있고 문법 오류 없음', () => {
  new Function(APP_JS);   // 문법 검사
  assert.match(APP_JS, /window\.opBusy/);
  assert.match(APP_JS, /'\/ops\/' \+ opId/);
});
