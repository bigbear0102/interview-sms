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
