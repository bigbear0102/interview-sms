import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openSqliteD1 } from '../src/node/d1-sqlite.js';
import { handleRequest } from '../src/worker.js';
import { createSession } from '../src/auth.js';
import { hashPassword } from '../src/crypto.js';
import { applicantsFromText } from '../src/applicants.js';

const visible = (html) => html.replace(/<(style|script)[\s\S]*?<\/\1>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

async function setup() {
  const db = openSqliteD1(':memory:', fileURLToPath(new URL('../migrations', import.meta.url)));
  const env = { DB: db, ENCRYPTION_KEY: 'k', PUBLIC_BASE_URL: 'https://example.test', GATEWAY_URL: 'https://sms.example.test/api/3rdparty/v1', GATEWAY_PRIVATE_TOKEN: 't' };
  const ctx = { waitUntil() {} };
  const mk = async (username, role, name) => {
    const u = await db.prepare(`INSERT INTO users (username,pass_hash,role,email_verified_at,name,email) VALUES (?,?,?,1,?,?)`)
      .bind(username, await hashPassword('password123'), role, name, `${username}@willvi.co.kr`).run();
    return createSession(db, Number(u.meta.last_row_id));
  };
  const sidAdmin = await mk('boss', 'super', '김관리');
  const sidUser = await mk('staff', 'user', '이직원');
  const as = (sid) => {
    const call = (path, init = {}) => handleRequest(new Request('https://example.test' + path, {
      ...init, headers: { cookie: `sid=${sid}`, origin: 'https://example.test', ...(init.headers || {}) }
    }), env, ctx);
    const post = (path, fields) => call(path, { method: 'POST', body: new URLSearchParams(fields).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    return { call, post };
  };
  return { db, admin: as(sidAdmin), staff: as(sidUser) };
}

test('붙여넣기 해석: 제목 줄 있음/없음', () => {
  const a = applicantsFromText('이름\t전화번호\t지원한 곳\t직무\n홍길동\t010-1234-5678\t아마노코리아(현장HR)\t현장 관리');
  assert.deepEqual(a.rows[0], { name: '홍길동', phone: '010-1234-5678', applied_to: '아마노코리아(현장HR)', job: '현장 관리' });
  const b = applicantsFromText('김영희\t010-2345-6789\t아마노코리아(현장HR)\t물류\n박민수\t01034567890\t아마노코리아(현장HR)\t물류');
  assert.equal(b.errors.length, 0);
  assert.equal(b.rows.length, 2);
  assert.equal(b.rows[0].name, '김영희');
  assert.equal(b.rows[0].job, '물류');
  const c = applicantsFromText('가\t나\n다\t라');
  assert.match(c.errors[0], /전화번호/);
});

test('지원자 등록, 검색, 상세, 같은 번호는 한 사람으로 합침', async () => {
  const { admin } = await setup();
  let r = await admin.post('/applicants/new', { name: '홍길동', phone: '010-1234-5678', applied_to: '아마노코리아(현장HR)', job: '현장 관리' });
  assert.equal(r.status, 303);
  const loc = r.headers.get('location');
  assert.match(loc, /^\/applicants\/\d+$/);
  // 같은 번호로 다시 등록하면 지원 건만 추가
  r = await admin.post('/applicants/new', { name: '홍길동', phone: '01012345678', applied_to: '다른회사', job: '경비' });
  assert.equal(r.headers.get('location'), loc);
  const detail = visible(await (await admin.call(loc)).text());
  assert.ok(detail.includes('아마노코리아(현장HR)'));
  assert.ok(detail.includes('다른회사'));
  const list = visible(await (await admin.call('/applicants')).text());
  assert.ok(list.includes('홍길동'));
  assert.ok(list.includes('외 1건'));
  const byJob = visible(await (await admin.call('/applicants?q=' + encodeURIComponent('경비'))).text());
  assert.ok(byJob.includes('홍길동'));
  const none = visible(await (await admin.call('/applicants?q=' + encodeURIComponent('없는사람'))).text());
  assert.ok(none.includes('찾는 지원자가 없어요'));
  // 잘못된 번호
  const bad = await admin.post('/applicants/new', { name: '가', phone: '123', applied_to: '', job: '' });
  assert.equal(bad.status, 400);
});

test('여러 명 붙여넣기 등록(제목 줄 없음) + 이미 있는 사람은 지원 건만 반영', async () => {
  const { admin, db } = await setup();
  const text = '홍길동\t010-1234-5678\tA사\t현장\n김영희\t010-2345-6789\tA사\t물류\n오류\t12345\tA사\t물류\n';
  const res = await admin.post('/applicants/bulk', { text });
  assert.equal(res.status, 200);
  const html = visible(await res.text());
  assert.ok(html.includes('2명을 새로 등록했어요'));
  assert.ok(html.includes('1건은 등록하지 못했어요'));
  const again = await admin.post('/applicants/bulk', { text: '홍길동\t010-1234-5678\tB사\t경비\n' });
  assert.ok(visible(await again.text()).includes('이미 있던 1명'));
  const n = await db.prepare(`SELECT COUNT(*) n FROM applicants`).first();
  assert.equal(n.n, 2);
  const apps = await db.prepare(`SELECT COUNT(*) n FROM applicant_applications`).first();
  assert.equal(apps.n, 3); // 홍길동 2건 + 김영희 1건
});

test('블랙리스트: 기타는 사유 필수, 등록 → 목록 표시 → 수동 해제 → 기록', async () => {
  const { admin, staff } = await setup(); // 권한은 아직 제한하지 않으므로 일반 사용자도 사용 가능
  const r = await staff.post('/applicants/new', { name: '홍길동', phone: '010-1234-5678', applied_to: 'A사', job: '현장' });
  const loc = r.headers.get('location');
  // 기타 + 사유 없음 → 거절
  const noText = await staff.post(loc + '/blacklist', { reason_code: 'other', reason_text: '' });
  assert.equal(noText.status, 400);
  // 정해진 사유로 등록
  const ok = await staff.post(loc + '/blacklist', { reason_code: 'noshow', reason_text: '10/20 연락 없이 불참' });
  assert.equal(ok.status, 303);
  let detail = visible(await (await admin.call(loc)).text());
  assert.ok(detail.includes('블랙리스트에 등록되어 있어요'));
  assert.ok(detail.includes('면접 무단 불참'));
  let list = visible(await (await admin.call('/applicants?status=bl')).text());
  assert.ok(list.includes('홍길동'));
  // 같은 사람을 다시 등록해도 중복 생성 안 됨
  await staff.post(loc + '/blacklist', { reason_code: 'noshow', reason_text: '' });
  // 해제
  const rel = await admin.post(loc + '/release', { note: '본인 확인 후 해제' });
  assert.equal(rel.status, 303);
  detail = visible(await (await admin.call(loc)).text());
  assert.ok(!detail.includes('블랙리스트에 등록되어 있어요'));
  assert.ok(detail.includes('이전 블랙리스트 기록'));
  assert.ok(detail.includes('블랙리스트 해제'));
  list = visible(await (await admin.call('/applicants?status=bl')).text());
  assert.ok(list.includes('찾는 지원자가 없어요'));
  // 해제 후 다른 사유로 다시 등록 가능, 기타 + 사유 있음
  const again = await admin.post(loc + '/blacklist', { reason_code: 'other', reason_text: '현장에서 폭언' });
  assert.equal(again.status, 303);
  assert.ok(visible(await (await admin.call(loc)).text()).includes('기타: 현장에서 폭언'));
});

test('삭제는 관리자만, 내보내기, 메뉴 노출', async () => {
  const { admin, staff, db } = await setup();
  const r = await admin.post('/applicants/new', { name: '홍길동', phone: '010-1234-5678', applied_to: 'A사', job: '현장' });
  const loc = r.headers.get('location');
  const denied = await staff.post(loc + '/delete', {});
  assert.equal(denied.status, 403);
  const csv = await (await staff.call('/applicants/export.csv')).text();
  assert.ok(csv.includes('홍길동'));
  assert.ok(csv.includes('01012345678'));
  const home = await (await staff.call('/')).text();
  assert.ok(home.includes('href="/applicants"'));
  const del = await admin.post(loc + '/delete', {});
  assert.equal(del.status, 303);
  const n = await db.prepare(`SELECT COUNT(*) n FROM applicants`).first();
  assert.equal(n.n, 0);
  const gone = await admin.call(loc);
  assert.equal(gone.status, 404);
});

test('한 화면 표: 입력 줄 추가, 표에서 바로 수정, 블랙리스트 등록·해제, 기록 조각, CSV 양식', async () => {
  const { admin, db } = await setup();
  const back = '/applicants';
  // 입력 줄에서 추가 → 같은 화면으로 돌아오고 안내가 보인다
  let r = await admin.post('/applicants/new', { back, name: '홍길동', phone: '010-1234-5678', applied_to: 'A사', job: '현장' });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/applicants?ok=added');
  let page = await (await admin.call('/applicants?ok=added')).text();
  assert.ok(visible(page).includes('지원자를 등록했어요'));
  assert.ok(visible(page).includes('홍길동'));
  assert.match(page, /id="addform"/);       // 입력 줄
  assert.match(page, /id="csvfile"/);       // CSV 파일 올리기
  assert.match(page, /js-edit/);            // 표에서 수정 버튼
  const row = await db.prepare(`SELECT id FROM applicants`).first();
  const id = row.id;
  // 번호가 잘못되면 같은 화면에 오류 안내
  r = await admin.post('/applicants/new', { back, name: '가', phone: '1', applied_to: '', job: '' });
  assert.equal(r.headers.get('location'), '/applicants?err=invalid');
  assert.ok(visible(await (await admin.call('/applicants?err=invalid')).text()).includes('휴대폰 번호를 확인'));
  // 표에서 바로 수정: 이름·번호·지원한 곳·직무 (가장 최근 지원 건에 반영)
  r = await admin.post(`/applicants/${id}/edit`, { back, name: '홍길순', phone: '010-9999-0000', applied_to: 'B사', job: '경비' });
  assert.equal(r.headers.get('location'), '/applicants?ok=edited');
  const p = await db.prepare(`SELECT name, phone FROM applicants WHERE id=?`).bind(id).first();
  assert.equal(p.name, '홍길순');
  assert.equal(p.phone, '01099990000');
  const app = await db.prepare(`SELECT applied_to, job FROM applicant_applications WHERE applicant_id=?`).bind(id).all();
  assert.equal(app.results.length, 1);
  assert.deepEqual({ ...app.results[0] }, { applied_to: 'B사', job: '경비' });
  // 같은 화면에서 블랙리스트 등록(기타는 사유 필수)
  r = await admin.post(`/applicants/${id}/blacklist`, { back, reason_code: 'other', reason_text: '' });
  assert.equal(r.headers.get('location'), '/applicants?err=reason');
  r = await admin.post(`/applicants/${id}/blacklist`, { back, reason_code: 'noshow', reason_text: '10/20 불참' });
  assert.equal(r.headers.get('location'), '/applicants?ok=blacklisted');
  page = visible(await (await admin.call('/applicants')).text());
  assert.ok(page.includes('블랙리스트'));
  assert.ok(page.includes('면접 무단 불참'));
  // 기록 조각
  const panel = await (await admin.call(`/applicants/${id}/panel`)).text();
  assert.ok(panel.includes('B사'));
  assert.ok(panel.includes('블랙리스트 등록'));
  assert.ok(!panel.includes('<html'));      // 조각만 돌려준다
  assert.equal((await admin.call('/applicants/9999/panel')).status, 404);
  // 해제
  r = await admin.post(`/applicants/${id}/release`, { back, note: '확인' });
  assert.equal(r.headers.get('location'), '/applicants?ok=released');
  // 바깥 주소로 되돌아가려는 시도는 무시한다
  r = await admin.post(`/applicants/${id}/edit`, { back: 'https://evil.example/', name: '홍길순', phone: '010-9999-0000' });
  assert.equal(r.headers.get('location'), `/applicants/${id}`);
  // CSV 양식
  const tpl = await (await admin.call('/applicants/template.csv')).text();
  assert.ok(tpl.includes('이름,전화번호,지원한 곳,직무'));
  // CSV 파일 내용(쉼표)도 등록된다
  const csv = '이름,전화번호,지원한 곳,직무\n김영희,010-2345-6789,A사,물류\n';
  const res = await admin.post('/applicants/bulk', { back, text: csv });
  assert.equal(res.status, 200);
  assert.ok(visible(await res.text()).includes('1명을 새로 등록했어요'));
});
