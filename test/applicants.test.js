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
  assert.deepEqual(a.rows[0], { line: 2, name: '홍길동', phone: '010-1234-5678', applied_to: '아마노코리아(현장HR)', job: '현장 관리', blacklist: '', reason: '', reason_text: '' });
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
  assert.ok(visible(list).includes('지원 2건'));
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
  assert.ok(detail.includes('블랙리스트') && detail.includes('사유'));
  assert.ok(detail.includes('면접 무단 불참'));
  let list = visible(await (await admin.call('/applicants?status=bl')).text());
  assert.ok(list.includes('홍길동'));
  // 같은 사람을 다시 등록해도 중복 생성 안 됨
  await staff.post(loc + '/blacklist', { reason_code: 'noshow', reason_text: '' });
  // 해제
  const rel = await admin.post(loc + '/release', { note: '본인 확인 후 해제' });
  assert.equal(rel.status, 303);
  detail = visible(await (await admin.call(loc)).text());
  assert.ok(detail.includes('일반 지원자'));
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
  assert.match(page, /id="dlg-add"/);       // 추가 대화 창
  assert.match(page, /id="csvfile"/);       // CSV 파일 올리기
  assert.match(page, /data-href="\/applicants\/\d+"/);   // 행을 누르면 상세로
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

import { interpretBlacklist } from '../src/applicants.js';

test('업로드 해석: 블랙리스트 여부와 사유', () => {
  assert.deepEqual(interpretBlacklist({ blacklist: 'Y', reason: '면접 무단 불참', reason_text: '10/20' }), { bl: true, code: 'noshow', text: '10/20' });
  assert.deepEqual(interpretBlacklist({ blacklist: '예', reason: '노쇼', reason_text: '' }), { bl: true, code: 'noshow', text: '' });
  assert.equal(interpretBlacklist({ blacklist: 'Y', reason: '근무 중 무단 이탈' }).code, 'absent');
  assert.equal(interpretBlacklist({ blacklist: '블랙리스트', reason: '서류 허위' }).code, 'false_info');
  assert.equal(interpretBlacklist({ blacklist: 'O', reason: 'misconduct' }).code, 'misconduct');
  // 알 수 없는 사유 → 기타 + 그 말을 설명으로
  assert.deepEqual(interpretBlacklist({ blacklist: 'Y', reason: '무단 퇴실 반복', reason_text: '' }), { bl: true, code: 'other', text: '무단 퇴실 반복' });
  // 여부 칸이 비어 있어도 사유가 있으면 등록
  assert.equal(interpretBlacklist({ blacklist: '', reason: '면접 무단 불참' }).bl, true);
  // 아니오 / 일반 / 비어 있음
  assert.equal(interpretBlacklist({ blacklist: 'N', reason: '면접 무단 불참' }).bl, false);
  assert.equal(interpretBlacklist({ blacklist: '', reason: '' }).bl, false);
  // 사유 없음, 기타인데 설명 없음 → 경고
  assert.match(interpretBlacklist({ blacklist: 'Y', reason: '' }).warn, /사유가 없어서/);
  assert.match(interpretBlacklist({ blacklist: 'Y', reason: '기타', reason_text: '' }).warn, /사유 설명/);
  assert.match(interpretBlacklist({ blacklist: '글쎄', reason: '' }).warn, /알 수 없어서/);
});

test('업로드로 블랙리스트까지 한 번에 등록: 제목 줄 있는 CSV와 제목 줄 없는 붙여넣기', async () => {
  const { admin, db } = await setup();
  const csv = [
    '이름,전화번호,지원한 곳,직무,블랙리스트,사유,사유 설명',
    '홍길동,010-1111-0001,A사,현장,,,',
    '김영희,010-1111-0002,A사,물류,Y,면접 무단 불참,10/20 불참',
    '이철수,010-1111-0003,A사,경비,Y,,',
    '박민수,010-1111-0004,A사,경비,N,면접 무단 불참,',
    '최수아,010-1111-0005,A사,경비,Y,기타,'
  ].join('\n');
  const res = await admin.post('/applicants/bulk', { back: '/applicants', text: csv });
  assert.equal(res.status, 200);
  const html = visible(await res.text());
  assert.ok(html.includes('5명을 새로 등록했어요'));
  assert.ok(html.includes('블랙리스트 1명을 등록했어요'));
  assert.ok(html.includes('확인해 주세요 (2건)'));
  assert.ok(html.includes('4번째 줄'));  // 이철수: 사유 없음
  assert.ok(html.includes('6번째 줄'));  // 최수아: 기타인데 설명 없음
  const bl = await db.prepare(`SELECT a.name, b.reason_code, b.reason_text FROM blacklist b JOIN applicants a ON a.id=b.applicant_id WHERE b.status='active'`).all();
  assert.equal(bl.results.length, 1);
  assert.equal(bl.results[0].name, '김영희');
  assert.equal(bl.results[0].reason_code, 'noshow');
  assert.equal(bl.results[0].reason_text, '10/20 불참');
  // 변경 기록에 남는다
  const ev = await db.prepare(`SELECT detail FROM applicant_events WHERE action='blacklist'`).all();
  assert.equal(ev.results.length, 1);
  assert.match(ev.results[0].detail, /면접 무단 불참/);
  // 이미 블랙리스트인 사람을 다시 올리면 중복 등록하지 않는다
  const again = await admin.post('/applicants/bulk', { back: '/applicants', text: '김영희\t010-1111-0002\tB사\t경비\tY\t근무 중 무단 이탈\t' });
  const html2 = visible(await again.text());
  assert.ok(html2.includes('이미 블랙리스트로 등록 중인 1명'));
  const cnt = await db.prepare(`SELECT COUNT(*) n FROM blacklist`).first();
  assert.equal(cnt.n, 1);
  // 양식 파일에도 새 열이 있다
  const tpl = await (await admin.call('/applicants/template.csv')).text();
  assert.ok(tpl.includes('블랙리스트,사유,사유 설명'));
});

import { purgeExpired } from '../src/core.js';

test('업로드: 중복은 올리지 않고 새 내용만 반영, 이름이 다르면 알려 줌', async () => {
  const { admin, db } = await setup();
  const first = '이름,전화번호,지원한 곳,직무\n홍길동,010-1111-0001,A사,현장\n김영희,010-1111-0002,A사,물류';
  let html = visible(await (await admin.post('/applicants/bulk', { back: '/applicants', text: first })).text());
  assert.ok(html.includes('2명을 새로 등록했어요'));
  // 똑같은 파일을 다시 올리면 아무것도 올리지 않는다
  html = visible(await (await admin.post('/applicants/bulk', { back: '/applicants', text: first })).text());
  assert.ok(html.includes('새로 올릴 내용이 없었어요'));
  assert.ok(html.includes('중복 2건은 올리지 않았어요'));
  assert.equal((await db.prepare(`SELECT COUNT(*) n FROM applicants`).first()).n, 2);
  assert.equal((await db.prepare(`SELECT COUNT(*) n FROM applicant_applications`).first()).n, 2);
  // 일부만 새 내용: 홍길동은 새 지원 건, 박민수는 신규, 김영희는 중복(이름 다름 경고)
  const second = '이름,전화번호,지원한 곳,직무\n홍길동,010-1111-0001,B사,경비\n김영희씨,010-1111-0002,A사,물류\n박민수,010-1111-0003,A사,경비';
  html = visible(await (await admin.post('/applicants/bulk', { back: '/applicants', text: second })).text());
  assert.ok(html.includes('1명을 새로 등록했어요'));
  assert.ok(html.includes('이미 있던 1명에게 새 내용을 추가했어요'));
  assert.ok(html.includes('중복 1건은 올리지 않았어요'));
  assert.ok(html.includes('기존 이름을 유지했어요'));
  const name = await db.prepare(`SELECT name FROM applicants WHERE phone='01011110002'`).first();
  assert.equal(name.name, '김영희');
  assert.equal((await db.prepare(`SELECT COUNT(*) n FROM applicants`).first()).n, 3);
  // 같은 파일 안에서 같은 줄이 반복돼도 한 번만
  const dupInFile = '이름,전화번호,지원한 곳,직무\n최수아,010-1111-0004,A사,현장\n최수아,010-1111-0004,A사,현장';
  html = visible(await (await admin.post('/applicants/bulk', { back: '/applicants', text: dupInFile })).text());
  assert.ok(html.includes('중복 1건은 올리지 않았어요'));
});

test('업로드 되돌리기: 새 사람은 삭제, 이후 바뀐 사람은 남김', async () => {
  const { admin, db } = await setup();
  const html = await (await admin.post('/applicants/bulk', { back: '/applicants',
    text: '이름,전화번호,지원한 곳,직무,블랙리스트,사유\n가,010-2222-0001,A사,현장,Y,면접 무단 불참\n나,010-2222-0002,A사,물류,,' })).text();
  const m = html.match(/\/applicants\/batch\/([A-Za-z0-9]+)\/undo/);
  assert.ok(m, '되돌리기 버튼');
  // 업로드 뒤에 한 사람을 직접 수정
  const keep = await db.prepare(`SELECT id FROM applicants WHERE phone='01022220002'`).first();
  await admin.post(`/applicants/${keep.id}/edit`, { name: '나', phone: '010-2222-0002', memo: '확인함' });
  const r = await admin.post(`/applicants/batch/${m[1]}/undo`, { back: '/applicants' });
  assert.equal(r.status, 303);
  assert.match(r.headers.get('location'), /ok=undone&n=1&k=1/);
  const left = await db.prepare(`SELECT name FROM applicants`).all();
  assert.deepEqual(left.results.map((x) => x.name), ['나']);
  assert.equal((await db.prepare(`SELECT COUNT(*) n FROM blacklist`).first()).n, 0);
  // 이미 되돌린 업로드는 다시 되돌릴 수 없다
  const again = await admin.post(`/applicants/batch/${m[1]}/undo`, { back: '/applicants' });
  assert.match(again.headers.get('location'), /err=noactive/);
});

test('블랙리스트 사유 수정, 번호 바로 확인', async () => {
  const { admin, db } = await setup();
  await admin.post('/applicants/new', { name: '홍길동', phone: '010-3333-0001', applied_to: 'A사', job: '현장' });
  const id = (await db.prepare(`SELECT id FROM applicants`).first()).id;
  await admin.post(`/applicants/${id}/blacklist`, { back: '/applicants', reason_code: 'noshow', reason_text: '' });
  // 사유 수정(기타는 설명 필수)
  let r = await admin.post(`/applicants/${id}/reason`, { back: '/applicants', reason_code: 'other', reason_text: '' });
  assert.equal(r.headers.get('location'), '/applicants?err=reason');
  r = await admin.post(`/applicants/${id}/reason`, { back: '/applicants', reason_code: 'misconduct', reason_text: '현장 폭언' });
  assert.equal(r.headers.get('location'), '/applicants?ok=reasoned');
  const bl = await db.prepare(`SELECT reason_code, reason_text FROM blacklist WHERE status='active'`).first();
  assert.equal(bl.reason_code, 'misconduct');
  assert.equal(bl.reason_text, '현장 폭언');
  const ev = await db.prepare(`SELECT detail FROM applicant_events WHERE action='blacklist_edit'`).first();
  assert.match(ev.detail, /면접 무단 불참 → 업무상 부적절한 행위/);
  // 번호로 바로 확인: 블랙리스트 / 일반 / 없음 / 잘못된 번호
  let page = visible(await (await admin.call('/applicants?lookup=' + encodeURIComponent('010-3333-0001'))).text());
  assert.ok(page.includes('블랙리스트예요'));
  assert.ok(page.includes('업무상 부적절한 행위'));
  await admin.post(`/applicants/${id}/release`, { back: '/applicants', note: '' });
  page = visible(await (await admin.call('/applicants?lookup=01033330001')).text());
  assert.ok(page.includes('블랙리스트는 아니에요'));
  page = visible(await (await admin.call('/applicants?lookup=01099990000')).text());
  assert.ok(page.includes('등록된 지원자가 아니에요'));
  page = visible(await (await admin.call('/applicants?lookup=123')).text());
  assert.ok(page.includes('휴대폰 번호를 확인해 주세요'));
});

test('필터, 정렬, 쪽 넘기기, 그리고 오래된 지원자도 자동 삭제되지 않음', async () => {
  const { admin, db } = await setup();
  const rows = ['이름,전화번호,지원한 곳,직무,블랙리스트,사유'];
  for (let i = 1; i <= 120; i++) {
    const n = String(i).padStart(4, '0');
    rows.push(`지원${n},010-5555-${n},${i % 2 ? 'A사' : 'B사'},${i % 3 ? '현장' : '물류'},${i === 7 ? 'Y' : ''},${i === 7 ? '면접 무단 불참' : ''}`);
  }
  // 200명 제한 안에서 한 번에 올린다
  const res = await admin.post('/applicants/bulk', { back: '/applicants', text: rows.join('\n') });
  assert.ok(visible(await res.text()).includes('120명을 새로 등록했어요'));
  let page = await (await admin.call('/applicants')).text();
  assert.ok(visible(page).includes('1 / 3쪽'));      // 50명씩 3쪽
  assert.ok(visible(page).includes('총 120명'));
  page = await (await admin.call('/applicants?page=3')).text();
  assert.ok(visible(page).includes('3 / 3쪽'));
  // 지원한 곳 필터
  page = visible(await (await admin.call('/applicants?applied=' + encodeURIComponent('A사'))).text());
  assert.ok(page.includes('총 60명'));
  // 사유 필터 + 블랙리스트 탭
  page = visible(await (await admin.call('/applicants?reason=noshow&status=bl')).text());
  assert.ok(page.includes('지원0007'));
  assert.ok(page.includes('총 1명'));
  // 이름순 정렬
  page = await (await admin.call('/applicants?sort=name')).text();
  assert.ok(page.indexOf('지원0001') < page.indexOf('지원0002'));
  // 오래된 지원자: 보관 만료 파기 작업이 지원자 데이터에 영향을 주지 않는다
  await db.prepare(`UPDATE applicants SET created_at=1, updated_at=1`).run();
  await purgeExpired(db, Date.now());
  assert.equal((await db.prepare(`SELECT COUNT(*) n FROM applicants`).first()).n, 120);
});

import { getLinkSettings, saveLinkSettings, noshowSuggestions } from '../src/applicants-link.js';

async function withCampaign(db, admin) {
  await db.prepare(`INSERT INTO departments (name) VALUES ('인사팀')`).run();
  await db.prepare(`INSERT INTO gateways (department_id,name,username,password,hook_token) VALUES (1,'폰','u','p','t')`).run();
  return admin.post('/campaigns/new', {
    mode: 'many', csv: '사업장,이름,전화번호,면접일시\nA사,홍길동,010-8000-0001,10/20 14:00\nA사,김영희,010-8000-0002,10/20 14:30\n',
    gateway_id: '1', template: '{이름}님', send_mode: 'manual', name: '면접 안내 시험'
  });
}

test('연결: 기본은 꺼짐 — 면접 안내를 만들어도 지원자가 생기지 않는다', async () => {
  const { admin, db } = await setup();
  const s = await getLinkSettings(db);
  assert.equal(s.enabled, false);
  assert.equal(s.register, false);
  const res = await withCampaign(db, admin);
  assert.equal(res.status, 200);
  assert.equal((await db.prepare(`SELECT COUNT(*) n FROM applicants`).first()).n, 0);
});

test('연결 설정은 관리자만 바꾼다, 항목은 연결이 켜져 있어야 동작', async () => {
  const { admin, staff, db } = await setup();
  const denied = await staff.post('/applicants/settings', { enabled: '1', register: '1' });
  assert.equal(denied.status, 403);
  await saveLinkSettings(db, { enabled: false, register: true, history: true, suggest: true, flag: true, threshold: 2 });
  let s = await getLinkSettings(db);
  assert.equal(s.register, false);          // 연결이 꺼져 있으면 항목도 꺼진 것으로 본다
  assert.equal(s.raw.register, true);
  assert.equal(s.threshold, 2);
  const ok = await admin.post('/applicants/settings', { back: '/applicants', enabled: '1', register: '1', suggest: '1', threshold: '4' });
  assert.equal(ok.headers.get('location'), '/applicants?ok=settings');
  s = await getLinkSettings(db);
  assert.equal(s.enabled, true);
  assert.equal(s.register, true);
  assert.equal(s.history, false);
  assert.equal(s.threshold, 4);
});

test('연결 켜짐: 면접 안내 명단 자동 등록(중복 제외), 블랙리스트 참고 표시, 이력, 노쇼 후보 제안', async () => {
  const { admin, db } = await setup();
  // 홍길동은 이미 블랙리스트
  await admin.post('/applicants/new', { name: '홍길동', phone: '010-8000-0001', applied_to: 'A사', job: '현장' });
  const pid = (await db.prepare(`SELECT id FROM applicants WHERE phone='01080000001'`).first()).id;
  await admin.post(`/applicants/${pid}/blacklist`, { reason_code: 'noshow', reason_text: '' });
  await admin.post('/applicants/settings', { enabled: '1', register: '1', history: '1', suggest: '1', flag: '1', threshold: '2' });
  const res = await withCampaign(db, admin);
  const html = visible(await res.text());
  assert.match(html, /지원자 관리에 1명\s*을 새로 등록했어요/);   // 김영희만 신규
  assert.ok(!html.includes('이미 있던'));                              // 홍길동은 같은 지원한 곳이 이미 있어 새 내용 없음
  assert.match(html, /블랙리스트로 등록된 1명/);
  assert.equal((await db.prepare(`SELECT COUNT(*) n FROM applicants`).first()).n, 2);
  // 면접 안내 상세에 참고 배지
  const detail = await (await admin.call('/campaigns/1')).text();
  assert.match(detail, /참고용, 발송은 막지 않아요/);
  // 지원자 기록에 면접 안내 이력
  const panel = await (await admin.call(`/applicants/${pid}/panel`)).text();
  assert.ok(panel.includes('면접 안내 이력'));
  assert.ok(panel.includes('면접 안내 시험'));
  // 노쇼 2회 기록 → 후보 제안(이미 블랙리스트인 홍길동 제외, 김영희 대상)
  await db.prepare(`INSERT INTO campaigns (department_id,gateway_id,name,template,created_at,status) VALUES (1,1,'두번째','x',?, 'done')`).bind(Date.now()).run();
  await db.prepare(`UPDATE candidates SET outcome='noshow' WHERE phone='01080000002'`).run();
  await db.prepare(`INSERT INTO candidates (campaign_id,site,name,phone,status,outcome) VALUES (2,'A사','김영희','01080000002','attending','noshow')`).run();
  const sug = await noshowSuggestions(db, 2);
  assert.equal(sug.length, 1);
  assert.equal(sug[0].phone, '01080000002');
  assert.equal(sug[0].n, 2);
  let page = visible(await (await admin.call('/applicants')).text());
  assert.ok(page.includes('블랙리스트 후보 제안 1명'));
  // 무시하면 사라지고, 더 늘면 다시 나온다
  await admin.post('/applicants/suggest/dismiss', { back: '/applicants', phone: '01080000002', n: '2' });
  assert.equal((await noshowSuggestions(db, 2)).length, 0);
  await db.prepare(`INSERT INTO candidates (campaign_id,site,name,phone,status,outcome) VALUES (2,'B사','김영희','01080000002','attending','noshow')`).run();
  assert.equal((await noshowSuggestions(db, 2)).length, 1);
  // 승인하면 블랙리스트로 등록
  const reg = await admin.post('/applicants/suggest/register', { back: '/applicants', phone: '01080000002', name: '김영희', n: '3' });
  assert.equal(reg.headers.get('location'), '/applicants?ok=blacklisted');
  const bl = await db.prepare(`SELECT reason_code, reason_text FROM blacklist b JOIN applicants a ON a.id=b.applicant_id WHERE a.phone='01080000002' AND b.status='active'`).first();
  assert.equal(bl.reason_code, 'noshow');
  assert.match(bl.reason_text, /노쇼 3회/);
  assert.equal((await noshowSuggestions(db, 2)).length, 0);
});

test('일괄 선택 처리: 블랙리스트 등록/해제, 건너뜀, 삭제는 관리자만', async () => {
  const { admin, staff, db } = await setup();
  for (const [n, p] of [['가', '010-9000-0001'], ['나', '010-9000-0002'], ['다', '010-9000-0003']]) {
    await admin.post('/applicants/new', { name: n, phone: p, applied_to: 'A사', job: '현장' });
  }
  const ids = (await db.prepare(`SELECT id FROM applicants ORDER BY id`).all()).results.map((r) => r.id);
  const form = (obj, list) => {
    const sp = new URLSearchParams(obj);
    list.forEach((i) => sp.append('ids', String(i)));
    return sp.toString();
  };
  const send = (who, obj, list) => who.call('/applicants/bulk-action', {
    method: 'POST', body: form(obj, list), headers: { 'content-type': 'application/x-www-form-urlencoded' }
  });
  // 선택 없음
  let r = await send(admin, { op: 'blacklist', reason_code: 'noshow', back: '/applicants' }, []);
  assert.equal(r.headers.get('location'), '/applicants?err=nopick');
  // 기타인데 설명 없음
  r = await send(admin, { op: 'blacklist', reason_code: 'other', reason_text: '', back: '/applicants' }, ids);
  assert.equal(r.headers.get('location'), '/applicants?err=reason');
  // 3명 중 1명을 먼저 등록해 두고, 일괄 등록 → 2명 처리, 1명 건너뜀
  await admin.post(`/applicants/${ids[0]}/blacklist`, { reason_code: 'absent', reason_text: '' });
  r = await send(admin, { op: 'blacklist', reason_code: 'noshow', reason_text: '10/20 불참', back: '/applicants' }, ids);
  assert.match(r.headers.get('location'), /ok=bulkop&n=2&k=1/);
  assert.equal((await db.prepare(`SELECT COUNT(*) n FROM blacklist WHERE status='active'`).first()).n, 3);
  const page = visible(await (await admin.call('/applicants?ok=bulkop&n=2&k=1')).text());
  assert.ok(page.includes('2명을 처리했어요'));
  // 일괄 해제
  r = await send(admin, { op: 'release', note: '정리', back: '/applicants' }, [ids[1], ids[2]]);
  assert.match(r.headers.get('location'), /n=2&k=0/);
  assert.equal((await db.prepare(`SELECT COUNT(*) n FROM blacklist WHERE status='active'`).first()).n, 1);
  // 삭제는 관리자만
  r = await send(staff, { op: 'delete', back: '/applicants' }, ids);
  assert.equal(r.status, 403);
  r = await send(admin, { op: 'delete', back: '/applicants' }, [ids[1], ids[2]]);
  assert.match(r.headers.get('location'), /n=2/);
  assert.equal((await db.prepare(`SELECT COUNT(*) n FROM applicants`).first()).n, 1);
  // 선택 칸과 일괄 처리 막대가 화면에 있다
  const html = await (await admin.call('/applicants')).text();
  assert.match(html, /id="bulkform"/);
  assert.match(html, /class="rowchk"/);
});

test('지원자 병합: 지원 이력·블랙리스트·기록을 옮기고 중복은 정리', async () => {
  const { admin, db } = await setup();
  await admin.post('/applicants/new', { name: '홍길동', phone: '010-9100-0001', applied_to: 'A사', job: '현장' });
  await admin.post('/applicants/new', { name: '홍길동', phone: '010-9100-0002', applied_to: 'A사', job: '현장' }); // 번호를 바꾼 같은 사람
  await admin.post('/applicants/new', { name: '홍길동', phone: '010-9100-0002', applied_to: 'B사', job: '경비' });
  const [t, s2] = (await db.prepare(`SELECT id FROM applicants ORDER BY id`).all()).results.map((r) => r.id);
  await admin.post(`/applicants/${t}/blacklist`, { reason_code: 'noshow', reason_text: '' });
  await admin.post(`/applicants/${s2}/blacklist`, { reason_code: 'absent', reason_text: '' });
  // 상세에 같은 이름 제안이 보인다
  const detail = visible(await (await admin.call(`/applicants/${t}`)).text());
  assert.ok(detail.includes('이름이 같은 지원자'));
  // 자기 자신 / 없는 번호
  let r = await admin.post(`/applicants/${t}/merge`, { back: '/applicants', other_id: String(t) });
  assert.equal(r.headers.get('location'), '/applicants?err=mergeself');
  r = await admin.post(`/applicants/${t}/merge`, { back: '/applicants', other_phone: '010-0000-0000' });
  assert.equal(r.headers.get('location'), '/applicants?err=nomerge');
  // 번호로 합치기
  r = await admin.post(`/applicants/${t}/merge`, { other_phone: '010-9100-0002' });
  assert.equal(r.headers.get('location'), `/applicants/${t}?ok=merged`);
  assert.equal((await db.prepare(`SELECT COUNT(*) n FROM applicants`).first()).n, 1);
  const apps = await db.prepare(`SELECT applied_to, job FROM applicant_applications WHERE applicant_id=? ORDER BY applied_to`).bind(t).all();
  assert.deepEqual(apps.results.map((x) => `${x.applied_to}/${x.job}`), ['A사/현장', 'B사/경비']); // A사/현장 중복은 하나로
  const act = await db.prepare(`SELECT reason_code FROM blacklist WHERE applicant_id=? AND status='active'`).bind(t).all();
  assert.equal(act.results.length, 1);
  assert.equal(act.results[0].reason_code, 'noshow');   // target 의 블랙리스트를 남김
  const rel = await db.prepare(`SELECT release_note FROM blacklist WHERE applicant_id=? AND status='released'`).bind(t).all();
  assert.equal(rel.results.length, 1);
  assert.match(rel.results[0].release_note, /병합/);
  const ev = await db.prepare(`SELECT detail FROM applicant_events WHERE action='merge'`).first();
  assert.match(ev.detail, /끝번호 0002/);
});

test('지원한 곳·직무 자동 완성(datalist)', async () => {
  const { admin } = await setup();
  await admin.post('/applicants/new', { name: '가', phone: '010-9200-0001', applied_to: '아마노코리아(현장HR)', job: '현장 관리' });
  const html = await (await admin.call('/applicants')).text();
  assert.match(html, /<datalist id="dl-applied"><option value="아마노코리아\(현장HR\)">/);
  assert.match(html, /<datalist id="dl-job"><option value="현장 관리">/);
  assert.match(html, /list="dl-applied"/);
  const id = html.match(/\/applicants\/(\d+)"/)[1];
  const detail = await (await admin.call(`/applicants/${id}`)).text();
  assert.match(detail, /<datalist id="dl-applied">/);
});

test('연결 설정: 연결 사용이 꺼져 있으면 하위 항목은 회색(비활성), 꺼서 저장해도 값은 보존', async () => {
  const { admin, db } = await setup();
  // 꺼짐(기본): fieldset 이 disabled
  let html = await (await admin.call('/applicants')).text();
  assert.match(html, /<fieldset class="linkopts" id="linkopts" disabled>/);
  // 켜고 항목을 고르면 활성
  await admin.post('/applicants/settings', { back: '/applicants', enabled: '1', register: '1', suggest: '1', threshold: '5' });
  html = await (await admin.call('/applicants')).text();
  assert.match(html, /<fieldset class="linkopts" id="linkopts">/);
  // 연결을 끄고 저장(하위 칸은 비활성이라 전송되지 않음) → 이전에 고른 항목 값이 지워지지 않는다
  await admin.post('/applicants/settings', { back: '/applicants' });
  const s = await getLinkSettings(db);
  assert.equal(s.enabled, false);
  assert.equal(s.raw.register, true);
  assert.equal(s.raw.suggest, true);
  assert.equal(s.threshold, 5);
  html = await (await admin.call('/applicants')).text();
  assert.match(html, /name="register" value="1" checked/);   // 회색이지만 이전 선택은 보인다
  assert.match(html, /<fieldset class="linkopts" id="linkopts" disabled>/);
});
