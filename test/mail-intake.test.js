import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openSqliteD1 } from '../src/node/d1-sqlite.js';
import { handleRequest, handleEmail } from '../src/worker.js';
import { createSession } from '../src/auth.js';
import { hashPassword } from '../src/crypto.js';
import { parseMime, parseAlbamonApply, ingestRaw, getIntakeToken, ensureIntakeToken, pendingInboxCount } from '../src/mail-intake.js';

const visible = (html) => html.replace(/<(style|script)[\s\S]*?<\/\1>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

// 알바몬 지원 알림 메일 본문(가상 데이터)
const bodyHtml = (name = '홍길동(여, 32세)', apply = '900000001') => `<html><body>
<table><tr><td><b>㈜테스트-회사(test)</b>님, 2026.10.15(목)에 새로운 온라인 지원자가 있습니다.</td></tr></table>
<table><tbody>
<tr><th><div>공고번호</div></th><td><a href="https://www.albamon.com/jobs/detail/111222333">111222333</a></td></tr>
<tr><th><div>근무회사명</div></th><td>㈜테스트-회사</td></tr>
<tr><th><div>공고제목</div></th><td><a href="https://www.albamon.com/jobs/detail/111222333">[테스트] 현장 관리 직원 모집 (단기)</a></td></tr>
</tbody></table>
<table><tbody>
<tr><th><div>이름</div></th><td>${name}</td></tr>
<tr><th><div>주소</div></th><td>서울 양천구 신월6동</td></tr>
<tr><th><div>학력</div></th><td>고등학교 졸업</td></tr>
<tr><th><div>총 경력</div></th><td>7년1개월</td></tr>
</tbody></table>
<p>개인정보 보호를 위해 지원자의 연락처를 노출하지 않습니다.</p>
<a href="https://www.albamon.com/email-apply-url-route?recruitNo=111222333&amp;applyNo=${apply}" target="blank">이력서 보기</a>
</body></html>`;

const qp = (s) => s.replace(/=/g, '=3D').replace(/[^\x20-\x7e\r\n]/g, (c) => [...new TextEncoder().encode(c)].map((b) => '=' + b.toString(16).toUpperCase().padStart(2, '0')).join(''));
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');

const mailQP = (html) => Buffer.from([
  'From: Albamon <noreply@albamon.com>', 'To: apply-x@bigbears.me', 'Subject: =?UTF-8?B?7Jyg7J2064qUIOyngOybkOyekA==?=',
  'MIME-Version: 1.0', 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: quoted-printable', '', qp(html)
].join('\r\n'), 'binary');

const mailMultipartB64 = (html) => Buffer.from([
  'From: forwarder@company.example', 'MIME-Version: 1.0', 'Content-Type: multipart/alternative; boundary="BOUND"', '',
  '--BOUND', 'Content-Type: text/plain; charset=UTF-8', '', '지원 알림', '--BOUND', 'Content-Type: text/html; charset=UTF-8',
  'Content-Transfer-Encoding: base64', '', b64(html), '--BOUND--', ''
].join('\r\n'), 'binary');

const mailForwardedRfc822 = (inner) => Buffer.from([
  'From: forwarder@company.example', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="OUT"', '',
  '--OUT', 'Content-Type: text/plain; charset=UTF-8', '', '전달합니다', '--OUT', 'Content-Type: message/rfc822', '',
  inner.toString('binary'), '--OUT--', ''
].join('\r\n'), 'binary');

async function setup() {
  const db = openSqliteD1(':memory:', fileURLToPath(new URL('../migrations', import.meta.url)));
  const env = { DB: db, ENCRYPTION_KEY: 'k', PUBLIC_BASE_URL: 'https://interview.example.test', GATEWAY_URL: 'https://x/api/3rdparty/v1', GATEWAY_PRIVATE_TOKEN: 't' };
  const u = await db.prepare(`INSERT INTO users (username,pass_hash,role,email_verified_at,name,email) VALUES ('boss',?,'super',1,'김관리','b@willvi.co.kr')`).bind(await hashPassword('x')).run();
  const sid = await createSession(db, Number(u.meta.last_row_id));
  const call = (p, init = {}) => handleRequest(new Request('https://interview.example.test' + p, { ...init, headers: { cookie: `sid=${sid}`, origin: 'https://interview.example.test', ...(init.headers || {}) } }), env, { waitUntil() {} });
  const post = (p, f) => call(p, { method: 'POST', body: new URLSearchParams(f).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  return { db, env, call, post };
}

test('알림 메일 해석: 이름·성별·나이, 공고, 이력서 링크의 지원 번호', () => {
  const p = parseAlbamonApply(bodyHtml());
  assert.equal(p.name, '홍길동');
  assert.equal(p.gender, '여');
  assert.equal(p.age, 32);
  assert.equal(p.company, '㈜테스트-회사');
  assert.equal(p.jobTitle, '[테스트] 현장 관리 직원 모집 (단기)');
  assert.equal(p.recruitNo, '111222333');
  assert.equal(p.applyNo, '900000001');
  assert.equal(p.address, '서울 양천구 신월6동');
  assert.equal(p.education, '고등학교 졸업');
  assert.equal(p.career, '7년1개월');
  assert.match(p.resumeUrl, /^https:\/\/www\.albamon\.com\/email-apply-url-route\?recruitNo=111222333&applyNo=900000001$/);
  assert.equal(parseAlbamonApply('<p>다른 메일</p>'), null);
});

test('MIME: quoted-printable, base64 멀티파트, 전달된 메일(message/rfc822)', () => {
  for (const raw of [mailQP(bodyHtml()), mailMultipartB64(bodyHtml()), mailForwardedRfc822(mailQP(bodyHtml()))]) {
    const m = parseMime(new Uint8Array(raw));
    const p = parseAlbamonApply(m.html);
    assert.ok(p, '해석됨');
    assert.equal(p.name, '홍길동');
    assert.equal(p.applyNo, '900000001');
  }
});

test('수신 처리: 저장, 같은 지원 번호는 한 번만, 알바몬이 아니면 무시', async () => {
  const { db } = await setup();
  const raw = new Uint8Array(mailQP(bodyHtml()));
  let r = await ingestRaw(db, raw, Date.now());
  assert.equal(r.ok, true);
  assert.equal(await pendingInboxCount(db), 1);
  r = await ingestRaw(db, raw, Date.now());
  assert.equal(r.duplicate, true);
  assert.equal(await pendingInboxCount(db), 1);
  r = await ingestRaw(db, new Uint8Array(Buffer.from('Subject: hi\r\n\r\n안녕하세요')), Date.now());
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not_albamon');
  // 원문 전체를 저장하지 않는다(연락처가 없는 항목만)
  const row = await db.prepare(`SELECT * FROM applicant_inbox`).first();
  assert.equal(row.name, '홍길동');
  assert.ok(!JSON.stringify(row).includes('<html'));
});

test('이메일 Worker: 비밀 주소만 받고 나머지는 거절', async () => {
  const { db, env } = await setup();
  const token = await ensureIntakeToken(db);
  const mk = (to, raw) => {
    const out = { rejected: '' };
    return {
      to, rawSize: raw.length, raw: new Response(raw).body,
      setReject(why) { out.rejected = why; }, out
    };
  };
  const raw = new Uint8Array(mailQP(bodyHtml('김영희(여, 28세)', '900000002')));
  const bad = mk('apply-wrong@bigbears.me', raw);
  await handleEmail(bad, env);
  assert.equal(bad.out.rejected, 'Address not found');
  assert.equal(await pendingInboxCount(db), 0);
  const good = mk(`apply-${token}@bigbears.me`, raw);
  const r = await handleEmail(good, env);
  assert.equal(good.out.rejected, '');
  assert.equal(r.ok, true);
  assert.equal(await pendingInboxCount(db), 1);
});

test('수신함 화면: 수신 주소(관리자), 대기 목록, 등록(연락처 필수)·무시·되돌리기', async () => {
  const { db, call, post } = await setup();
  await ingestRaw(db, new Uint8Array(mailQP(bodyHtml('홍길동(여, 32세)', '900000001'))), Date.now());
  await ingestRaw(db, new Uint8Array(mailQP(bodyHtml('박민수(남, 30세)', '900000002'))), Date.now());
  const page = await (await call('/applicants/inbox')).text();
  const text = visible(page);
  assert.ok(text.includes('홍길동'));
  assert.ok(text.includes('㈜테스트-회사'));
  assert.match(page, /target="_blank" rel="noopener noreferrer"/);
  const token = await getIntakeToken(db);
  assert.ok(page.includes(`apply-${token}@bigbears.me`) || page.includes(`apply-${token}@`));
  assert.match(page, /javascript:\(function\(\)/);
  // 연락처 없이/잘못된 연락처 → 거절
  const id1 = (await db.prepare(`SELECT id FROM applicant_inbox WHERE name='홍길동'`).first()).id;
  let r = await post(`/applicants/inbox/${id1}/register`, { name: '홍길동', phone: '123' });
  assert.equal(r.headers.get('location'), '/applicants/inbox?err=invalid');
  // 등록
  r = await post(`/applicants/inbox/${id1}/register`, { name: '홍길동', phone: '010-1234-5678' });
  assert.equal(r.headers.get('location'), '/applicants/inbox?ok=registered');
  const ap = await db.prepare(`SELECT id, name, phone, source FROM applicants`).first();
  assert.equal(ap.phone, '01012345678');
  assert.equal(ap.source, 'mail');
  const app = await db.prepare(`SELECT applied_to, job FROM applicant_applications WHERE applicant_id=?`).bind(ap.id).first();
  assert.equal(app.applied_to, '㈜테스트-회사');
  assert.match(app.job, /현장 관리/);
  assert.equal(await pendingInboxCount(db), 1);
  // 이미 처리한 건은 다시 등록되지 않는다
  r = await post(`/applicants/inbox/${id1}/register`, { name: '홍길동', phone: '010-1234-5678' });
  assert.equal(r.headers.get('location'), '/applicants/inbox?err=gone');
  // 무시 → 다시 대기로
  const id2 = (await db.prepare(`SELECT id FROM applicant_inbox WHERE name='박민수'`).first()).id;
  await post(`/applicants/inbox/${id2}/ignore`, {});
  assert.equal(await pendingInboxCount(db), 0);
  await post(`/applicants/inbox/${id2}/restore`, {});
  assert.equal(await pendingInboxCount(db), 1);
  // 홈 "오늘 할 일"에 메일로 들어온 지원자
  const home = visible(await (await call('/')).text());
  assert.ok(home.includes('메일로 들어온 지원자'));
  // 가져오기 화면
  const cap = await (await call('/applicants/inbox/capture')).text();
  assert.match(cap, /id="pending-data"/);
  assert.ok(cap.includes('박민수'));
});

test('수신 주소 다시 만들기는 관리자만, 새 주소가 만들어진다', async () => {
  const { db, post } = await setup();
  const t1 = await ensureIntakeToken(db);
  const r = await post('/applicants/inbox/token', {});
  assert.equal(r.headers.get('location'), '/applicants/inbox?ok=token');
  const t2 = await getIntakeToken(db);
  assert.notEqual(t1, t2);
});

import { createAgentToken, verifyAgentToken, requestFetch, getAutoRegister, saveParsed, safeResumeUrl, hasAgentToken } from '../src/mail-intake.js';

test('에이전트 API: 토큰 인증, 요청 목록, 결과 저장, 자동 등록', async () => {
  const { db, env, call, post } = await setup();
  await ingestRaw(db, new Uint8Array(mailQP(bodyHtml('홍길동(여, 32세)', '900000001'))), Date.now());
  await ingestRaw(db, new Uint8Array(mailQP(bodyHtml('박민수(남, 30세)', '900000002'))), Date.now());
  const id1 = (await db.prepare(`SELECT id FROM applicant_inbox WHERE name='홍길동'`).first()).id;
  const api = (path, init = {}, token) => handleRequest(new Request('https://interview.example.test' + path, {
    ...init, headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(init.headers || {}) }
  }), env, { waitUntil() {} });

  // 토큰이 없거나 틀리면 401
  assert.equal((await api('/api/agent/inbox')).status, 401);
  const token = await createAgentToken(db);
  assert.match(token, /^ag_[0-9a-f]{48}$/);
  assert.deepEqual(await verifyAgentToken(db, token), { userId: null });   // 예전 공용 키
  assert.equal(await verifyAgentToken(db, 'ag_' + '0'.repeat(48)), null);
  assert.equal((await api('/api/agent/inbox', {}, 'ag_' + '0'.repeat(48))).status, 401);

  // 요청하지 않은 건은 목록에 없다
  let list = await (await api('/api/agent/inbox', {}, token)).json();
  assert.equal(list.items.length, 0);
  // 화면에서 한 건 요청 → 에이전트 목록에 나타남
  const rq = await post(`/applicants/inbox/${id1}/fetch`, {});
  assert.equal(rq.headers.get('location'), '/applicants/inbox?ok=fetch');
  list = await (await api('/api/agent/inbox', {}, token)).json();
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].name, '홍길동');
  assert.match(list.items[0].resume_url, /email-apply-url-route/);

  // 결과: 잘못된 번호는 실패 처리, 올바른 번호는 채움
  let res = await api(`/api/agent/inbox/${id1}/result`, { method: 'POST', body: JSON.stringify({ ok: true, phone: '12345' }) }, token);
  assert.equal((await res.json()).ok, false);
  let row = await db.prepare(`SELECT phone, fetch_state FROM applicant_inbox WHERE id=?`).bind(id1).first();
  assert.equal(row.fetch_state, 'failed');
  await post(`/applicants/inbox/${id1}/fetch`, {});          // 다시 요청
  res = await api(`/api/agent/inbox/${id1}/result`, { method: 'POST', body: JSON.stringify({ ok: true, phone: '010-9999-8888' }) }, token);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.registered, false);
  row = await db.prepare(`SELECT phone, fetch_state, status FROM applicant_inbox WHERE id=?`).bind(id1).first();
  assert.equal(row.phone, '01099998888');
  assert.equal(row.fetch_state, 'done');
  assert.equal(row.status, 'pending');
  // 수신함 화면: 연락처가 미리 채워져 있다
  const page = await (await call('/applicants/inbox')).text();
  assert.match(page, /value="010-9999-8888"/);
  assert.match(page, /연락처 채워짐/);

  // 자동 등록을 켜면 연락처를 가져오는 즉시 지원자로 등록
  assert.equal(await getAutoRegister(db), false);
  await post('/applicants/inbox/auto', { on: '1' });
  assert.equal(await getAutoRegister(db), true);
  const id2 = (await db.prepare(`SELECT id FROM applicant_inbox WHERE name='박민수'`).first()).id;
  await post(`/applicants/inbox/${id2}/fetch`, {});
  res = await api(`/api/agent/inbox/${id2}/result`, { method: 'POST', body: JSON.stringify({ ok: true, phone: '01077776666' }) }, token);
  assert.equal((await res.json()).registered, true);
  const ap = await db.prepare(`SELECT name, phone, source FROM applicants WHERE phone='01077776666'`).first();
  assert.equal(ap.name, '박민수');
  assert.equal(ap.source, 'mail');
  assert.equal((await db.prepare(`SELECT status FROM applicant_inbox WHERE id=?`).bind(id2).first()).status, 'registered');
});

test('대기 전체 요청, 연결 키는 관리자 화면에서 한 번만 보여 줌', async () => {
  const { db, call, post } = await setup();
  await ingestRaw(db, new Uint8Array(mailQP(bodyHtml('홍길동(여, 32세)', '900000001'))), Date.now());
  await ingestRaw(db, new Uint8Array(mailQP(bodyHtml('박민수(남, 30세)', '900000002'))), Date.now());
  const r = await post('/applicants/inbox/fetch-all', {});
  assert.match(r.headers.get('location'), /ok=fetchall&n=2/);
  assert.equal(await requestFetch(db, null), 0);               // 이미 요청된 건은 다시 세지 않는다
  const created = await post('/applicants/inbox/agent-token', {});
  assert.equal(created.status, 200);
  const html = await created.text();
  const m = html.match(/ag_[0-9a-f]{48}/);
  assert.ok(m, '새 연결 키가 한 번 표시됨');
  const again = await (await call('/applicants/inbox')).text();
  assert.ok(!/ag_[0-9a-f]{48}/.test(again), '다시 열면 키는 보이지 않음');
  assert.match(again, /연결 키 있음/);
});

test('원가중심점: 같은 공고에 한 번에 적용·기억, 새 메일에 자동, 등록 시 지원한 곳으로 저장', async () => {
  const { db, call, post } = await setup();
  await ingestRaw(db, new Uint8Array(mailQP(bodyHtml('홍길동(여, 32세)', '900000011'))), Date.now());
  await ingestRaw(db, new Uint8Array(mailQP(bodyHtml('박민수(남, 30세)', '900000012'))), Date.now());
  const id1 = (await db.prepare(`SELECT id FROM applicant_inbox WHERE name='홍길동'`).first()).id;
  // 화면에 입력칸이 보인다
  assert.match(await (await call('/applicants/inbox')).text(), /name="cost_center" data-cc-search/);
  // 같은 공고 모두 적용
  let r = await post(`/applicants/inbox/${id1}/cost`, { cost_center: '아마노코리아(현장HR)', apply_all: '1' });
  assert.equal(r.headers.get('location'), '/applicants/inbox?ok=cost');
  const rows = (await db.prepare(`SELECT name, cost_center FROM applicant_inbox ORDER BY id`).all()).results;
  assert.deepEqual(rows.map((x) => x.cost_center), ['아마노코리아(현장HR)', '아마노코리아(현장HR)']);
  // 이후 같은 공고의 새 메일에도 자동으로 붙는다
  await ingestRaw(db, new Uint8Array(mailQP(bodyHtml('최수아(여, 25세)', '900000013'))), Date.now());
  assert.equal((await db.prepare(`SELECT cost_center c FROM applicant_inbox WHERE name='최수아'`).first()).c, '아마노코리아(현장HR)');
  // 이 사람만 바꾸기(기억은 그대로)
  const id2 = (await db.prepare(`SELECT id FROM applicant_inbox WHERE name='박민수'`).first()).id;
  await post(`/applicants/inbox/${id2}/cost`, { cost_center: '아마노코리아(파견)' });
  assert.equal((await db.prepare(`SELECT cost_center c FROM applicant_inbox WHERE id=?`).bind(id1).first()).c, '아마노코리아(현장HR)');
  assert.equal((await db.prepare(`SELECT cost_center c FROM applicant_inbox WHERE id=?`).bind(id2).first()).c, '아마노코리아(파견)');
  // 등록하면 지원한 곳에 원가중심점이 들어간다(없으면 근무회사명)
  await post(`/applicants/inbox/${id1}/register`, { name: '홍길동', phone: '010-1234-5678' });
  const app = await db.prepare(`SELECT applied_to FROM applicant_applications`).first();
  assert.equal(app.applied_to, '아마노코리아(현장HR)');
  // 비우고 모두 적용하면 기억이 지워진다
  await post(`/applicants/inbox/${id2}/cost`, { cost_center: '', apply_all: '1' });
  assert.equal((await db.prepare(`SELECT COUNT(*) n FROM inbox_cost_rules`).first()).n, 0);
});

test('원가중심점 목록: 붙여넣기로 추가, 찾기, 목록이 있으면 목록 밖 이름은 거절', async () => {
  const { db, call, post } = await setup();
  await ingestRaw(db, new Uint8Array(mailQP(bodyHtml('홍길동(여, 32세)', '900000021'))), Date.now());
  const id = (await db.prepare(`SELECT id FROM applicant_inbox`).first()).id;
  // 목록이 없으면 자유 입력
  assert.equal((await post(`/applicants/inbox/${id}/cost`, { cost_center: '아무거나' })).headers.get('location'), '/applicants/inbox?ok=cost');
  const lines = Array.from({ length: 300 }, (_, i) => `원가센터${i}`).concat(['아마노코리아(현장HR)', '아마노코리아(파견)', '아마노코리아(현장HR)']).join('\r\n');
  assert.equal((await post('/applicants/inbox/cost-centers/add', { names: lines })).headers.get('location'), '/applicants/inbox/cost-centers?ok=ccadd');
  assert.equal((await db.prepare(`SELECT COUNT(*) n FROM cost_centers`).first()).n, 302);
  const page = await (await call('/applicants/inbox/cost-centers?q=' + encodeURIComponent('아마노'))).text();
  assert.ok(visible(page).includes('전체 302개'));
  assert.ok(visible(page).includes('아마노코리아(파견)'));
  assert.ok(!visible(page).includes('원가센터1'));
  // 목록이 생기면 목록 밖 이름은 거절, 안의 이름은 저장
  assert.equal((await post(`/applicants/inbox/${id}/cost`, { cost_center: '아무거나' })).headers.get('location'), '/applicants/inbox?err=cclist');
  assert.equal((await post(`/applicants/inbox/${id}/cost`, { cost_center: '아마노코리아(파견)' })).headers.get('location'), '/applicants/inbox?ok=cost');
  const found = await (await call('/applicants/inbox/cost-centers/search?q=' + encodeURIComponent('아마노 현장'))).json();
  assert.deepEqual(found.items, ['아마노코리아(현장HR)']);
});

test('사람별 연결 키: 내 건만 보이고, 남의 건 결과는 거절, 그룹웨어 메일 본문 저장(중복·링크 검사)', async () => {
  const { db, env, call, post } = await setup();
  const mkUser = async (name) => {
    const u = await db.prepare(`INSERT INTO users (username,pass_hash,role,email_verified_at,name,email) VALUES (?,?,'member',1,?,?)`).bind(name, await hashPassword('x'), name, name + '@willvi.co.kr').run();
    return Number(u.meta.last_row_id);
  };
  const A = await mkUser('에이'), B = await mkUser('비');
  const tokA = await createAgentToken(db, A);
  const tokB = await createAgentToken(db, B);
  assert.deepEqual(await verifyAgentToken(db, tokA), { userId: A });
  assert.deepEqual(await verifyAgentToken(db, tokB), { userId: B });
  const api = (path, init = {}, token) => handleRequest(new Request('https://interview.example.test' + path, {
    ...init, headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(init.headers || {}) }
  }), env, { waitUntil() {} });

  // 각자 자기 메일함 본문을 보낸다 (알바몬 표 HTML)
  const send = (tok, html) => api('/api/agent/mail', { method: 'POST', body: JSON.stringify({ html }) }, tok).then((r) => r.json());
  assert.deepEqual(await send(tokA, bodyHtml('홍길동(여, 32세)', '900000031')), { ok: true, duplicate: false });
  assert.deepEqual(await send(tokB, bodyHtml('박민수(남, 30세)', '900000032')), { ok: true, duplicate: false });
  assert.equal((await send(tokA, bodyHtml('홍길동(여, 32세)', '900000031'))).duplicate, true);   // 같은 지원 번호는 한 번만
  assert.equal((await send(tokA, '<p>알바몬이 아닌 메일</p>')).reason, 'not_albamon');
  const rows = (await db.prepare(`SELECT name, owner_user_id FROM applicant_inbox ORDER BY id`).all()).results;
  assert.deepEqual(rows.map((r) => [r.name, r.owner_user_id]), [['홍길동', A], ['박민수', B]]);

  // 이력서 링크가 알바몬 주소가 아니면 버린다(확장 프로그램이 나중에 이 주소를 연다)
  const evil = bodyHtml('최수아(여, 25세)', '900000033').replace('https://www.albamon.com/email-apply-url-route', 'https://evil.example.com/steal');
  const r3 = await send(tokA, evil);
  assert.equal(r3.ok, false);   // 링크가 없는 메일은 지원 메일로 보지 않는다
  assert.equal((await db.prepare(`SELECT COUNT(*) n FROM applicant_inbox`).first()).n, 2);

  // 연락처 가져오기 요청: A 의 키로는 A 건만 보인다
  await db.prepare(`UPDATE applicant_inbox SET fetch_state='requested'`).run();
  const listA = await (await api('/api/agent/inbox', {}, tokA)).json();
  const listB = await (await api('/api/agent/inbox', {}, tokB)).json();
  assert.deepEqual(listA.items.map((x) => x.name), ['홍길동']);
  assert.deepEqual(listB.items.map((x) => x.name), ['박민수']);
  // B 가 A 의 건에 결과를 보내면 거절
  const idA = listA.items[0].id;
  const bad = await api(`/api/agent/inbox/${idA}/result`, { method: 'POST', body: JSON.stringify({ ok: true, phone: '010-1111-2222' }) }, tokB);
  assert.equal(bad.status, 404);
  assert.equal((await db.prepare(`SELECT phone FROM applicant_inbox WHERE id=?`).bind(idA).first()).phone, '');
  const good = await api(`/api/agent/inbox/${idA}/result`, { method: 'POST', body: JSON.stringify({ ok: true, phone: '010-1111-2222' }) }, tokA);
  assert.equal((await good.json()).ok, true);

  // 내가 누구인지
  const me = await (await api('/api/agent/me', {}, tokA)).json();
  assert.equal(me.name, '에이');
  // 용량 제한
  const big = await api('/api/agent/mail', { method: 'POST', body: JSON.stringify({ html: 'x'.repeat(400001) }) }, tokA);
  assert.equal(big.status, 413);
});

test('수신함 화면: 일반 사용자는 내 건+공용 건만, 관리자는 전체(담당자 표시), 누구나 내 연결 키를 만든다', async () => {
  const { db, env, post } = await setup();   // 관리자 로그인
  const mk = async (name, role) => {
    const u = await db.prepare(`INSERT INTO users (username,pass_hash,role,email_verified_at,name,email) VALUES (?,?,?,1,?,?)`).bind(name, await hashPassword('x'), role, name, name + '@willvi.co.kr').run();
    const id = Number(u.meta.last_row_id);
    const sid = await createSession(db, id);
    const call = (p, init = {}) => handleRequest(new Request('https://interview.example.test' + p, { ...init, headers: { cookie: `sid=${sid}`, origin: 'https://interview.example.test', ...(init.headers || {}) } }), env, { waitUntil() {} });
    return { id, call, post: (p, f) => call(p, { method: 'POST', body: new URLSearchParams(f).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } }) };
  };
  const a = await mk('에이', 'member'), b = await mk('비', 'member');
  const save = (name, no, owner) => saveParsed(db, parseAlbamonApply(bodyHtml(name + '(여, 30세)', no)), Date.now(), owner);
  await save('가나다', '900000041', a.id);
  await save('라마바', '900000042', b.id);
  await save('공용사', '900000043', null);
  const seen = async (u) => visible(await (await u.call('/applicants/inbox')).text());
  const ta = await seen(a);
  assert.ok(ta.includes('가나다') && ta.includes('공용사') && !ta.includes('라마바'));
  const tb = await seen(b);
  assert.ok(tb.includes('라마바') && tb.includes('공용사') && !tb.includes('가나다'));
  // 남의 건은 처리할 수 없다
  const idB = (await db.prepare(`SELECT id FROM applicant_inbox WHERE name='라마바'`).first()).id;
  assert.equal((await a.post(`/applicants/inbox/${idB}/ignore`, {})).headers.get('location'), '/applicants/inbox?err=gone');
  // 일반 사용자도 내 연결 키를 만든다
  const html = await (await a.post('/applicants/inbox/agent-token', {})).text();
  assert.match(html, /ag_[0-9a-f]{48}/);
  assert.equal(await hasAgentToken(db, a.id), true);
  assert.equal(await hasAgentToken(db, b.id), false);
});

test('이력서 링크는 알바몬 https 주소만 저장', () => {
  assert.equal(safeResumeUrl('https://www.albamon.com/email-apply-url-route?recruitNo=1&applyNo=2'), 'https://www.albamon.com/email-apply-url-route?recruitNo=1&applyNo=2');
  assert.equal(safeResumeUrl('https://evil.example.com/x'), '');
  assert.equal(safeResumeUrl('https://www.albamon.com.evil.com/x'), '');
  assert.equal(safeResumeUrl('http://www.albamon.com/x'), '');
  assert.equal(safeResumeUrl('javascript:alert(1)'), '');
});
