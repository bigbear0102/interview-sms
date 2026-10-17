// 알바몬 이력서 전체 저장(확장 v1.9): 항목 정리, 에이전트 결과 저장, 이력서만 다시 읽기, 화면, 삭제, 메일 항목 저장
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openSqliteD1 } from '../src/node/d1-sqlite.js';
import { handleRequest } from '../src/worker.js';
import { createSession } from '../src/auth.js';
import { hashPassword } from '../src/crypto.js';
import { createAgentToken, saveParsed, parseAlbamonApply, agentQueue } from '../src/mail-intake.js';
import { normalizeResume, parseResume } from '../src/resume.js';

const RESUME = {
  text: '이력서\n기본정보\n이름\n홍길동\n이메일\nhong@example.com\n경력사항\n아마노코리아 주차관리 2년\n자기소개\n성실하게 일하겠습니다.\n야간 근무도 가능합니다.\n자격증\n운전면허 1종 보통',
  pairs: [['이름', '홍길동'], ['생년월일', '1995.03.04 (31세)'], ['희망근무지', '서울 강남구'], ['근무형태', '알바 / 주말'], ['자격증', '운전면허 1종 보통'], ['병역', '군필']],
  sections: ['기본정보', '경력사항', '자기소개', '자격증'],
  url: 'https://www.albamon.com/resume/1', title: '이력서 보기'
};

async function setup() {
  const db = openSqliteD1(':memory:', fileURLToPath(new URL('../migrations', import.meta.url)));
  const env = { DB: db, ENCRYPTION_KEY: 'k', PUBLIC_BASE_URL: 'https://x.test', GATEWAY_URL: 'https://x/api/3rdparty/v1', NO_REAL_NETWORK: true };
  const mk = async (name, role) => {
    const u = await db.prepare(`INSERT INTO users (username,pass_hash,role,email_verified_at,name,email) VALUES (?,?,?,1,?,?)`).bind(name, await hashPassword('x'), role, name, `${name}@willvi.co.kr`).run();
    const id = Number(u.meta.last_row_id);
    const sid = await createSession(db, id);
    const call = (p, init = {}) => handleRequest(new Request('https://x.test' + p, { ...init, headers: { cookie: `sid=${sid}`, origin: 'https://x.test', ...(init.headers || {}) } }), env, { waitUntil() {} });
    return { id, call, post: (p, f) => call(p, { method: 'POST', body: new URLSearchParams(f).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'manual' }) };
  };
  const boss = await mk('boss', 'super');
  const lee = await mk('lee', 'staff');
  const token = await createAgentToken(db);
  const api = (p, body) => handleRequest(new Request('https://x.test' + p, body ? { method: 'POST', body: JSON.stringify(body), headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' } } : { headers: { authorization: 'Bearer ' + token } }), env, { waitUntil() {} });
  const add = async (apply, name, owner = boss.id) => (await saveParsed(db, { source: 'albamon', applyNo: apply, recruitNo: '1', company: 'c', jobTitle: '주차', name, gender: '남', age: 30, address: '서울', education: '고졸', career: '1년', resumeUrl: `https://www.albamon.com/email-apply-url-route?recruitNo=1&applyNo=${apply}`, fields: { 이름: name, 지원일시: '2026.10.18 10:00', 희망근무지: '강남' } }, Date.now(), owner)).id;
  return { db, env, boss, lee, api, add };
}

test('이력서 정리: 아는 항목, 이메일(글에서), 자기소개 구역, 이상한 값은 버림', () => {
  const r = normalizeResume(RESUME);
  const p = parseResume(r);
  assert.equal(p.birth, '1995.03.04 (31세)');
  assert.equal(p.hopeArea, '서울 강남구');
  assert.equal(p.hopeType, '알바 / 주말');
  assert.equal(p.license, '운전면허 1종 보통');
  assert.equal(p.military, '군필');
  assert.equal(p.email, 'hong@example.com');
  assert.equal(p.intro, '성실하게 일하겠습니다.\n야간 근무도 가능합니다.');
  assert.equal(normalizeResume({ text: '짧음' }), null);
  assert.equal(normalizeResume(null), null);
  assert.equal(normalizeResume({ ...RESUME, text: 'x'.repeat(70000) }).text.length, 60000);
});

test('연락처 가져오기 결과와 함께 이력서 전체 저장 → 새 지원·지원자 화면에 표시', async () => {
  const { db, boss, api, add } = await setup();
  const id = await add('1001', '홍길동');
  await boss.post(`/applicants/inbox/${id}/fetch`, {});
  const r = await (await api(`/api/agent/inbox/${id}/result`, { ok: true, phone: '010-1234-5678', resume: RESUME })).json();
  assert.equal(r.resume, true);
  const row = await db.prepare(`SELECT * FROM applicant_resumes WHERE inbox_id=?`).bind(id).first();
  assert.equal(JSON.parse(row.pairs).length, 6);
  assert.equal(JSON.parse(row.parsed).license, '운전면허 1종 보통');
  // 새 지원 카드 링크 → 저장된 이력서 화면
  assert.match(await (await boss.call('/applicants/inbox')).text(), new RegExp(`/applicants/inbox/${id}/resume`));
  const page = await (await boss.call(`/applicants/inbox/${id}/resume`)).text();
  assert.match(page, /희망 근무지<\/dt><dd>서울 강남구/);
  assert.match(page, /이력서의 모든 항목 \(6\)/);
  assert.match(page, /지원 메일 항목 \(3\)/);            // 메일의 모든 항목도 저장(지원일시 등)
  assert.match(page, /야간 근무도 가능합니다/);
  // 등록하면 지원자 상세에도
  await boss.post(`/applicants/inbox/${id}/register`, { name: '홍길동', phone: '010-1234-5678' });
  const ap = await db.prepare(`SELECT applicant_id FROM applicant_inbox WHERE id=?`).bind(id).first();
  const detail = await (await boss.call(`/applicants/${ap.applicant_id}`)).text();
  assert.match(detail, /알바몬 이력서/);
  assert.match(detail, /자격증<\/dt><dd>운전면허 1종 보통/);
  // 지원자를 지우면 이력서도 지움
  await boss.post(`/applicants/${ap.applicant_id}/delete`, {});
  assert.equal((await db.prepare(`SELECT COUNT(*) n FROM applicant_resumes`).first()).n, 0);
});

test('예전에 연락처만 가져온 사람: 이력서만 다시 읽기(등록된 사람 포함), 연락처·상태는 그대로', async () => {
  const { db, boss, api, add } = await setup();
  const a = await add('2001', '가가');
  const b = await add('2002', '나나');
  const c = await add('2003', '다다');   // 연락처 없음 → 대상 아님
  await db.prepare(`UPDATE applicant_inbox SET phone='01011110001', fetch_state='done' WHERE id=?`).bind(a).run();
  await db.prepare(`UPDATE applicant_inbox SET phone='01011110002', fetch_state='done', status='registered' WHERE id=?`).bind(b).run();
  const inbox = await (await boss.call('/applicants/inbox')).text();
  assert.match(inbox, /이력서 내용이 저장되지 않은 지원자가 2명/);
  const res = await boss.post('/applicants/inbox/resume-all', {});
  assert.equal(res.headers.get('location'), '/applicants/inbox?ok=resumeall&n=2');
  const q = await agentQueue(db, 10, null);
  assert.deepEqual(q.map((x) => [x.id, x.resume_only]), [[c, 0], [a, 1], [b, 1]]);   // 연락처 가져오기(c, 새 메일 자동 요청)가 먼저, 등록된 사람도 이력서만 다시 읽음
  // 결과: 연락처는 비어 있을 때만, 등록 상태는 그대로, 자동 등록 안 함
  await api(`/api/agent/inbox/${b}/result`, { ok: true, phone: '', resume: RESUME });
  const rb = await db.prepare(`SELECT status, phone, fetch_state, resume_only FROM applicant_inbox WHERE id=?`).bind(b).first();
  assert.deepEqual({ ...rb }, { status: 'registered', phone: '01011110002', fetch_state: 'done', resume_only: 0 });
  assert.ok(await db.prepare(`SELECT 1 x FROM applicant_resumes WHERE inbox_id=?`).bind(b).first());
  // 실패해도 연락처 있던 건은 "done" 으로 남고 이유만 기록
  await api(`/api/agent/inbox/${a}/result`, { ok: false, phone: '', note: '이력서를 찾을 수 없어요' });
  const ra = await db.prepare(`SELECT fetch_state, fetch_note, resume_only FROM applicant_inbox WHERE id=?`).bind(a).first();
  assert.deepEqual({ ...ra }, { fetch_state: 'done', fetch_note: '이력서를 찾을 수 없어요', resume_only: 0 });
  void c;
});

test('다른 담당자 새 지원의 이력서는 볼 수 없음, 항목 분석은 관리자만', async () => {
  const { db, boss, lee, api, add } = await setup();
  const id = await add('3001', '라라', boss.id);
  await boss.post(`/applicants/inbox/${id}/fetch`, {});
  await api(`/api/agent/inbox/${id}/result`, { ok: true, phone: '01033330001', resume: RESUME });
  assert.equal((await lee.call(`/applicants/inbox/${id}/resume`)).status, 404);
  assert.equal((await lee.call('/applicants/resume-fields')).status, 403);
  const page = await (await boss.call('/applicants/resume-fields')).text();
  assert.match(page, /이력서 저장 1건/);
  assert.match(page, /희망근무지<\/td><td>1/);
  assert.match(page, /지원일시<\/td><td>1/);
  void db;
});

test('지원 메일의 모든 항목을 함께 해석', () => {
  const html = `<table><tr><th>이름</th><td>홍길동(여, 32세)</td></tr><tr><th>지원일시</th><td>2026.10.18</td></tr><tr><th>희망근무지</th><td>강남</td></tr></table>
    <a href="https://www.albamon.com/email-apply-url-route?recruitNo=1&amp;applyNo=55">이력서 보기</a>`;
  const p = parseAlbamonApply(html);
  assert.deepEqual(p.fields, { 이름: '홍길동(여, 32세)', 지원일시: '2026.10.18', 희망근무지: '강남' });
});

test('새 지원 메일: 들어오자마자 연락처+이력서 가져오기 요청, 이력서만 읽기는 v1.9.1 이상 확장에만', async () => {
  const { db, boss, env, add } = await setup();
  const id = await add('4001', '자동읽기');
  const row = await db.prepare(`SELECT fetch_state, resume_only FROM applicant_inbox WHERE id=?`).bind(id).first();
  assert.deepEqual({ ...row }, { fetch_state: 'requested', resume_only: 0 });
  const token = await (await import('../src/mail-intake.js')).createAgentToken(db, boss.id);
  const list = (ver) => handleRequest(new Request('https://x.test/api/agent/inbox', { headers: { authorization: 'Bearer ' + token, ...(ver ? { 'x-ext-version': ver } : {}) } }), env, { waitUntil() {} }).then((r) => r.json());
  assert.deepEqual((await list('')).items.map((x) => x.id), [id]);           // 연락처 가져오기는 예전 확장도 처리
  // 연락처가 이미 있는 사람의 이력서만 읽기: 예전 확장(버전 없음·1.9.0)에는 주지 않음
  await db.prepare(`UPDATE applicant_inbox SET phone='01044440001', fetch_state='requested', resume_only=1, fetch_at=NULL WHERE id=?`).bind(id).run();
  assert.deepEqual((await list('')).items, []);
  assert.deepEqual((await list('1.9.0')).items, []);
  assert.deepEqual((await list('1.9.1')).items.map((x) => [x.id, x.resume_only]), [[id, 1]]);
  await db.prepare(`UPDATE applicant_inbox SET fetch_at=NULL`).run();
  assert.deepEqual((await list('2.0.0')).items.map((x) => x.id), [id]);
  // 연락처 없이 이력서만 읽는 중인 건(예전 버전 데이터)에 연락처 가져오기를 누르면 연락처 요청으로 바뀜
  await db.prepare(`UPDATE applicant_inbox SET phone='', resume_only=1, fetch_at=NULL WHERE id=?`).bind(id).run();
  const page = await (await boss.call('/applicants/inbox')).text();
  assert.match(page, /이력서 읽는 중/);
  await boss.post(`/applicants/inbox/${id}/fetch`, {});
  const r2 = await db.prepare(`SELECT fetch_state, resume_only FROM applicant_inbox WHERE id=?`).bind(id).first();
  assert.deepEqual({ ...r2 }, { fetch_state: 'requested', resume_only: 0 });
});
