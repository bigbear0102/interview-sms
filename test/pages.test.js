import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openSqliteD1 } from '../src/node/d1-sqlite.js';
import { handleRequest } from '../src/worker.js';
import { createSession } from '../src/auth.js';
import { hashPassword, encryptText } from '../src/crypto.js';

const visible = (html) => html.replace(/<(style|script)[\s\S]*?<\/\1>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

async function setup() {
  const db = openSqliteD1(':memory:', fileURLToPath(new URL('../migrations', import.meta.url)));
  const env = {
    DB: db, ENCRYPTION_KEY: 'k', PUBLIC_BASE_URL: 'https://example.test',
    GATEWAY_URL: 'https://sms.example.test/api/3rdparty/v1', GATEWAY_PRIVATE_TOKEN: 'tok-123'
  };
  const u = await db.prepare(`INSERT INTO users (username,pass_hash,role,email_verified_at,name,email) VALUES ('boss',?,'super',1,'김관리','boss@willvi.co.kr')`).bind(await hashPassword('password123')).run();
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
  assert.match(await tpl.text(), /사업장\(원가중심점\),이름,전화번호,면접일시/);
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
  assert.match(form, /대상자 명단/);
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
  assert.ok(home.includes('<title>홈 - 문자 관리 시스템</title>'));
  assert.ok(home.includes('href="/send"'));
  assert.match(home, /면접 안내/);
});

test('문자 보내기: 공백/줄바꿈으로 구분한 여러 번호는 큐에 담겨 발송된다', async () => {
  const { db, env, post } = await setup();
  await db.prepare(`INSERT INTO departments (name) VALUES ('인사팀')`).run();
  await db.prepare(`INSERT INTO gateways (department_id,name,username,password,hook_token) VALUES (1,'폰','u',?, 't')`)
    .bind(await encryptText('k', 'pw')).run();
  const originalFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, init) => { sent.push(JSON.parse(init.body).phoneNumbers[0]); return new Response('{}', { status: 200 }); };
  try {
    const res = await post('/send', { gateway_id: '1', phones: '010-1111-2222\n010-3333-4444 01055556666', text: '안녕', send_mode: 'now' });
    assert.match(await res.text(), /3명에게 보내는 중이에요/);
    // 요청 처리 중 백그라운드로 시작된 발송이 끝날 때까지 잠시 기다린다
    for (let i = 0; i < 40 && sent.length < 3; i++) await new Promise((r) => setTimeout(r, 25));
  } finally { globalThis.fetch = originalFetch; }
  assert.deepEqual([...sent].sort(), ['+821011112222', '+821033334444', '+821055556666']);
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
  assert.match(visible(inOnly), /받은 문자 1/);
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
  assert.match(await (await call('/admin')).text(), /<span class="badge info">암호화<\/span>/);
});

test('예약 발송: 명단 올릴 때 예약, 상세에서 변경/취소, 시간 되면 발송', async () => {
  const { db, env, call, post } = await setup();
  await db.prepare(`INSERT INTO departments (name) VALUES ('인사팀')`).run();
  await db.prepare(`INSERT INTO gateways (department_id,name,username,password,hook_token) VALUES (1,'인사팀 폰','u',?, 't')`)
    .bind(await encryptText('k', 'pw')).run();
  const { processQueue } = await import('../src/core.js');
  const csv = '사업장,이름,전화번호\nA점,홍길동,010-1111-2222\n';

  // 1) 올리면서 예약 (한국시간으로 해석됨): 내일 09:00 KST
  const t = new Date(Date.now() + 9 * 3600000 + 86400000);
  const pad = (n) => String(n).padStart(2, '0');
  const when = `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}T09:00`;
  const done = await (await post('/campaigns/new', {
    name: '예약 시험', gateway_id: '1', template: '{이름}님', retention_days: '90', csv, send_mode: 'schedule', when
  })).text();
  assert.match(done, /에 보내도록 예약했어요/);
  const c = await db.prepare(`SELECT status, scheduled_at FROM campaigns WHERE id=1`).first();
  assert.equal(c.status, 'scheduled');
  assert.equal(new Date(c.scheduled_at).toISOString().slice(11, 16), '00:00'); // 09:00 KST = 00:00 UTC

  // 2) 상세 화면: 예약 변경/취소 버튼
  const detail = await (await call('/campaigns/1')).text();
  assert.match(detail, /예약 시간 바꾸기/);
  assert.match(detail, /예약 취소하기/);

  // 3) 예약 취소 → 다시 '아직 안 보냄'
  await post('/campaigns/1/unschedule', {});
  assert.equal((await db.prepare(`SELECT status FROM campaigns WHERE id=1`).first()).status, 'draft');

  // 4) 지난 시간으로 예약하면 안내
  const past = await (await post('/campaigns/new', {
    name: '지난 시간', gateway_id: '1', template: 'x', csv, send_mode: 'schedule', when: '2020-01-01T09:00'
  })).text();
  assert.match(past, /이미 지난 시간/);

  // 5) 시간이 되면 큐가 발송한다 (게이트웨이 호출은 가짜로)
  await db.prepare(`UPDATE campaigns SET status='scheduled', scheduled_at=? WHERE id=1`).bind(Date.now() - 1000).run();
  const sent = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { sent.push(JSON.parse(init.body).phoneNumbers[0]); return new Response('{}', { status: 202 }); };
  try { await processQueue(env, { batchSize: 5 }); } finally { globalThis.fetch = originalFetch; }
  assert.deepEqual(sent, ['+821011112222']);
  assert.equal((await db.prepare(`SELECT status FROM campaigns WHERE id=1`).first()).status, 'done');
});

test('문자 보내기: 예약 → 예약 목록 → 취소 → 시간이 되면 발송', async () => {
  const { db, env, call, post } = await setup();
  await db.prepare(`INSERT INTO departments (name) VALUES ('인사팀')`).run();
  await db.prepare(`INSERT INTO gateways (department_id,name,username,password,hook_token) VALUES (1,'폰','u',?, 't')`)
    .bind(await encryptText('k', 'pw')).run();
  const { processQueue } = await import('../src/core.js');
  const t = new Date(Date.now() + 9 * 3600000 + 2 * 86400000);
  const pad = (n) => String(n).padStart(2, '0');
  const when = `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}T10:30`;

  // 예약 두 건
  const ok = await (await post('/send', { gateway_id: '1', phones: '010-1111-2222, 010-3333-4444', text: '예약 문자', send_mode: 'schedule', when })).text();
  assert.match(ok, /2명에게 .*에 보내도록 예약했어요/);
  const list = await (await call('/messages?dir=scheduled')).text();
  assert.match(visible(list), /예약 문자 2/);
  assert.match(list, /예약 취소/);

  // 아직 시간이 안 됐으니 큐가 건드리지 않는다
  const sent = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { sent.push(JSON.parse(init.body).phoneNumbers[0]); return new Response('{}', { status: 202 }); };
  try {
    await processQueue(env, { batchSize: 10 });
    assert.equal(sent.length, 0);

    // 한 건 취소
    const first = await db.prepare(`SELECT id FROM messages ORDER BY id LIMIT 1`).first();
    await post('/messages/cancel', { id: String(first.id) });
    assert.equal((await db.prepare(`SELECT status FROM messages WHERE id=?`).bind(first.id).first()).status, 'cancelled');

    // 시간이 되면 남은 한 건만 발송
    await db.prepare(`UPDATE messages SET scheduled_at=? WHERE status='scheduled'`).bind(Date.now() - 1000).run();
    await processQueue(env, { batchSize: 10 });
  } finally { globalThis.fetch = originalFetch; }
  assert.deepEqual(sent, ['+821033334444']);
  assert.equal((await db.prepare(`SELECT status FROM messages WHERE phone='01033334444'`).first()).status, 'sent');
});

test('홈: 오늘 보낸/받은 문자 요약과 빠른 실행', async () => {
  const { db, call } = await setup();
  await db.prepare(`INSERT INTO departments (name) VALUES ('인사팀')`).run();
  await db.prepare(`INSERT INTO gateways (department_id,name,username,password,hook_token) VALUES (1,'폰','u',?, 't')`)
    .bind(await encryptText('k', 'pw')).run();
  await db.prepare(`INSERT INTO messages (gateway_id,phone,text,status,at) VALUES (1,'01011112222','안녕','sent',?)`).bind(Date.now()).run();
  await db.prepare(`INSERT INTO inbound (gateway_id,sender,message,received_at,result) VALUES (1,'01011112222','네',?, 'unmatched')`).bind(Date.now()).run();
  const home = await (await call('/')).text();
  assert.match(home, /<b>1<\/b><span>오늘 보낸 문자<\/span>/);
  assert.match(home, /<b>1<\/b><span>오늘 받은 문자<\/span>/);
  for (const href of ['/send', '/messages', '/messages?dir=scheduled', '/campaigns']) assert.ok(home.includes(`href="${href}"`), href);
  const camps = await call('/campaigns');
  assert.equal(camps.status, 200);
});

test('면접 안내: 사업장 직접 입력, 미리보기, 사업장별 회신 현황', async () => {
  const { db, env, call, post } = await setup();
  const setupEnvFor = async () => env;
  await db.prepare(`INSERT INTO departments (name) VALUES ('인사팀')`).run();
  await db.prepare(`INSERT INTO gateways (department_id,name,username,password,hook_token) VALUES (1,'폰','u',?, 't')`)
    .bind(await encryptText('k', 'pw')).run();
  const { handleInbound, processQueue } = await import('../src/core.js');

  // 화면: 사업장 입력 칸, 기본 문구에 사업장 없음, 미리보기
  const form = await (await call('/campaigns/new')).text();
  assert.match(form, /name="default_site"/);
  assert.match(form, /id="preview"/);
  const tplText = (form.match(/<textarea name="template"[^>]*>([\s\S]*?)<\/textarea>/) || [])[1] || '';
  assert.ok(tplText.length > 0 && !tplText.includes('사업장'), '기본 문구에 사업장 없음');

  // 사업장 열 없이 올리고, 사업장은 화면에서 입력 (4명)
  const csv = '이름,전화번호,면접일시\n가,010-1000-0001,10/20 14:00\n나,010-1000-0002,10/20 14:00\n다,010-1000-0003,10/20 14:00\n라,010-1000-0004,10/20 14:00\n';
  const done = await (await post('/campaigns/new', { name: '시험', gateway_id: '1', csv, default_site: '1001 강남점', template: '' })).text();
  assert.match(done, /4명을 불러왔어요/);

  // 발송 → 회신 (참석 2, 불참 1, 무응답 1)
  await db.prepare(`UPDATE campaigns SET status='scheduled', scheduled_at=? WHERE id=1`).bind(Date.now() - 1000).run();
  const originalFetch = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (url, init) => { bodies.push(JSON.parse(init.body)); return new Response('{}', { status: 202 }); };
  try { await processQueue({ ...(await setupEnvFor(db)) }, { batchSize: 10 }); } finally { globalThis.fetch = originalFetch; }
  assert.equal(bodies.length, 4);
  assert.ok(!bodies[0].textMessage.text.includes('강남점'));
  assert.match(bodies[0].textMessage.text, /\n/);
  await handleInbound(db, 1, { sender: '010-1000-0001', message: '참석합니다' });
  await handleInbound(db, 1, { sender: '010-1000-0002', message: '참석' });
  await handleInbound(db, 1, { sender: '010-1000-0003', message: '불참합니다' });

  const detail = await (await call('/campaigns/1')).text();
  assert.match(detail, /사업장\(원가중심점\)별 회신 현황/);
  assert.match(detail, /1001 강남점/);
  // 보냄 4, 회신 3, 회신율 75%, 참석 2, 불참 1
  assert.match(visible(detail), /1001 강남점 4 3 75% 2 1 0 1 0\b/);
  assert.ok(detail.includes('보낸(보낼) 문자 보기'));

  const csvOut = await (await call('/campaigns/1/export.csv')).text();
  assert.match(csvOut, /사업장\(원가중심점\)/);
  assert.match(csvOut, /1001 강남점/);
});

test('폰 설치 안내: Obtainium으로 처음부터 설치, 막힘 해결 안내, 설정 단계 번호', async () => {
  const { call } = await setup();
  const r = await call('/help/phone');
  assert.equal(r.status, 200);
  const html = await r.text();
  const text = visible(html);
  for (const w of ['Obtainium', 'app-release.apk', 'app-insecure.apk', '자동 차단', '제한된 설정 허용', '채팅']) {
    assert.ok(text.includes(w), w);
  }
  assert.match(html, /tok-123/); // 관리자에게는 토큰 표시
  const admin = visible(await (await call('/admin')).text());
  assert.ok(admin.includes('Obtainium'));
  assert.ok(admin.includes('1~9번'));
});

test('면접 안내: 한 명에게만 보내기, 홈 현황판(사업장·날짜별)', async () => {
  const { db, call, post } = await setup();
  await db.prepare(`INSERT INTO departments (name) VALUES ('인사팀')`).run();
  await db.prepare(`INSERT INTO gateways (department_id,name,username,password,hook_token) VALUES (1,'폰','u',?, 't')`).bind(await encryptText('p', 'k')).run();
  const gwRow = await db.prepare(`SELECT id FROM gateways LIMIT 1`).first();
  assert.ok(gwRow, "gateway fixture");
  const r = await post('/campaigns/new', { mode: 'one', one_site: '1001 강남점', one_name: '홍길동', one_phone: '010-1234-5678', one_when: '10/20 14:00', template: '{이름} {면접일시}', gateway_id: String(gwRow.id), name: '면접 안내 10-15', send_mode: 'manual' });
  assert.equal(r.status, 200);
  const c = await db.prepare(`SELECT COUNT(*) n FROM candidates WHERE site='1001 강남점' AND name='홍길동'`).first();
  assert.equal(c.n, 1);
  await db.prepare(`UPDATE candidates SET status='attending', sent_at=?`).bind(Date.now()).run();
  const home = visible(await (await call('/')).text());
  assert.ok(home.includes('면접 안내 현황'));
  assert.ok(home.includes('1001 강남점'));
  assert.ok(home.includes('합계'));
});

test('소개 페이지: 로그인 전 첫 화면은 누구나, 로그인 버튼과 장표가 있다', async () => {
  const { db, env } = await setup();
  const anon = await handleRequest(new Request('https://example.test/'), env, { waitUntil() {} });
  assert.equal(anon.status, 200);
  const html = await anon.text();
  assert.match(html, /href="\/login"/);
  assert.doesNotMatch(html, /발표 모드/);
  assert.match(html, /noindex/);
  assert.equal((html.match(/class="slide"/g) || []).length, 12);
  assert.doesNotMatch(html, /tok-123|SMSGate|Cloudflare|sms\.example/); // 내부 정보 비노출
  const login = await handleRequest(new Request('https://example.test/login'), env, { waitUntil() {} });
  assert.equal(login.status, 200);
  const other = await handleRequest(new Request('https://example.test/campaigns'), env, { waitUntil() {} });
  assert.equal(other.status, 303);
  void db;
});

test('면접 안내: 엑셀에서 복사한 표(제목 줄 없음)를 그대로 붙여넣어 올리기', async () => {
  const { db, call, post } = await setup();
  await db.prepare(`INSERT INTO departments (name) VALUES ('인사팀')`).run();
  await db.prepare(`INSERT INTO gateways (department_id,name,username,password,hook_token) VALUES (1,'폰','u',?, 't')`).bind(await encryptText('p', 'k')).run();
  const form = await (await call('/campaigns/new')).text();
  assert.match(form, /붙여넣기\(Ctrl\+V\)/);
  assert.match(form, /id="paste-preview"/);
  const paste = '홍길동\t010-1234-5678\t10/20 14:00\n김영희\t010-2345-6789\t10/20 14:30\n';
  const res = await post('/campaigns/new', { mode: 'many', csv: paste, default_site: '아마노코리아(현장HR)', gateway_id: '1', template: '{이름}님', send_mode: 'manual' });
  assert.equal(res.status, 200);
  const rows = (await db.prepare(`SELECT name, site, interview_at FROM candidates ORDER BY id`).all()).results;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].site, '아마노코리아(현장HR)');
  assert.equal(rows[1].interview_at, '10/20 14:30');
});
