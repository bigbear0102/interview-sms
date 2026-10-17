// 지원자 별점(담당자마다 1~5점)과 "AI로 지원자 찾기". 가짜 AI 만 쓴다(실제 접속 없음).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openSqliteD1 } from '../src/node/d1-sqlite.js';
import { handleRequest } from '../src/worker.js';
import { createSession } from '../src/auth.js';
import { hashPassword } from '../src/crypto.js';
import { saveApplicant, mergeApplicants } from '../src/applicants.js';
import { plainFilters, cleanFilters, searchApplicants, ageGenderOf } from '../src/applicant-ask.js';

async function setup(aiAnswer) {
  const db = openSqliteD1(':memory:', fileURLToPath(new URL('../migrations', import.meta.url)));
  const sent = [];
  const AI_FETCH = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push(body.messages[1].content);
    return aiAnswer === 'fail' ? new Response('x', { status: 503 }) : Response.json({ choices: [{ message: { content: JSON.stringify(aiAnswer) } }] });
  };
  const env = { DB: db, ENCRYPTION_KEY: 'k', NO_REAL_NETWORK: true, ...(aiAnswer !== undefined ? { NVIDIA_API_KEY: 'k', AI_FETCH } : {}) };
  const users = {};
  for (const [u, name, role] of [['boss', '김관리', 'super'], ['lee', '이담당', 'staff']]) {
    const r = await db.prepare(`INSERT INTO users (username,pass_hash,role,email_verified_at,name,email) VALUES (?,?,?,1,?,?)`).bind(u, await hashPassword('password123'), role, name, `${u}@willvi.co.kr`).run();
    const id = Number(r.meta.last_row_id);
    const sid = await createSession(db, id);
    const call = (path, init = {}) => handleRequest(new Request('https://example.test' + path, { ...init, headers: { cookie: `sid=${sid}`, origin: 'https://example.test', ...(init.headers || {}) } }), env, { waitUntil() {} });
    const post = (path, fields) => call(path, { method: 'POST', body: new URLSearchParams(fields).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });
    users[u] = { id, call, post };
  }
  const add = async (name, phone, applied_to, job, posting_title = '') => (await saveApplicant(db, { name, phone, applied_to, job, posting_title }, 1)).id;
  return { db, env, users, add, sent };
}
const stars = (db, id) => db.prepare(`SELECT user_id, stars FROM applicant_ratings WHERE applicant_id=? ORDER BY user_id`).bind(id).all().then((r) => r.results.map((x) => ({ ...x })));

test('별점: 담당자마다 하나, 바꾸기·지우기, 변경 기록, 상세에 담당자별 표시', async () => {
  const { db, users, add } = await setup();
  const id = await add('홍길동', '01011112222', '효성안양공장(도급)', '사무');
  let r = await users.boss.post(`/applicants/${id}/rate`, { stars: '4' });
  assert.equal(r.status, 303);
  await users.lee.post(`/applicants/${id}/rate`, { stars: '5' });
  await users.boss.post(`/applicants/${id}/rate`, { stars: '3' });   // 바꾸기
  assert.deepEqual(await stars(db, id), [{ user_id: 1, stars: 3 }, { user_id: 2, stars: 5 }]);
  await users.boss.post(`/applicants/${id}/rate`, { stars: '9' });   // 잘못된 값은 무시
  assert.deepEqual(await stars(db, id), [{ user_id: 1, stars: 3 }, { user_id: 2, stars: 5 }]);
  const page = await (await users.boss.call(`/applicants/${id}`)).text();
  assert.match(page, /평균 <b[^>]*>4점<\/b> · 담당자 2명/);
  assert.match(page, /김관리<\/span><span class="st" aria-label="3점">★★★☆☆/);
  assert.match(page, /이담당<\/span><span class="st" aria-label="5점">★★★★★/);
  assert.match(page, /별점 3점 \(전: 4점\)/);   // 변경 기록
  await users.boss.post(`/applicants/${id}/rate`, { stars: '0' });   // 지우기
  assert.deepEqual(await stars(db, id), [{ user_id: 2, stars: 5 }]);
});

test('별점: 목록에 평균 표시, 별점 높은순 정렬, 합치면 별점도 옮김', async () => {
  const { db, users, add } = await setup();
  const a = await add('가가', '01011110001', 'A', '');
  const b = await add('나나', '01011110002', 'A', '');
  await users.boss.post(`/applicants/${a}/rate`, { stars: '2' });
  await users.boss.post(`/applicants/${b}/rate`, { stars: '5' });
  const list = await (await users.boss.call('/applicants?sort=stars')).text();
  assert.ok(list.indexOf('나나') < list.indexOf('가가'), '별점 높은 사람이 먼저');
  assert.match(list, /별점 평균 5점, 1명/);
  // 합치기: 같은 담당자의 별점은 남기는 쪽(target) 것을 유지, 다른 담당자 것은 옮김
  await users.lee.post(`/applicants/${b}/rate`, { stars: '4' });
  await mergeApplicants(db, a, b, 1);
  assert.deepEqual(await stars(db, a), [{ user_id: 1, stars: 2 }, { user_id: 2, stars: 4 }]);
  assert.deepEqual(await stars(db, b), []);
});

test('AI 찾기: 문장 → 조건(AI 에는 문장만), 별점 높은 순, 블랙리스트 제외, 받은 지원 메일 주소도 검색', async () => {
  const { db, users, add, sent } = await setup({ areas: ['안양'], jobs: ['사무'], keywords: [], minStars: null, includeBlacklist: false, limit: null, ignored: [] });
  const p1 = await add('일번', '01020000001', '효성안양공장(도급)', '사무보조');
  const p2 = await add('이번', '01020000002', '효성안양공장(도급)', '사무');
  const p3 = await add('삼번', '01020000003', '강남점', '사무');                  // 지역 안 맞음
  const p4 = await add('사번', '01020000004', '본사', '사무', '');                // 주소가 안양(받은 지원 메일)
  const p5 = await add('오번', '01020000005', '효성안양공장(도급)', '사무');       // 블랙리스트
  await db.prepare(`INSERT INTO applicant_inbox (source, apply_no, recruit_no, company, job_title, name, address, received_at, status, phone) VALUES ('albamon','9','9','윌앤비전','사무 보조','사번','경기 안양시 동안구',1,'done','01020000004')`).run();
  await db.prepare(`INSERT INTO blacklist (applicant_id, reason_code, created_at) VALUES (?, 'noshow', 1)`).bind(p5).run();
  await users.boss.post(`/applicants/${p2}/rate`, { stars: '5' });
  await users.lee.post(`/applicants/${p2}/rate`, { stars: '4' });
  await users.boss.post(`/applicants/${p1}/rate`, { stars: '3' });
  const page = await (await users.boss.call('/applicants/ask?q=' + encodeURIComponent('안양 사무 추천해줘'))).text();
  assert.match(page, /지역·현장 <b>안양<\/b> · 직무 <b>사무<\/b>/);
  assert.match(page, /<b>3명<\/b>/);
  const order = ['이번', '일번', '사번'].map((n) => page.indexOf(`<b>${n}</b>`));
  assert.ok(order.every((x) => x > 0) && order[0] < order[1] && order[1] < order[2], '별점 높은 순(별점 없는 사람은 뒤)');
  assert.ok(!page.includes('<b>삼번</b>') && !page.includes('<b>오번</b>'));
  assert.equal(sent.length, 1);
  assert.equal(sent[0], '문장: 안양 사무 추천해줘');   // 지원자 정보는 AI 에 보내지 않음
  const log = await db.prepare(`SELECT detail FROM audit WHERE action='applicant.ask'`).first();
  assert.equal(log.detail, 'by=ai found=3');           // 검색 문장은 남기지 않음
  void p3;
});

test('AI 찾기: 나이·성별로 거르기(원문에서 직접 읽음), 결혼·임신은 정보가 없다고 알려 줌', async () => {
  assert.deepEqual(ageGenderOf('안양 20대 여자'), { ageMin: 20, ageMax: 29, gender: '여' });
  assert.deepEqual(ageGenderOf('30세 이상 남성'), { ageMin: 30, ageMax: null, gender: '남' });
  assert.deepEqual(ageGenderOf('25살 이하'), { ageMin: null, ageMax: 25, gender: null });
  assert.deepEqual(ageGenderOf('20대 후반 성인만'), { ageMin: 27, ageMax: 29, gender: null });
  assert.deepEqual(ageGenderOf('대학교 졸업'), { ageMin: null, ageMax: null, gender: null });
  // AI 가 나이를 검색어로 넣어도 코드가 조건으로 바꿈
  const f = cleanFilters({ areas: ['안양'], jobs: ['사무', '여자'], keywords: ['20대'], ignored: [] }, '안양 사무 20대 여자 기혼 추천');
  assert.deepEqual([f.jobs, f.keywords, f.ageMin, f.ageMax, f.gender], [['사무'], [], 20, 29, '여']);
  assert.deepEqual(f.ignored, ['기혼']);
  const { db, users, add } = await setup({ areas: ['안양'], jobs: [], gender: null, ignored: [] });
  await add('일번', '01020000001', '효성안양공장(도급)', '사무');
  await add('이번', '01020000002', '효성안양공장(도급)', '사무');
  await add('삼번', '01020000003', '효성안양공장(도급)', '사무');   // 나이·성별 정보 없음
  const ins = `INSERT INTO applicant_inbox (source, apply_no, recruit_no, company, job_title, name, gender, age, received_at, status, phone) VALUES ('albamon',?,'1','c','t',?,?,?,1,'done',?)`;
  await db.prepare(ins).bind('1', '일번', '여', 24, '01020000001').run();
  await db.prepare(ins).bind('2', '이번', '남', 27, '01020000002').run();
  const page = await (await users.boss.call('/applicants/ask?q=' + encodeURIComponent('안양 20대 여자 추천'))).text();
  assert.match(page, /나이 <b>20~29세<\/b> · 성별 <b>여<\/b>/);
  assert.ok(page.includes('<b>일번</b>') && !page.includes('<b>이번</b>') && !page.includes('<b>삼번</b>'));
  assert.match(page, /010-2000-0001 · 여 24세/);
  assert.match(page, /나이·성별 정보가 있는 지원자만 보여요/);
  const p2 = await (await users.boss.call('/applicants/ask?q=' + encodeURIComponent('안양 기혼'))).text();
  assert.match(p2, /<b>기혼<\/b> 조건은 시스템에 정보가 없어서 거르지 못했어요/);
});

test('AI 찾기: AI 가 없거나 실패하면 낱말로 찾음, 블랙리스트는 말하면 포함', async () => {
  assert.deepEqual(plainFilters('안양 사무 추천해줘').keywords, ['안양', '사무']);
  assert.deepEqual([plainFilters('30대 남자 안양').ageMin, plainFilters('30대 남자 안양').gender, plainFilters('30대 남자 안양').keywords], [30, '남', ['안양']]);
  const { users, add } = await setup('fail');
  await add('일번', '01020000001', '효성안양공장(도급)', '사무');
  await add('이번', '01020000002', '효성안양공장(도급)', '주차');
  const page = await (await users.boss.call('/applicants/ask?q=' + encodeURIComponent('안양 사무'))).text();
  assert.match(page, /AI가 응답하지 않아 입력한 낱말로 찾았어요/);
  assert.ok(page.includes('<b>일번</b>') && !page.includes('<b>이번</b>'));
  const none = await setup();
  assert.doesNotMatch(await (await none.users.boss.call('/applicants/ask')).text(), /오류/);
});

test('AI 찾기: 학력·경력도 검색, 성인만(19세 이상), 외모·국적 같은 말은 검색어로', async () => {
  const { db, add } = await setup();
  const a = await add('일번', '01020000001', '안양A', '사무');
  const b = await add('이번', '01020000002', '안양B', '사무');
  const ins = `INSERT INTO applicant_inbox (source, apply_no, recruit_no, company, job_title, name, age, education, career, received_at, status, phone) VALUES ('albamon',?,'1','c','t',?,?,?,?,1,'done',?)`;
  await db.prepare(ins).bind('1', '일번', 17, '고등학교 재학', '신입', '01020000001').run();
  await db.prepare(ins).bind('2', '이번', 25, '대학교 졸업', '경력 3년', '01020000002').run();
  const base = { areas: [], jobs: [], keywords: [], minStars: null, includeBlacklist: false, ageMin: null, ageMax: null, gender: null, limit: null, ignored: [] };
  assert.deepEqual((await searchApplicants(db, { ...base, keywords: ['대학교'] })).rows.map((r) => r.name), ['이번']);
  assert.deepEqual((await searchApplicants(db, { ...base, keywords: ['경력'] })).rows.map((r) => r.name), ['이번']);
  assert.deepEqual((await searchApplicants(db, { ...base, areas: ['안양'], ageMin: 19 })).rows.map((r) => r.name), ['이번']);
  assert.equal((await searchApplicants(db, { ...base, ageMin: 19 })).total, 1);   // 나이 조건 하나로도 찾음
  const f = cleanFilters({ keywords: ['외국인', '대졸'], ignored: [] }, '외국인 대졸 성인만');
  assert.deepEqual(f.keywords, ['외국인', '대졸']);
  assert.equal(f.ageMin, 19);
  assert.deepEqual(f.ignored, []);
  assert.equal(plainFilters('강남 물류 성인만').ageMin, 19);
  assert.deepEqual(plainFilters('강남 물류 30대 남자').keywords, ['강남', '물류']);
  assert.deepEqual(plainFilters('아마노 블랙리스트 포함').keywords, ['아마노']);
  assert.equal(plainFilters('아마노 블랙리스트 포함').includeBlacklist, true);
  assert.equal(cleanFilters({ limit: 80 }, 'x').limit, 80);
  void a; void b;
});

test('AI 찾기: 별점 기준·인원수, 아무 조건도 없으면 다시 물어봄', async () => {
  const { db, add } = await setup();
  const a = await add('일번', '01020000001', '안양A', '사무');
  const b = await add('이번', '01020000002', '안양B', '사무');
  await db.prepare(`INSERT INTO applicant_ratings VALUES (?,1,5,1),(?,1,3,1)`).bind(a, b).run();
  const r = await searchApplicants(db, { areas: ['안양'], jobs: [], keywords: [], minStars: 4, includeBlacklist: false, ageMin: null, ageMax: null, gender: null, limit: 1, ignored: [] });
  assert.equal(r.total, 1);
  assert.equal(r.rows[0].name, '일번');
  assert.deepEqual(await searchApplicants(db, { areas: [], jobs: [], keywords: [], minStars: null, includeBlacklist: false, ageMin: null, ageMax: null, gender: null, limit: null, ignored: [] }), { rows: [], total: 0 });
});

test('검색창 하나: 낱말 두 개 이상이면 조건 찾기로, 이름·번호는 그대로', async () => {
  const { users } = await setup();
  const r = await users.boss.call('/applicants?q=' + encodeURIComponent('안양 사무 20대'), { redirect: 'manual' });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/applicants/ask?q=' + encodeURIComponent('안양 사무 20대'));
  assert.equal((await users.boss.call('/applicants?q=' + encodeURIComponent('홍길동'), { redirect: 'manual' })).status, 200);
  assert.equal((await users.boss.call('/applicants?q=' + encodeURIComponent('010 1234 5678'), { redirect: 'manual' })).status, 200);
});

test('오늘 면접에서 바로 별점: 지원자로 등록된 사람만, 누르면 오늘 면접으로 돌아옴', async () => {
  const { db, users, add } = await setup();
  const a = await add('면접생', '01020009999', 'A', '주차');
  await db.prepare(`INSERT INTO departments (name) VALUES ('인사팀')`).run();
  await db.prepare(`INSERT INTO gateways (department_id,name,username,password,hook_token) VALUES (1,'폰','u','p','t')`).run();
  const d = new Date(Date.now() + 9 * 3600e3); const md = `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  const day = d.toISOString().slice(0, 10);
  await db.prepare(`INSERT INTO campaigns (department_id,gateway_id,name,template,created_at,status) VALUES (1,1,'안내','x',?,'done')`).bind(Date.now()).run();
  await db.prepare(`INSERT INTO candidates (campaign_id,site,name,phone,status,interview_at,sent_at) VALUES (1,'A','면접생','01020009999','attending',?,?),(1,'A','미등록','01020008888','attending',?,?)`).bind(`${md} 15:00`, Date.now(), `${md} 16:00`, Date.now()).run();
  let page = await (await users.boss.call('/interviews/today')).text();
  assert.match(page, new RegExp(`action="/applicants/${a}/rate" class="tstars"`));
  assert.equal((page.match(/class="tstars"/g) || []).length, 1);   // 미등록 사람은 별점 없음
  const r = await users.boss.post(`/applicants/${a}/rate`, { stars: '4', back: `/interviews/today?d=${day}` });
  assert.equal(r.headers.get('location'), `/interviews/today?d=${day}&ok=rated`);
  page = await (await users.boss.call(`/interviews/today?d=${day}`)).text();
  assert.equal((page.match(/class="starbtn on"/g) || []).length, 4);
});
