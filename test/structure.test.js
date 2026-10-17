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

test('하단 탭: 홈·지원자·면접·문자함 + 더보기(문자 보내기, 설정, 내 계정, 폰 설치 안내, 로그아웃)', async () => {
  const { call } = await setup('super');
  const html = await (await call('/')).text();
  const tab = html.match(/<nav class="tabbar"[\s\S]*?<\/nav>/)[0];
  assert.equal((tab.match(/<a /g) || []).length, 4);
  assert.match(tab, /class="tabmore/);
  assert.deepEqual([...tab.matchAll(/<span>([^<]+)<\/span>/g)].map((m) => m[1]).slice(0, 4), ['홈', '지원자', '면접', '문자함']);
  const sheet = html.match(/<div class="moresheet"[\s\S]*?<\/ul><\/div>/)[0];
  for (const w of ['문자 보내기', '설정', '내 계정', '폰 설치 안내', '기록 보기', '로그아웃']) assert.ok(sheet.includes(w), w);
  // 일반 사용자는 설정/기록 보기가 더보기에 없다
  const staff = await setup('admin');
  const h2 = await (await staff.call('/')).text();
  const s2 = h2.match(/<div class="moresheet"[\s\S]*?<\/ul><\/div>/)[0];
  assert.ok(!s2.includes('기록 보기'));
  assert.ok(!s2.includes('>설정<'));
  assert.ok(s2.includes('문자 보내기'));
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
  assert.ok(!html.includes('안 읽은 받은 문자'));   // 안 읽은 문자는 탭 뱃지로 충분(할 일 아님)
  assert.ok(html.includes('답이 없는 사람'));
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

test('사람 화면 통합: 면접 이력은 지원자 목록에 합침, 미등록 면접 대상은 안내에서 등록', async () => {
  const { call, post, db } = await setup('super');
  await db.prepare(`INSERT INTO gateways (department_id,name,username,password,hook_token) VALUES (1,'폰','u','p','t')`).run();
  await db.prepare(`INSERT INTO campaigns (department_id,gateway_id,name,template,created_at,status) VALUES (1,1,'시험','x',?, 'done')`).bind(Date.now()).run();
  await db.prepare(`INSERT INTO candidates (campaign_id,site,name,phone,status,sent_at) VALUES (1,'A','홍길동','01011110001','attending',?),(1,'A','김영희','01011110002','sent',?)`).bind(Date.now(), Date.now()).run();
  await post('/applicants/new', { name: '홍길동', phone: '010-1111-0001', applied_to: 'A', job: '' });
  const list = await (await call('/campaigns')).text();
  assert.ok(!list.includes('href="/people"'), '면접 안내 목록에서 지원자 이력 버튼 제거');
  // 면접 이력은 지원자 목록에 합쳤다: 진행 칸에 안내 횟수, 미등록 면접 대상은 목록 위 안내 → /people
  const lst = await (await call('/applicants')).text();
  assert.match(lst, /면접 안내 1회/);
  assert.match(lst, /지원자로 등록되지 않은 사람이 <b>1명<\/b>[\s\S]{0,80}href="\/people"/);
  assert.doesNotMatch(lst, /<a href="\/people">면접 이력<\/a>/);
  const page = await (await call('/people')).text();
  assert.match(page, /<span class="badge ok">등록됨<\/span>/);    // 홍길동은 등록됨
  assert.match(page, /지원자로 등록/);                            // 김영희는 등록 버튼
  // 상단 메뉴에서는 지원자가 현재 위치로 표시된다
  assert.match(page, /<a href="\/applicants\/inbox" aria-current="page">[\s\S]{0,600}?지원자/);
  // 등록 버튼 → 지원자 상세로
  const reg = await post('/applicants/new', { name: '김영희', phone: '01011110002' });
  assert.match(reg.headers.get('location'), /^\/applicants\/\d+$/);
});

test('지원자 목록: 위쪽 탭(일의 순서), 행 누르면 상세, 추가·올리기 대화 창, 일괄 처리 막대', async () => {
  const { call, post } = await setup('super');
  await post('/applicants/new', { name: '홍길동', phone: '010-1111-0001', applied_to: 'A', job: '현장' });
  const html = await (await call('/applicants')).text();
  // 탭: 새 지원 → 지원자 → 공고 정리 → 면접 이력, 연결 설정은 오른쪽 끝
  assert.match(html, /<nav class="wstabs"[^>]*><a href="\/applicants\/inbox">새 지원<\/a><a href="\/applicants" aria-current="page">지원자<\/a><a href="\/applicants\/postings">공고 정리<\/a><a class="push" href="\/applicants\/inbox\/connect">/);
  assert.match(html, /data-dialog="dlg-add"/);
  assert.match(html, /data-dialog="dlg-import"/);
  assert.match(html, /<tr data-href="\/applicants\/\d+">/);
  assert.match(html, /class="bulkdock"/);
  // 상세: 문자 보내기·수정·블랙리스트 등록 대화 창
  const id = (html.match(/data-href="\/applicants\/(\d+)"/) || [])[1];
  const d = await (await call('/applicants/' + id)).text();
  assert.match(d, /href="\/send\?to=01011110001"/);
  assert.match(d, /id="dlg-edit"/);
  assert.match(d, /id="dlg-bl"/);
});

test('공통 스크립트: 확인 대화상자, 제출 중 잠금, 표 머리글 scope', async () => {
  const { call, post } = await setup('super');
  await post('/applicants/new', { name: '홍길동', phone: '010-1111-0001', applied_to: 'A', job: '현장' });
  const html = await (await call('/applicants')).text();
  assert.match(html, /window\.askConfirm/);
  assert.match(html, /aria-busy/);
  assert.match(html, /<th scope="col">/);
  assert.ok(!/\bconfirm\(m\)/.test(html), '브라우저 기본 confirm 을 직접 쓰지 않는다');
  // 쓰던 브라우저 기본 확인 창 호출이 화면 코드에 남아 있지 않다(대체 경로의 폴백 제외)
  const own = html.replace(/window\.confirm\(msg\)/g, '');
  assert.ok(!/[^.a-zA-Z]confirm\(/.test(own));
});

test("hidden 속성이 붙은 안내 상자는 화면에 나오지 않는다(display:flex 가 hidden 을 덮어쓰지 않게)", async () => {
  const { baseCss } = await import('../src/views.js').then((m) => ({ baseCss: m.CSS || '' }));
  const src = await (await import('node:fs/promises')).readFile(new URL('../src/views.js', import.meta.url), 'utf8');
  assert.match(src, /\[hidden\]\{display:none!important\}/);
  assert.ok(src.indexOf('[hidden]{display:none!important}') < src.indexOf('.notice{display:flex'));
});
