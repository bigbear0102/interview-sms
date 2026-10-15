import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openSqliteD1 } from '../src/node/d1-sqlite.js';
import { handleRequest } from '../src/worker.js';
import { hashPassword } from '../src/crypto.js';
import { isAllowedEmail } from '../src/accounts.js';

async function setup({ mail = true } = {}) {
  const db = openSqliteD1(':memory:', fileURLToPath(new URL('../migrations', import.meta.url)));
  const mails = [];
  const env = {
    DB: db, ENCRYPTION_KEY: 'k', PUBLIC_BASE_URL: 'https://example.test',
    GATEWAY_URL: 'https://api.sms-gate.app/3rdparty/v1',
    ...(mail ? { MAIL_SEND: async (m) => { mails.push(m); } } : {})
  };
  const ctx = { waitUntil() {} };
  const req = (path, init = {}) => handleRequest(new Request('https://example.test' + path, {
    ...init, headers: { origin: 'https://example.test', 'cf-connecting-ip': '1.2.3.4', ...(init.headers || {}) }
  }), env, ctx);
  const post = (path, fields, headers = {}) => req(path, {
    method: 'POST', body: new URLSearchParams(fields).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }
  });
  return { db, env, mails, req, post };
}
const visible = (html) => html.replace(/<(style|script)[\s\S]*?<\/\1>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const signup = (over = {}) => ({
  name: '홍길동', email: 'gildong@willvi.co.kr', phone: '010-1234-5678', department_id: '7',
  password: 'password123', password2: 'password123', ...over
});

test('이메일 도메인: @willvi.co.kr 만 허용(우회 표기 차단)', () => {
  const env = {};
  assert.ok(isAllowedEmail(env, 'a.b@willvi.co.kr'));
  assert.ok(isAllowedEmail(env, ' A@WILLVI.CO.KR '));
  for (const bad of ['a@gmail.com', 'a@willvi.co.kr.evil.com', 'a@mail.willvi.co.kr', 'a@evilwillvi.co.kr',
    'a@willvi.co.kr@evil.com', 'a b@willvi.co.kr', '@willvi.co.kr', 'a@willvi.co.krx', '']) {
    assert.ok(!isAllowedEmail(env, bad), bad);
  }
});

test('가입 화면: 12개 부서가 정해진 순서로 나온다', async () => {
  const { req } = await setup();
  const html = await (await req('/signup')).text();
  const names = [...html.matchAll(/<option value="\d+"[^>]*>([^<]+)<\/option>/g)].map((m) => m[1]).filter((n) => n !== '부서를 골라 주세요');
  assert.deepEqual(names, ['임원실', '경영지원본부', '마케팅영업본부', 'CRM운영본부', '물류사업본부', '윌비모터스',
    'HR본부', 'FM사업부문', 'IT사업본부', '지사', '동부캐리어', '센터']);
});

test('가입 → 인증 전 로그인 불가 → 메일 링크로 인증 → 로그인 → 선택한 부서만 보인다', async () => {
  const { db, mails, req, post } = await setup();
  const dept = await db.prepare(`SELECT id FROM departments WHERE name='마케팅영업본부'`).first();

  const res = await post('/signup', signup({ department_id: String(dept.id) }));
  assert.equal(res.status, 200);
  assert.match(visible(await res.text()), /인증 메일을 보냈어요/);
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, 'gildong@willvi.co.kr');
  const link = mails[0].text.match(/https:\/\/example\.test\/verify\?token=[0-9a-f]+/)[0];

  // 저장된 계정: 이름/이메일/휴대폰/부서, 인증 전
  const u = await db.prepare(`SELECT * FROM users WHERE email='gildong@willvi.co.kr'`).first();
  assert.equal(u.name, '홍길동');
  assert.equal(u.phone, '01012345678');
  assert.equal(u.role, 'admin');
  assert.equal(u.email_verified_at, null);
  assert.ok(!u.pass_hash.includes('password123'));
  const ud = await db.prepare(`SELECT department_id FROM user_departments WHERE user_id=?`).bind(u.id).all();
  assert.deepEqual(ud.results.map((r) => r.department_id), [dept.id]);

  // 인증 전 로그인: 막힌다
  const before = await post('/login', { email: 'gildong@willvi.co.kr', password: 'password123' });
  assert.equal(before.status, 403);
  assert.match(visible(await before.text()), /이메일 인증이 필요해요/);

  // 링크로 인증 (1회용)
  const v = await req(link.replace('https://example.test', ''), { redirect: 'manual' });
  assert.equal(v.status, 303);
  assert.equal(v.headers.get('location'), '/login?verified=1');
  const again = await req(link.replace('https://example.test', ''));
  assert.equal(again.status, 400);

  // 이메일(대소문자 무관) + 비밀번호 로그인
  const login = await post('/login', { email: 'GilDong@willvi.co.kr', password: 'password123' });
  assert.equal(login.status, 303);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const home = await req('/', { headers: { cookie } });
  assert.equal(home.status, 200);
  const homeHtml = await home.text();
  assert.match(homeHtml, /홍길동/);
  // 일반 사용자는 설정 화면 접근 불가
  assert.equal((await req('/admin', { headers: { cookie } })).status, 403);
});

test('가입 검증: 다른 도메인, 휴대폰 형식, 짧은 비밀번호, 부서 누락, 비밀번호 확인', async () => {
  const { post, mails } = await setup();
  const cases = [
    [{ email: 'a@gmail.com' }, /@willvi\.co\.kr/],
    [{ phone: '123' }, /휴대폰/],
    [{ password: 'short', password2: 'short' }, /8글자/],
    [{ department_id: '' }, /부서/],
    [{ password2: 'different123' }, /비밀번호 확인/],
    [{ name: '가' }, /이름/]
  ];
  for (const [over, re] of cases) {
    const r = await post('/signup', signup(over));
    assert.equal(r.status, 400, JSON.stringify(over));
    assert.match(visible(await r.text()), re);
  }
  assert.equal(mails.length, 0);
});

test('메일 발송이 설정되지 않아도 가입은 접수되고, 관리자가 승인하면 로그인할 수 있다', async () => {
  const { db, req, post } = await setup({ mail: false });
  const res = await post('/signup', signup());
  assert.match(visible(await res.text()), /관리자에게 승인을 요청/);
  const u = await db.prepare(`SELECT id, email_verified_at FROM users WHERE email='gildong@willvi.co.kr'`).first();
  assert.equal(u.email_verified_at, null);

  // 관리자 로그인 후 승인
  await db.prepare(`INSERT INTO users (username,pass_hash,role,email_verified_at,name,email) VALUES ('boss',?,'super',1,'관리자','boss@willvi.co.kr')`)
    .bind(await hashPassword('adminpass123')).run();
  const adm = await post('/login', { email: 'boss@willvi.co.kr', password: 'adminpass123' });
  const cookie = adm.headers.get('set-cookie').split(';')[0];
  const page = await (await req('/admin', { headers: { cookie } })).text();
  assert.match(visible(page), /이메일 인증 대기/);
  await post('/admin', { do: 'user_verify', user_id: String(u.id) }, { cookie });

  const login = await post('/login', { email: 'gildong@willvi.co.kr', password: 'password123' });
  assert.equal(login.status, 303);
});

test('비밀번호 재설정: 메일 링크 → 새 비밀번호 → 이전 비밀번호는 거부', async () => {
  const { db, mails, req, post } = await setup();
  await post('/signup', signup());
  const link = mails[0].text.match(/\/verify\?token=[0-9a-f]+/)[0];
  await req(link);

  const r = await post('/forgot', { email: 'gildong@willvi.co.kr' });
  assert.match(visible(await r.text()), /메일을 보냈어요/);
  assert.equal(mails.length, 2);
  const reset = mails[1].text.match(/\/reset\?token=[0-9a-f]+/)[0];
  assert.equal((await req(reset)).status, 200);

  const token = reset.split('=')[1];
  const bad = await post('/reset', { token, password: 'newpassword1', password2: 'x' });
  assert.equal(bad.status, 400);
  const ok = await post('/reset', { token, password: 'newpassword1', password2: 'newpassword1' });
  assert.equal(ok.status, 303);
  assert.equal((await req(reset)).status, 400); // 1회용

  assert.equal((await post('/login', { email: 'gildong@willvi.co.kr', password: 'password123' })).status, 401);
  assert.equal((await post('/login', { email: 'gildong@willvi.co.kr', password: 'newpassword1' })).status, 303);
});

test('가입되지 않은/외부 이메일로 재설정을 요청해도 메일이 나가지 않고 같은 응답', async () => {
  const { mails, post } = await setup();
  const r = await post('/forgot', { email: 'nobody@willvi.co.kr' });
  assert.match(visible(await r.text()), /메일을 보냈어요/);
  assert.equal(mails.length, 0);
  const bad = await post('/forgot', { email: 'x@gmail.com' });
  assert.equal(bad.status, 429);
});

test('가입 횟수 제한', async () => {
  const { post } = await setup();
  let last;
  for (let i = 0; i < 7; i++) last = await post('/signup', signup({ email: 'gildong@willvi.co.kr', name: `홍길동${i}` }));
  assert.equal(last.status, 400);
  assert.match(visible(await last.text()), /너무 많아요/);
});

test('관리자: 사용자 수정(이름/이메일/부서/권한), 삭제', async () => {
  const { db, req, post } = await setup();
  await db.prepare(`INSERT INTO users (username,pass_hash,role,email_verified_at,name,email) VALUES ('boss',?,'super',1,'관리자','boss@willvi.co.kr')`)
    .bind(await hashPassword('adminpass123')).run();
  const adm = await post('/login', { email: 'boss@willvi.co.kr', password: 'adminpass123' });
  const cookie = adm.headers.get('set-cookie').split(';')[0];
  const depA = await db.prepare(`SELECT id FROM departments WHERE name='IT사업본부'`).first();
  const depB = await db.prepare(`SELECT id FROM departments WHERE name='센터'`).first();

  await post('/admin', { do: 'user', name: '김직원', email: 'staff@willvi.co.kr', phone: '010-9999-0000', password: 'staffpass123', role: 'admin', [`dep_${depA.id}`]: '1' }, { cookie });
  const u = await db.prepare(`SELECT * FROM users WHERE email='staff@willvi.co.kr'`).first();
  assert.ok(u.email_verified_at);

  await post('/admin', { do: 'user_edit', user_id: String(u.id), name: '김과장', email: 'staff2@willvi.co.kr', phone: '010-1111-2222', role: 'admin', [`dep_${depB.id}`]: '1' }, { cookie });
  const e = await db.prepare(`SELECT * FROM users WHERE id=?`).bind(u.id).first();
  assert.equal(e.name, '김과장');
  assert.equal(e.email, 'staff2@willvi.co.kr');
  assert.equal(e.phone, '01011112222');
  const deps = await db.prepare(`SELECT department_id FROM user_departments WHERE user_id=?`).bind(u.id).all();
  assert.deepEqual(deps.results.map((r) => r.department_id), [depB.id]);

  await post('/admin', { do: 'user_delete', user_id: String(u.id) }, { cookie });
  assert.equal(await db.prepare(`SELECT id FROM users WHERE id=?`).bind(u.id).first(), null);

  // 자기 자신은 지울 수 없다
  const me = await db.prepare(`SELECT id FROM users WHERE username='boss'`).first();
  await post('/admin', { do: 'user_delete', user_id: String(me.id) }, { cookie });
  assert.ok(await db.prepare(`SELECT id FROM users WHERE id=?`).bind(me.id).first());
});
