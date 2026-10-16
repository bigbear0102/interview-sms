import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openSqliteD1 } from '../src/node/d1-sqlite.js';
import { handleRequest } from '../src/worker.js';
import { createSession } from '../src/auth.js';
import { hashPassword } from '../src/crypto.js';

const visible = (html) => html.replace(/<(style|script)[\s\S]*?<\/\1>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

async function setup(role = 'super') {
  const db = openSqliteD1(':memory:', fileURLToPath(new URL('../migrations', import.meta.url)));
  const env = { DB: db, ENCRYPTION_KEY: 'k', PUBLIC_BASE_URL: 'https://example.test', GATEWAY_URL: 'https://x/api/3rdparty/v1', GATEWAY_PRIVATE_TOKEN: 't' };
  const u = await db.prepare(`INSERT INTO users (username,pass_hash,role,email_verified_at,name,email) VALUES ('boss',?,?,1,'김관리','b@willvi.co.kr')`).bind(await hashPassword('x'), role).run();
  const uid = Number(u.meta.last_row_id);
  if (role !== 'super') await db.prepare(`INSERT INTO user_departments (user_id, department_id) VALUES (?,1)`).bind(uid).run();
  const sid = await createSession(db, uid);
  const call = (p, init = {}) => handleRequest(new Request('https://example.test' + p, { ...init, headers: { cookie: `sid=${sid}`, origin: 'https://example.test', ...(init.headers || {}) } }), env, { waitUntil() {} });
  const post = (p, f) => call(p, { method: 'POST', body: new URLSearchParams(f).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  return { db, call, post };
}

test('하단 탭: 4칸 + 더보기(지원자 관리, 설정, 내 계정, 폰 설치 안내, 로그아웃)', async () => {
  const { call } = await setup('super');
  const html = await (await call('/')).text();
  const tab = html.match(/<nav class="tabbar"[\s\S]*?<\/nav>/)[0];
  assert.equal((tab.match(/<a /g) || []).length, 4);
  assert.match(tab, /class="tabmore/);
  const sheet = html.match(/<div class="moresheet"[\s\S]*?<\/ul><\/div>/)[0];
  for (const w of ['지원자 관리', '설정', '내 계정', '폰 설치 안내', '기록 보기', '로그아웃']) assert.ok(sheet.includes(w), w);
  // 일반 사용자는 설정/기록 보기가 더보기에 없다
  const staff = await setup('admin');
  const h2 = await (await staff.call('/')).text();
  const s2 = h2.match(/<div class="moresheet"[\s\S]*?<\/ul><\/div>/)[0];
  assert.ok(!s2.includes('기록 보기'));
  assert.ok(!s2.includes('>설정<'));
  assert.ok(s2.includes('지원자 관리'));
});

test('홈: "오늘 할 일"이 맨 위, 할 일이 없으면 안내', async () => {
  const { call, db } = await setup('super');
  let html = visible(await (await call('/')).text());
  assert.ok(html.includes('오늘 할 일'));
  assert.ok(html.includes('지금 처리할 일이 없어요'));
  assert.ok(html.indexOf('오늘 할 일') < html.indexOf('면접 안내 현황'));
  // 안 읽은 문자와 예약 대기, 미회신이 생기면 항목이 나온다
  await db.prepare(`INSERT INTO departments (name) VALUES ('시험부서')`).run().catch(() => {});
  await db.prepare(`INSERT INTO gateways (department_id,name,username,password,hook_token) VALUES (1,'폰','u','p','t')`).run();
  await db.prepare(`INSERT INTO inbound (gateway_id,sender,message,received_at,result) VALUES (1,'01011112222','안녕',?, 'unmatched')`).bind(Date.now()).run();
  await db.prepare(`INSERT INTO campaigns (department_id,gateway_id,name,template,created_at,status) VALUES (1,1,'시험','x',?, 'done')`).bind(Date.now()).run();
  await db.prepare(`INSERT INTO candidates (campaign_id,site,name,phone,status,sent_at) VALUES (1,'A','가','01011110001','sent',?)`).bind(Date.now() - 3600000).run();
  html = visible(await (await call('/')).text());
  assert.ok(html.includes('안 읽은 받은 문자'));
  assert.ok(html.includes('아직 답이 없는 사람'));
  assert.ok(!html.includes('지금 처리할 일이 없어요'));
});

test('설정: 구역 이동 메뉴와 구역 id', async () => {
  const { call } = await setup('super');
  const html = await (await call('/admin')).text();
  for (const id of ['sec-phones', 'sec-system', 'sec-connect', 'sec-users', 'sec-depts']) {
    assert.match(html, new RegExp(`id="${id}"`), id);
    assert.match(html, new RegExp(`href="#${id}"`), id);
  }
});

test('사람 화면 통합: 면접 안내 이력은 지원자 관리 메뉴 아래, 등록 여부 표시', async () => {
  const { call, post, db } = await setup('super');
  await db.prepare(`INSERT INTO gateways (department_id,name,username,password,hook_token) VALUES (1,'폰','u','p','t')`).run();
  await db.prepare(`INSERT INTO campaigns (department_id,gateway_id,name,template,created_at,status) VALUES (1,1,'시험','x',?, 'done')`).bind(Date.now()).run();
  await db.prepare(`INSERT INTO candidates (campaign_id,site,name,phone,status,sent_at) VALUES (1,'A','홍길동','01011110001','attending',?),(1,'A','김영희','01011110002','sent',?)`).bind(Date.now(), Date.now()).run();
  await post('/applicants/new', { name: '홍길동', phone: '010-1111-0001', applied_to: 'A', job: '' });
  const list = await (await call('/campaigns')).text();
  assert.ok(!list.includes('href="/people"'), '면접 안내 목록에서 지원자 이력 버튼 제거');
  const page = await (await call('/people')).text();
  assert.match(page, /면접 안내 이력/);
  assert.match(page, /href="\/applicants"/);                    // 지원자 목록 탭
  assert.match(page, /<span class="badge ok">등록됨<\/span>/);    // 홍길동은 등록됨
  assert.match(page, /지원자로 등록/);                            // 김영희는 등록 버튼
  // 상단 메뉴에서는 지원자 관리가 현재 위치로 표시된다
  assert.match(page, /<a href="\/applicants" aria-current="page">[\s\S]{0,600}?지원자 관리/);
  // 등록 버튼 → 지원자 상세로
  const reg = await post('/applicants/new', { name: '김영희', phone: '01011110002' });
  assert.match(reg.headers.get('location'), /^\/applicants\/\d+$/);
});

test('지원자 줄 행동: 수정 · 기록 + 더 보기 메뉴', async () => {
  const { call, post } = await setup('super');
  await post('/applicants/new', { name: '홍길동', phone: '010-1111-0001', applied_to: 'A', job: '현장' });
  const html = await (await call('/applicants')).text();
  assert.match(html, /<details class="more">/);
  assert.match(html, /블랙리스트로 등록/);
  assert.match(html, /상세 화면 열기/);
  assert.match(html, /class="tabs"><a href="\/applicants" aria-current="page">지원자 목록<\/a><a href="\/people">면접 안내 이력<\/a>/);
});
