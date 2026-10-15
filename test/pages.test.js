import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openSqliteD1 } from '../src/node/d1-sqlite.js';
import { handleRequest } from '../src/worker.js';
import { createSession } from '../src/auth.js';
import { hashPassword, encryptText } from '../src/crypto.js';

async function setup() {
  const db = openSqliteD1(':memory:', fileURLToPath(new URL('../migrations', import.meta.url)));
  const env = {
    DB: db, ENCRYPTION_KEY: 'k', PUBLIC_BASE_URL: 'https://example.test',
    GATEWAY_URL: 'https://sms.example.test/api/3rdparty/v1', GATEWAY_PRIVATE_TOKEN: 'tok-123'
  };
  const u = await db.prepare(`INSERT INTO users (username,pass_hash,role) VALUES ('boss',?,'super')`).bind(await hashPassword('password123')).run();
  const sid = await createSession(db, Number(u.meta.last_row_id));
  const ctx = { waitUntil() {} };
  const call = (path, init = {}) => handleRequest(new Request('https://example.test' + path, {
    ...init, headers: { cookie: `sid=${sid}`, origin: 'https://example.test', ...(init.headers || {}) }
  }), env, ctx);
  const post = (path, fields) => call(path, {
    method: 'POST', body: new URLSearchParams(fields).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' }
  });
  return { db, env, call, post };
}

test('화면이 오류 없이 열리고 안내가 보인다', async () => {
  const { call } = await setup();
  for (const p of ['/', '/admin', '/messages', '/campaigns/new', '/audit', '/password']) {
    const r = await call(p);
    assert.equal(r.status, 200, p);
  }
  const admin = await (await call('/admin')).text();
  assert.match(admin, /https:\/\/sms\.example\.test\/api\/mobile\/v1/); // 폰 앱에 입력할 주소
  assert.match(admin, /tok-123/);                                       // 비밀 토큰
  const tpl = await call('/template.csv');
  assert.match(await tpl.text(), /사업장,이름,전화번호,면접일시/);
});

test('폰 연결 마법사: 새 부서 생성 + 게이트웨이 등록 + 사용 중지', async () => {
  const { db, post } = await setup();
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push([init?.method, String(url)]); return new Response('{}', { status: 201 }); };
  try {
    const res = await post('/admin', { do: 'connect', new_department: '인사팀', username: 'USER1', password: 'PASS1' });
    const html = await res.text();
    assert.match(html, /연결이 끝났어요/);
    assert.ok(calls.some(([m, u]) => m === 'POST' && u.endsWith('/webhooks')), '웹훅 자동 등록');
    const gw = await db.prepare(`SELECT * FROM gateways`).first();
    assert.equal(gw.name, '인사팀 폰');
    assert.match(gw.password, /^enc\$/); // 평문 저장 금지
    await post('/admin', { do: 'gw_active', gateway_id: String(gw.id), active: '0' });
    assert.equal((await db.prepare(`SELECT active FROM gateways`).first()).active, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('입력 누락 시 쉬운 안내 문구', async () => {
  const { post } = await setup();
  const html = await (await post('/admin', { do: 'connect', username: '', password: '' })).text();
  assert.match(html, /Username/);
});

test('면접 안내: 명단 올리기 → 보내기 화면 → 숫자 카드', async () => {
  const { db, call, post } = await setup();
  await db.prepare(`INSERT INTO departments (name) VALUES ('인사팀')`).run();
  await db.prepare(`INSERT INTO gateways (department_id,name,username,password,hook_token) VALUES (1,'인사팀 폰','u',?, 't')`)
    .bind(await encryptText('k', 'pw')).run();
  const form = await (await call('/campaigns/new')).text();
  assert.match(form, /명단 파일 고르기/);
  assert.match(form, /name="gateway_id" value="1"/); // 폰이 하나면 자동 선택
  const done = await (await post('/campaigns/new', {
    name: '면접 안내 10/20', gateway_id: '1', template: '{이름}님 안내', retention_days: '90',
    csv: '사업장,이름,전화번호\nA점,홍길동,010-1111-2222\nB점,김철수,010-3333-4444\n'
  })).text();
  assert.match(done, /2명을 불러왔어요/);
  const detail = await (await call('/campaigns/1')).text();
  assert.match(detail, /지금 바로 보내기 \(2명\)/);
  assert.match(detail, /아직 문자를 보내지 않았어요/);
  const home = await (await call('/')).text();
  assert.match(home, /면접 안내 문자 보내기/);
});

test('문자함: 공백/줄바꿈으로 구분한 여러 번호', async () => {
  const { db, post } = await setup();
  await db.prepare(`INSERT INTO departments (name) VALUES ('인사팀')`).run();
  await db.prepare(`INSERT INTO gateways (department_id,name,username,password,hook_token) VALUES (1,'폰','u',?, 't')`)
    .bind(await encryptText('k', 'pw')).run();
  const originalFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, init) => { sent.push(JSON.parse(init.body).phoneNumbers[0]); return new Response('{}', { status: 200 }); };
  try {
    await post('/messages', { gateway_id: '1', phones: '010-1111-2222\n010-3333-4444 01055556666', text: '안녕' });
  } finally { globalThis.fetch = originalFetch; }
  assert.deepEqual(sent, ['+821011112222', '+821033334444', '+821055556666']);
});

test('받기 시험: 폰이 자기 번호로 보낸 문자가 수신되면 성공, 안 오면 안내', async () => {
  const { db, env, post } = await setup();
  env.SELFTEST_WAIT_MS = 1500;
  await db.prepare(`INSERT INTO departments (name) VALUES ('인사팀')`).run();
  await db.prepare(`INSERT INTO gateways (department_id,name,username,password,hook_token) VALUES (1,'폰','u',?, 't')`)
    .bind(await encryptText('k', 'pw')).run();
  const { handleInbound } = await import('../src/core.js');
  const originalFetch = globalThis.fetch;
  try {
    // 1) 폰이 문자를 받아 서버에 알려주는 경우
    globalThis.fetch = async (url, init) => {
      const text = JSON.parse(init.body).textMessage.text;
      await handleInbound(db, 1, { sender: '+821012348711', message: text });
      return new Response('{}', { status: 202 });
    };
    let html = await (await post('/admin', { do: 'gw_selftest', gateway_id: '1', number: '010-1234-8711' })).text();
    assert.match(html, /받기 시험에 성공/);
    assert.equal((await db.prepare(`SELECT own_number FROM gateways`).first()).own_number, '01012348711');

    // 2) 폰이 알려주지 않는 경우
    globalThis.fetch = async () => new Response('{}', { status: 202 });
    html = await (await post('/admin', { do: 'gw_selftest', gateway_id: '1', number: '' })).text();
    assert.match(html, /알려 주지 않았어요/);
  } finally { globalThis.fetch = originalFetch; }
});

test('문자함: 받은 문자만 보기 탭과 목록', async () => {
  const { db, call } = await setup();
  await db.prepare(`INSERT INTO departments (name) VALUES ('인사팀')`).run();
  await db.prepare(`INSERT INTO gateways (department_id,name,username,password,hook_token) VALUES (1,'폰','u',?, 't')`)
    .bind(await encryptText('k', 'pw')).run();
  await db.prepare(`INSERT INTO inbound (gateway_id,sender,message,received_at,result) VALUES (1,'01029501868','참석합니다',?, 'unmatched')`).bind(Date.now()).run();
  await db.prepare(`INSERT INTO messages (gateway_id,phone,text,status,at) VALUES (1,'01029501868','안녕',?,?)`).bind('sent', Date.now()).run();
  const inOnly = await (await call('/messages?dir=in')).text();
  assert.match(inOnly, /받은 문자 \(1\)/);
  assert.match(inOnly, /참석합니다/);
  assert.doesNotMatch(inOnly, /<td[^>]*>안녕<\/td>/);
  const outOnly = await (await call('/messages?dir=out')).text();
  assert.match(outOnly, /안녕/);
  assert.doesNotMatch(outOnly, /<td[^>]*>참석합니다<\/td>/);
});

test('공개 클라우드 모드: 서버 주소/토큰 대신 암호화 안내, 암호화 비밀번호 저장', async () => {
  const { db, env, post, call } = await setup();
  env.GATEWAY_URL = 'https://api.sms-gate.app/3rdparty/v1';
  env.GATEWAY_PRIVATE_TOKEN = '';
  const page = await (await call('/admin')).text();
  assert.match(page, /문자 내용 암호화 켜기/);
  assert.doesNotMatch(page, /Private Token/);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 201 });
  try {
    await post('/admin', { do: 'connect', new_department: '인사팀', username: 'U', password: 'P', passphrase: '아주 긴 비밀 문장' });
  } finally { globalThis.fetch = originalFetch; }
  const gw = await db.prepare(`SELECT passphrase, base_url FROM gateways`).first();
  assert.match(gw.passphrase, /^enc\$/);
  assert.equal(gw.base_url, 'https://api.sms-gate.app/3rdparty/v1');
  assert.match(await (await call('/admin')).text(), /🔒 암호화/);
});
