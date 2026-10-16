import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openSqliteD1 } from '../src/node/d1-sqlite.js';
import { handleRequest } from '../src/worker.js';
import { createSession } from '../src/auth.js';
import { hashPassword } from '../src/crypto.js';

const visible = (html) => html.replace(/<(style|script)[\s\S]*?<\/\1>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

async function setup() {
  const db = openSqliteD1(':memory:', fileURLToPath(new URL('../migrations', import.meta.url)));
  const env = { DB: db, ENCRYPTION_KEY: 'k', PUBLIC_BASE_URL: 'https://example.test', GATEWAY_URL: 'https://sms.example.test/api/3rdparty/v1', GATEWAY_PRIVATE_TOKEN: 't' };
  const u = await db.prepare(`INSERT INTO users (username,pass_hash,role,email_verified_at,name,email) VALUES ('boss',?,'super',1,'김관리','boss@willvi.co.kr')`).bind(await hashPassword('x')).run();
  const sid = await createSession(db, Number(u.meta.last_row_id));
  const call = (p, init = {}) => handleRequest(new Request('https://example.test' + p, { ...init, headers: { cookie: `sid=${sid}`, origin: 'https://example.test', ...(init.headers || {}) } }), env, { waitUntil() {} });
  const post = (p, f) => call(p, { method: 'POST', body: new URLSearchParams(f).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  return { db, call, post };
}
const addGw = (db, dept, name, active = 1) => db.prepare(
  `INSERT INTO gateways (department_id,name,username,password,hook_token,active,own_number,passphrase,signing_key) VALUES (?,?,?,?,?,?,?,?,?)`)
  .bind(dept, name, 'u', 'secret-pw', 'tok' + name, active, '01011112222', 'pp', 'sk').run();

test('쓰지 않는 폰 삭제: 쓰는 폰은 거절, 기록 없는 폰은 완전 삭제', async () => {
  const { db, post, call } = await setup();
  await addGw(db, 1, 'HR본부 폰', 0);
  await addGw(db, 2, 'HR 폰', 1);
  // 쓰고 있는 폰은 지울 수 없다
  let html = visible(await (await post('/admin', { do: 'gw_delete', gateway_id: '2' })).text());
  assert.ok(html.includes('쓰고 있는 폰은 지울 수 없어요'));
  assert.equal((await db.prepare(`SELECT COUNT(*) n FROM gateways`).first()).n, 2);
  // 화면: 쓰지 않는 폰에만 "이 폰 지우기"
  const admin = await (await call('/admin')).text();
  assert.equal((admin.match(/value="gw_delete"/g) || []).length, 1);
  // 기록이 없는 폰은 행까지 삭제
  html = visible(await (await post('/admin', { do: 'gw_delete', gateway_id: '1' })).text());
  assert.ok(html.includes('폰을 지웠어요'));
  assert.equal((await db.prepare(`SELECT COUNT(*) n FROM gateways WHERE id=1`).first()).n, 0);
});

test('기록이 있는 폰은 목록에서 숨기고 접속 정보를 지우되 기록은 보존', async () => {
  const { db, post, call } = await setup();
  await addGw(db, 1, 'HR본부 폰', 0);
  await db.prepare(`INSERT INTO campaigns (department_id,gateway_id,name,template,created_at,status) VALUES (1,1,'옛 면접 안내','x',?, 'done')`).bind(Date.now()).run();
  await db.prepare(`INSERT INTO messages (gateway_id,phone,text,status,at) VALUES (1,'01011110000','옛 문자','sent',?)`).bind(Date.now()).run();
  const html = visible(await (await post('/admin', { do: 'gw_delete', gateway_id: '1' })).text());
  assert.ok(html.includes('기록은 그대로 남아 있어요'));
  const row = await db.prepare(`SELECT * FROM gateways WHERE id=1`).first();
  assert.ok(row.deleted_at);
  assert.equal(row.active, 0);
  assert.equal(row.password, '');
  assert.equal(row.passphrase, '');
  assert.equal(row.signing_key, '');
  assert.equal(row.username, '');
  assert.match(row.hook_token, /^deleted-/);
  // 설정 목록에서는 보이지 않고, 기록(면접 안내/문자)은 그대로 있다
  const admin = visible(await (await call('/admin')).text());
  assert.ok(!admin.includes('HR본부 폰'));
  assert.equal((await db.prepare(`SELECT COUNT(*) n FROM campaigns`).first()).n, 1);
  assert.equal((await db.prepare(`SELECT COUNT(*) n FROM messages`).first()).n, 1);
  // 같은 폰을 다시 지우려 하면 찾지 못한다
  const again = visible(await (await post('/admin', { do: 'gw_delete', gateway_id: '1' })).text());
  assert.ok(again.includes('지울 폰을 찾지 못했어요'));
});

test('보낼 예정인 문자·면접 안내가 남은 폰은 지우지 않는다', async () => {
  const { db, post } = await setup();
  await addGw(db, 1, '예약 있는 폰', 0);
  await db.prepare(`INSERT INTO messages (gateway_id,phone,text,status,at,scheduled_at) VALUES (1,'01011110000','예약','scheduled',?,?)`).bind(Date.now(), Date.now() + 3600000).run();
  const html = visible(await (await post('/admin', { do: 'gw_delete', gateway_id: '1' })).text());
  assert.ok(html.includes('보낼 예정인 문자나 면접 안내가 남아 있어요'));
  assert.equal((await db.prepare(`SELECT deleted_at FROM gateways WHERE id=1`).first()).deleted_at, null);
});
