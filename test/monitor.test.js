import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openSqliteD1 } from '../src/node/d1-sqlite.js';
import { classify, monitorPhones, recordError } from '../src/monitor.js';
import { encryptText } from '../src/crypto.js';
import { handleRequest } from '../src/worker.js';

const NOW = Date.UTC(2026, 9, 15, 3, 0, 0);
const min = (n) => n * 60000;

async function setup() {
  const db = openSqliteD1(':memory:', fileURLToPath(new URL('../migrations', import.meta.url)));
  const mails = [];
  const env = { DB: db, ENCRYPTION_KEY: 'k', PUBLIC_BASE_URL: 'https://example.test', MAIL_SEND: async (m) => { mails.push(m); } };
  await db.prepare(`INSERT INTO users (username,pass_hash,role,email_verified_at,name,email) VALUES ('boss','x','super',1,'관리자','boss@willvi.co.kr')`).run();
  await db.prepare(`INSERT INTO gateways (department_id,name,username,password,hook_token) VALUES (7,'HR 폰','u',?, 't')`)
    .bind(await encryptText('k', 'pw')).run();
  return { db, env, mails };
}
const seen = (ms) => new Date(ms).toISOString();

test('상태 분류: ok / warn / down', () => {
  const base = { reachable: true, count: 1 };
  assert.equal(classify({ ...base, lastSeenMs: NOW - min(5) }, 0, NOW).health, 'ok');
  assert.equal(classify({ ...base, lastSeenMs: NOW - min(40) }, 0, NOW).health, 'warn');
  const down = classify({ ...base, lastSeenMs: NOW - min(300) }, 0, NOW);
  assert.equal(down.health, 'down');
  assert.match(down.note, /5시간 넘게/);
  assert.equal(classify({ reachable: false, error: '응답 401' }, 0, NOW).health, 'down');
  assert.equal(classify({ reachable: true, count: 0 }, 0, NOW).health, 'down');
  // 최근 발송 실패가 쌓이면 응답이 있어도 down
  const f = classify({ ...base, lastSeenMs: NOW - min(2) }, 3, NOW);
  assert.equal(f.health, 'down');
  assert.match(f.note, /3건/);
});

test('폰 점검: down 이 되면 관리자에게 한 번만 메일, 복구되면 복구 메일', async () => {
  const { db, env, mails } = await setup();
  let state = { reachable: true, count: 1, lastSeen: seen(NOW - min(300)) };
  const check = async () => state;

  let r = await monitorPhones(env, NOW, check);
  assert.equal(r[0].health, 'down');
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, 'boss@willvi.co.kr');
  assert.match(mails[0].subject, /확인이 필요해요/);

  // 같은 상태가 계속되면 다시 보내지 않는다
  await monitorPhones(env, NOW + min(5), check);
  assert.equal(mails.length, 1);
  // 6시간이 지나도 계속 down 이면 한 번 더
  await monitorPhones(env, NOW + 7 * 3600000, check);
  assert.equal(mails.length, 2);

  // 복구
  state = { reachable: true, count: 1, lastSeen: seen(NOW + 7 * 3600000 + min(1)) };
  r = await monitorPhones(env, NOW + 7 * 3600000 + min(2), check);
  assert.equal(r[0].health, 'ok');
  assert.equal(mails.length, 3);
  assert.match(mails[2].subject, /다시 정상/);
  const row = await db.prepare(`SELECT health, alerted_at FROM gateways`).first();
  assert.equal(row.health, 'ok');
  assert.equal(row.alerted_at, null);
});

test('폰 점검: 응답 없음이 짧으면(warn) 메일을 보내지 않는다, 예약이 있으면 알림에 포함', async () => {
  const { db, env, mails } = await setup();
  await monitorPhones(env, NOW, async () => ({ reachable: true, count: 1, lastSeen: seen(NOW - min(40)) }));
  assert.equal(mails.length, 0);
  assert.equal((await db.prepare(`SELECT health FROM gateways`).first()).health, 'warn');

  await db.prepare(`INSERT INTO messages (gateway_id,phone,text,status,at,scheduled_at) VALUES (1,'01011112222','x','scheduled',?,?)`).bind(NOW, NOW + min(60)).run();
  await monitorPhones(env, NOW + min(5), async () => ({ reachable: false, error: 'timeout' }));
  assert.equal(mails.length, 1);
  assert.match(mails[0].text, /예약이 1건/);
});

test('오류 기록: 10분 안에 5건이면 관리자에게 메일(1시간 1회)', async () => {
  const { db, env, mails } = await setup();
  for (let i = 0; i < 4; i++) await recordError(env, 'request', new Error(`boom ${i}`), '/send');
  assert.equal(mails.length, 0);
  await recordError(env, 'request', new Error('boom 4'), '/send');
  assert.equal(mails.length, 1);
  assert.match(mails[0].subject, /시스템 오류/);
  for (let i = 0; i < 3; i++) await recordError(env, 'cron', new Error('again'), 'processQueue');
  assert.equal(mails.length, 1);
  const n = (await db.prepare(`SELECT COUNT(*) n FROM error_log`).first()).n;
  assert.equal(n, 8);
});

test('/healthz 는 DB 까지 확인한다', async () => {
  const { env } = await setup();
  const res = await handleRequest(new Request('https://example.test/healthz'), env, { waitUntil() {} });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.db, true);
  const broken = { ...env, DB: { prepare() { throw new Error('db down'); } } };
  const bad = await handleRequest(new Request('https://example.test/healthz'), broken, { waitUntil() {} });
  assert.equal(bad.status, 503);
});
