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
    assert.match(html, /연결을 마쳤습니다/);
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
