// 채용 워크플로우: 지원자 → 면접 안내, 일정 고르기, 일정 변경 요청, 전날 리마인드, 답 없으면 한 번 더, 결과 안내 문자
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openSqliteD1 } from '../src/node/d1-sqlite.js';
import { handleRequest } from '../src/worker.js';
import { createSession } from '../src/auth.js';
import { hashPassword, encryptText } from '../src/crypto.js';
import { createCampaign, handleInbound, processQueue, rescheduleCandidate, renderTemplate, SLOT_TEMPLATE } from '../src/core.js';
import { queueAutoReminders, queueFollowups, queueResultMessages, setOutcome } from '../src/reminders.js';
import { parseSlotReply, isRescheduleRequest } from '../src/parser.js';
import { saveApplicant } from '../src/applicants.js';
import { latestStages } from '../src/applicants-link.js';

const KST = 9 * 3600000;
const kst = (y, mo, d, h, mi = 0) => Date.UTC(y, mo - 1, d, h, mi) - KST;
const visible = (html) => html.replace(/<(style|script)[\s\S]*?<\/\1>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

async function setup() {
  const db = openSqliteD1(':memory:', fileURLToPath(new URL('../migrations', import.meta.url)));
  const env = { DB: db, ENCRYPTION_KEY: 'k', PUBLIC_BASE_URL: 'https://example.test', GATEWAY_URL: 'https://sms.example.test/api/3rdparty/v1' };
  const u = await db.prepare(`INSERT INTO users (username,pass_hash,role,email_verified_at,name,email) VALUES ('boss',?,'super',1,'김관리','boss@willvi.co.kr')`).bind(await hashPassword('password123')).run();
  const sid = await createSession(db, Number(u.meta.last_row_id));
  await db.prepare(`INSERT INTO departments (name) VALUES ('인사팀')`).run();
  await db.prepare(`INSERT INTO gateways (department_id,name,username,password,hook_token) VALUES (1,'폰','u',?,'t')`).bind(await encryptText('k', 'pw')).run();
  const ctx = { waitUntil() {} };
  const call = (path, init = {}) => handleRequest(new Request('https://example.test' + path, {
    ...init, headers: { cookie: `sid=${sid}`, origin: 'https://example.test', ...(init.headers || {}) }
  }), env, ctx);
  const post = (path, fields) => call(path, {
    method: 'POST', body: new URLSearchParams(fields).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'manual'
  });
  return { db, env, call, post };
}
const messages = (db) => db.prepare(`SELECT phone, text FROM messages ORDER BY id`).all().then((r) => r.results);
const cand = (db, phone) => db.prepare(`SELECT * FROM candidates WHERE phone=?`).bind(phone).first();

test('일정 고르기 답장 해석', () => {
  assert.deepEqual(parseSlotReply('2번이요', 3), { result: 'attending', slot: 2 });
  assert.deepEqual(parseSlotReply('1 가능합니다', 3), { result: 'attending', slot: 1 });
  assert.deepEqual(parseSlotReply('10/21 14시 2번', 3), { result: 'attending', slot: 2 }); // 날짜·시각 숫자는 번호가 아님
  assert.deepEqual(parseSlotReply('14:00 가능해요', 3).result, 'unclear');
  assert.deepEqual(parseSlotReply('4번', 3), { result: 'unclear' });                   // 없는 번호
  assert.deepEqual(parseSlotReply('2번은 어렵고 1번', 3), { result: 'unclear' });       // 번호 + 부정 → 사람이 확인
  assert.deepEqual(parseSlotReply('1번 2번 다 돼요', 3), { result: 'unclear' });         // 번호 여러 개
  assert.deepEqual(parseSlotReply('불참합니다', 3), { result: 'absent' });
  assert.deepEqual(parseSlotReply('네 알겠습니다', 3), { result: 'unclear', positive: true });
  assert.deepEqual(parseSlotReply('３', 3), { result: 'attending', slot: 3 });           // 전각 숫자
});

test('일정 변경 요청 감지', () => {
  for (const t of ['시간 변경 가능한가요?', '다음주로 미뤄 주실 수 있나요', '다른 날로 바꿀 수 있을까요', '일정 조정 부탁드려요', '연기 가능할까요']) assert.ok(isRescheduleRequest(t), t);
  for (const t of ['참석합니다', '불참', '네', '2번']) assert.ok(!isRescheduleRequest(t), t);
});

test('일정 고르기: 번호 답장 → 일정 확정 + 확정 문자, 같은 번호 다시 오면 다시 보내지 않음', async () => {
  const { db } = await setup();
  const r = await createCampaign(db, { departmentId: 1, gatewayId: 1, name: '고르기', template: '', userId: 1,
    candidates: [{ site: '강남', name: '가나', phone: '010-1111-0001', interview_at: '무시됨' }], slots: ['10/21 14:00', '10/22 10:00'] });
  const camp = await db.prepare(`SELECT * FROM campaigns WHERE id=?`).bind(r.campaignId).first();
  assert.equal(camp.template, SLOT_TEMPLATE);
  assert.match(renderTemplate(camp.template, { name: '가나' }, ['10/21 14:00', '10/22 10:00']), /1\) 10\/21 14:00\n2\) 10\/22 10:00/);
  assert.equal((await cand(db, '01011110001')).interview_at, ''); // 일정은 고를 때 정해진다
  await db.prepare(`UPDATE candidates SET status='sent', sent_at=?`).bind(Date.now()).run();

  const res = await handleInbound(db, 1, { sender: '+821011110001', message: '2번이요' });
  assert.equal(res.result, 'attending');
  const c = await cand(db, '01011110001');
  assert.equal(c.status, 'attending');
  assert.equal(c.interview_at, '10/22 10:00');
  const ms = await messages(db);
  assert.equal(ms.length, 1);
  assert.match(ms[0].text, /가나님, 면접 일정이 10\/22 10:00\(으\)로 정해졌어요/);

  await handleInbound(db, 1, { sender: '01011110001', message: '2' });   // 같은 번호 → 확정 문자 다시 안 감
  await handleInbound(db, 1, { sender: '01011110001', message: '네 감사합니다' }); // 이미 고른 사람의 "네" → 참석 유지
  assert.equal((await messages(db)).length, 1);
  assert.equal((await cand(db, '01011110001')).status, 'attending');
  await handleInbound(db, 1, { sender: '01011110001', message: '1번으로 바꿀게요' }); // 다른 번호 → 일정 변경 + 확정 문자
  assert.equal((await cand(db, '01011110001')).interview_at, '10/21 14:00');
  assert.equal((await messages(db)).length, 2);
});

test('일정 변경 요청 → 표시, 새 일정으로 이 사람에게만 다시 안내', async () => {
  const { db, env } = await setup();
  const r = await createCampaign(db, { departmentId: 1, gatewayId: 1, name: '정해진', template: '{이름} {면접일시}', userId: 1,
    candidates: [{ site: '강남', name: '가', phone: '01011110001', interview_at: '10/21 14:00' }, { site: '강남', name: '나', phone: '01011110002', interview_at: '10/21 14:00' }] });
  await db.prepare(`UPDATE candidates SET status='sent', sent_at=?`).bind(Date.now()).run();
  await db.prepare(`UPDATE campaigns SET status='done'`).run();
  await handleInbound(db, 1, { sender: '01011110002', message: '죄송한데 다음주로 미룰 수 있을까요' });
  const n = await cand(db, '01011110002');
  assert.equal(n.status, 'unclear'); // "죄송"이 있어도 변경 요청이면 불참이 아니라 확인 필요
  assert.equal(n.reply_kind, 'reschedule');
  await handleInbound(db, 1, { sender: '01011110001', message: '다른 날로 변경 가능한가요?' });
  let c = await cand(db, '01011110001');
  assert.equal(c.status, 'unclear');
  assert.equal(c.reply_kind, 'reschedule');

  const camp = await db.prepare(`SELECT * FROM campaigns WHERE id=?`).bind(r.campaignId).first();
  assert.equal(await rescheduleCandidate(db, camp, c.id, '10/24 15:00'), 'queued');
  c = await cand(db, '01011110001');
  assert.equal(c.status, 'pending');
  assert.equal(c.interview_at, '10/24 15:00');
  assert.equal(c.reply_kind, '');
  const sent = [];
  await processQueue(env, { send: async (gw, phone, text) => { sent.push([phone, text]); return { id: 'm1' }; } });
  assert.equal(sent.length, 1);                                  // 다른 사람에게는 다시 가지 않음
  assert.equal(sent[0][0], '01011110001');
  assert.match(sent[0][1], /다시 안내드립니다[\s\S]*10\/24 15:00/);
  assert.equal(await rescheduleCandidate(db, camp, c.id, ''), 'invalid');
});

test('전날 리마인드: 전날 17시~자정, 당일 리마인드와 따로 한 번씩', async () => {
  const { db } = await setup();
  await createCampaign(db, { departmentId: 1, gatewayId: 1, name: 't', template: '{이름}', userId: 1, autoRemind: true, remindPrev: true,
    candidates: [{ site: '강남', name: '가', phone: '01011110001', interview_at: '10/21 14:00' }] });
  await db.prepare(`UPDATE candidates SET status='attending'`).run();
  assert.equal(await queueAutoReminders(db, kst(2026, 10, 20, 16, 59)), 0);
  assert.equal(await queueAutoReminders(db, kst(2026, 10, 20, 17, 0)), 1);
  assert.equal(await queueAutoReminders(db, kst(2026, 10, 20, 18, 0)), 0); // 한 번만
  assert.match((await messages(db))[0].text, /내일 10\/21 14:00 면접/);
  assert.equal(await queueAutoReminders(db, kst(2026, 10, 21, 8, 0)), 1); // 당일 리마인드는 따로
  assert.match((await messages(db))[1].text, /오늘 10\/21 14:00 면접/);
});

test('전날 리마인드만 켠 경우 당일에는 보내지 않음, 끈 안내에는 전날도 안 보냄', async () => {
  const { db } = await setup();
  await createCampaign(db, { departmentId: 1, gatewayId: 1, name: 'a', template: '{이름}', userId: 1, remindPrev: true,
    candidates: [{ site: '강남', name: '가', phone: '01011110001', interview_at: '10/21 14:00' }] });
  await createCampaign(db, { departmentId: 1, gatewayId: 1, name: 'b', template: '{이름}', userId: 1,
    candidates: [{ site: '강남', name: '나', phone: '01011110002', interview_at: '10/21 14:00' }] });
  await db.prepare(`UPDATE candidates SET status='attending'`).run();
  assert.equal(await queueAutoReminders(db, kst(2026, 10, 20, 17, 30)), 1);
  assert.equal(await queueAutoReminders(db, kst(2026, 10, 21, 9, 0)), 0);
});

test('답 없으면 한 번 더: 하루 뒤, 면접이 가까우면 3시간 전, 한 번만, 밤에는 안 보냄', async () => {
  const { db, env } = await setup();
  await createCampaign(db, { departmentId: 1, gatewayId: 1, name: 'f', template: '{이름} 안내', userId: 1, autoFollowup: true,
    candidates: [
      { site: '강남', name: '먼날', phone: '01011110001', interview_at: '10/25 14:00' },
      { site: '강남', name: '가까움', phone: '01011110002', interview_at: '10/21 18:00' },
      { site: '강남', name: '답함', phone: '01011110003', interview_at: '10/25 14:00' }] });
  const sentAt = kst(2026, 10, 20, 10, 0);
  await db.prepare(`UPDATE candidates SET status='sent', sent_at=?`).bind(sentAt).run();
  await db.prepare(`UPDATE candidates SET status='attending' WHERE name='답함'`).run();
  await db.prepare(`UPDATE campaigns SET status='done'`).run();
  assert.equal(await queueFollowups(db, kst(2026, 10, 20, 15, 0)), 0);     // 아직 이름
  assert.equal(await queueFollowups(db, kst(2026, 10, 21, 8, 0)), 0);      // 밤·이른 아침에는 안 보냄
  assert.equal(await queueFollowups(db, kst(2026, 10, 21, 10, 0)), 2);     // 24시간 지남(가까운 면접도 3시간 전 이전이라 함께)
  assert.equal((await db.prepare(`SELECT status FROM campaigns`).first()).status, 'sending');
  const sent = [];
  await processQueue(env, { send: async (gw, phone) => { sent.push(phone); return { id: 'x' }; } });
  assert.deepEqual(sent.sort(), ['01011110001', '01011110002']);
  assert.equal(await queueFollowups(db, kst(2026, 10, 22, 12, 0)), 0);     // 한 번만
});

test('답 없으면 한 번 더: 면접이 3시간 안이면 보낸 지 2시간 뒤, 면접 1시간 전부터는 안 보냄', async () => {
  const { db } = await setup();
  await createCampaign(db, { departmentId: 1, gatewayId: 1, name: 'f', template: '{이름}', userId: 1, autoFollowup: true,
    candidates: [{ site: '강남', name: '오늘', phone: '01011110001', interview_at: '10/20 15:00' }] });
  await db.prepare(`UPDATE candidates SET status='sent', sent_at=?`).bind(kst(2026, 10, 20, 10, 0)).run();
  await db.prepare(`UPDATE campaigns SET status='done'`).run();
  assert.equal(await queueFollowups(db, kst(2026, 10, 20, 11, 30)), 0);   // 2시간 전
  assert.equal(await queueFollowups(db, kst(2026, 10, 20, 14, 10)), 0);   // 면접 1시간 안
  assert.equal(await queueFollowups(db, kst(2026, 10, 20, 12, 0)), 1);    // max(10+2, 15-3)=12시
});

test('결과 안내 문자: 결과를 기록한 사람에게 한 번만', async () => {
  const { db } = await setup();
  const r = await createCampaign(db, { departmentId: 1, gatewayId: 1, name: 'r', template: '{이름}', userId: 1,
    candidates: [{ site: '강남', name: '합', phone: '01011110001' }, { site: '강남', name: '불', phone: '01011110002' }] });
  const ids = (await db.prepare(`SELECT id FROM candidates ORDER BY id`).all()).results.map((x) => x.id);
  await setOutcome(db, ids[0], 'passed');
  await setOutcome(db, ids[1], 'rejected');
  const camp = await db.prepare(`SELECT * FROM campaigns WHERE id=?`).bind(r.campaignId).first();
  assert.equal(await queueResultMessages(db, camp, 'passed', ''), 1);
  assert.equal(await queueResultMessages(db, camp, 'passed', ''), 0);
  assert.equal(await queueResultMessages(db, camp, 'rejected', '{이름}님 결과 안내'), 1);
  assert.equal(await queueResultMessages(db, camp, 'nope', ''), 0);
  const ms = await messages(db);
  assert.match(ms[0].text, /합님[\s\S]*합격/);
  assert.equal(ms[1].text, '불님 결과 안내');
});

test('지원자 진행 단계: 가장 최근 면접 안내의 결과 → 답장 순', async () => {
  const { db } = await setup();
  await createCampaign(db, { departmentId: 1, gatewayId: 1, name: '1', template: '{이름}', userId: 1, candidates: [{ site: 's', name: '가', phone: '01011110001', interview_at: '10/21 14:00' }] });
  await createCampaign(db, { departmentId: 1, gatewayId: 1, name: '2', template: '{이름}', userId: 1, candidates: [{ site: 's', name: '가', phone: '01011110001', interview_at: '10/28 14:00' }] });
  await db.prepare(`UPDATE candidates SET status='attending' WHERE campaign_id=2`).run();
  let st = await latestStages(db, ['01011110001', '01099999999'], { role: 'super' });
  assert.equal(st.get('01011110001').label, '참석 예정');
  assert.equal(st.get('01011110001').interviewAt, '10/28 14:00');
  assert.equal(st.get('01099999999'), undefined);
  await db.prepare(`UPDATE candidates SET outcome='noshow' WHERE campaign_id=2`).run();
  st = await latestStages(db, ['01011110001'], { role: 'super' });
  assert.equal(st.get('01011110001').label, '노쇼');
  // 다른 부서 담당자에게는 보이지 않음
  st = await latestStages(db, ['01011110001'], { role: 'admin', departments: [99] });
  assert.equal(st.size, 0);
});

test('화면: 지원자 선택 → 면접 안내 만들기(명단 채움) → 일정 고르기로 만들기 → 상세', async () => {
  const { db, call, post } = await setup();
  const a = await saveApplicant(db, { name: '홍길동', phone: '010-1234-5678', applied_to: '아마노코리아(현장HR)' }, 1, 'manual');
  const b = await saveApplicant(db, { name: '김영희', phone: '010-2345-6789' }, 1, 'manual');
  const aid = a.applicantId ?? a.id, bid = b.applicantId ?? b.id;

  const list = visible(await (await call('/applicants')).text());
  assert.match(list, /면접 안내 전/);
  assert.match(await (await call('/applicants')).text(), /<option value="interview">면접 안내 만들기<\/option>/);

  const go = await post('/applicants/bulk-action', { op: 'interview', ids: String(aid), back: '/applicants' });
  assert.equal(go.status, 303);
  assert.equal(go.headers.get('location'), `/campaigns/new?ids=${aid}`);

  const form = await (await call(`/campaigns/new?ids=${aid},${bid}`)).text();
  assert.match(visible(form), /지원자 관리에서 고른 2명을 명단에 채웠어요/);
  assert.match(visible(form), /1명은 원가중심점이 없어요/);
  const ta = form.match(/id="csv"[^>]*>([^<]*)</)[1];
  assert.equal(ta, '사업장\t이름\t전화번호\t면접일시\n\t김영희\t01023456789\t\n아마노코리아(현장HR)\t홍길동\t01012345678\t');
  assert.match(form, /name="mode" value="many" checked/);

  // 정해진 일시 + 모두 같은 면접일시
  const csv = `사업장\t이름\t전화번호\t면접일시\n아마노코리아(현장HR)\t홍길동\t01012345678\t\n\t김영희\t01023456789\t10/22 10:00`;
  const made = await post('/campaigns/new', { mode: 'many', csv, default_site: '본사', default_when: '10/21 14:00', kind: 'fixed', template: '{이름} {면접일시}', gateway_id: '1', send_mode: 'manual', remind_prev: '1', auto_followup: '1' });
  assert.equal(made.status, 200);
  const k1 = await db.prepare(`SELECT * FROM campaigns ORDER BY id DESC`).first();
  assert.equal(k1.remind_prev, 1); assert.equal(k1.auto_followup, 1); assert.equal(k1.auto_remind, 0);
  const rows = (await db.prepare(`SELECT name, site, interview_at FROM candidates WHERE campaign_id=? ORDER BY name`).bind(k1.id).all()).results.map((x) => ({ ...x }));
  assert.deepEqual(rows, [{ name: '김영희', site: '본사', interview_at: '10/22 10:00' }, { name: '홍길동', site: '아마노코리아(현장HR)', interview_at: '10/21 14:00' }]);

  // 일정 고르기
  const bad = await post('/campaigns/new', { mode: 'many', csv, default_site: '본사', kind: 'slots', slots: '', template: '', gateway_id: '1', send_mode: 'manual' });
  assert.equal(bad.status, 400);
  await post('/campaigns/new', { mode: 'many', csv, default_site: '본사', kind: 'slots', slots: '10/21 14:00\n10/22 10:00\n', template: SLOT_TEMPLATE, gateway_id: '1', send_mode: 'manual' });
  const k2 = await db.prepare(`SELECT * FROM campaigns ORDER BY id DESC`).first();
  assert.equal(k2.slots, '10/21 14:00\n10/22 10:00');
  const detail = visible(await (await call(`/campaigns/${k2.id}`)).text());
  assert.match(detail, /일정별 확정 인원/);
  assert.match(detail, /1\) 10\/21 14:00 0명/);
  assert.match(detail, /자동으로 보내는 문자/);
  assert.match(detail, /1\) 10\/21 14:00/); // 미리보기에 번호 붙은 일정

  // 담당자가 직접 일정 정하기
  const c = await db.prepare(`SELECT id FROM candidates WHERE campaign_id=? ORDER BY id LIMIT 1`).bind(k2.id).first();
  await post(`/campaigns/${k2.id}/slot`, { id: String(c.id), slot: '2' });
  const after = await db.prepare(`SELECT status, interview_at, manual FROM candidates WHERE id=?`).bind(c.id).first();
  assert.deepEqual({ ...after }, { status: 'attending', interview_at: '10/22 10:00', manual: 1 });
  assert.match(visible(await (await call(`/campaigns/${k2.id}`)).text()), /2\) 10\/22 10:00 1명/);

  // 토글
  await post(`/campaigns/${k2.id}/followup`, { on: '1' });
  assert.equal((await db.prepare(`SELECT auto_followup FROM campaigns WHERE id=?`).bind(k2.id).first()).auto_followup, 1);

  // 지원자 상세에 진행 단계 + 면접 안내 만들기 버튼
  const pd = await (await call(`/applicants/${aid}`)).text();
  assert.match(pd, new RegExp(`/campaigns/new\\?ids=${aid}`));
});

test('화면: 결과 안내 문자 보내기', async () => {
  const { db, post, call } = await setup();
  const r = await createCampaign(db, { departmentId: 1, gatewayId: 1, name: 'r', template: '{이름}', userId: 1,
    candidates: [{ site: '강남', name: '합', phone: '01011110001' }] });
  await db.prepare(`UPDATE campaigns SET status='done'`).run();
  const id = (await db.prepare(`SELECT id FROM candidates`).first()).id;
  await setOutcome(db, id, 'passed');
  assert.match(visible(await (await call(`/campaigns/${r.campaignId}`)).text()), /합격 1명 에게 보내기/);
  const res = await post(`/campaigns/${r.campaignId}/result`, { outcome: 'passed', template: '' });
  assert.equal(res.headers.get('location'), `/campaigns/${r.campaignId}?ok=result&n=1`);
  assert.equal((await messages(db)).length, 1);
  const html = visible(await (await call(`/campaigns/${r.campaignId}?ok=result&n=1`)).text());
  assert.match(html, /1명에게 결과 안내 문자를 보내요/);
  assert.doesNotMatch(html, /합격 1명 에게 보내기/);
});

test('화면 스크립트 문법 오류 없음 (만들기·상세·지원자)', async () => {
  const { db, call } = await setup();
  const a = await saveApplicant(db, { name: '홍길동', phone: '010-1234-5678' }, 1, 'manual');
  const r = await createCampaign(db, { departmentId: 1, gatewayId: 1, name: 's', template: '', userId: 1, slots: ['10/21 14:00'],
    candidates: [{ site: '강남', name: '가', phone: '01011110001' }] });
  for (const p of ['/campaigns/new', `/campaigns/new?ids=${a.id}`, `/campaigns/${r.campaignId}`, '/applicants', `/applicants/${a.id}`]) {
    const html = await (await call(p)).text();
    for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new Function(m[1]), p);
  }
});

test('되돌아온 문자(폰 자기 번호로 보낸 문자)는 답장으로 보지 않음', async () => {
  const { db } = await setup();
  await createCampaign(db, { departmentId: 1, gatewayId: 1, name: 'e', template: '{이름}님\n참석/불참 답장', userId: 1,
    candidates: [{ site: '강남', name: '나', phone: '01011110001', interview_at: '10/21 14:00' }] });
  await db.prepare(`UPDATE candidates SET status='sent', sent_at=?, message_text=?`).bind(Date.now(), '나님\n참석/불참 답장').run();
  const r = await handleInbound(db, 1, { sender: '+821011110001', message: '나님\r\n참석/불참 답장' });
  assert.equal(r.echo, true);
  assert.equal((await cand(db, '01011110001')).status, 'sent');
  // 확정 문자 같은 직접 문자도 되돌아오면 무시
  await db.prepare(`INSERT INTO messages (gateway_id,phone,text,status,at) VALUES (1,'01011110001','일정이 정해졌어요. 어려우면 "불참"','sent',?)`).bind(Date.now()).run();
  assert.equal((await handleInbound(db, 1, { sender: '01011110001', message: '일정이 정해졌어요. 어려우면 "불참"' })).echo, true);
  assert.equal((await handleInbound(db, 1, { sender: '01011110001', message: '참석' })).result, 'attending');
  assert.equal((await db.prepare(`SELECT result FROM inbound ORDER BY id LIMIT 1`).first()).result, 'echo');
});

test('새 지원: PC 크롬(확장)이 꺼져 연락처 요청이 멈추면 홈·새 지원에 할 일로 알린다', async () => {
  const { db, call } = await setup();
  const ins = (no, name, phone, state) => db.prepare(`INSERT INTO applicant_inbox (source, apply_no, recruit_no, company, job_title, name, received_at, status, phone, fetch_state, resume_url, owner_user_id)
    VALUES ('albamon',?, '1','회사','공고',?,?,'pending',?,?,'https://www.albamon.com/x',1)`).bind(no, name, Date.now(), phone, state).run();
  await ins('1', '가', '', 'requested'); await ins('2', '나', '', 'requested'); await ins('3', '다', '01011112222', 'done'); await ins('4', '라', '', '');
  // 확장이 2시간 전에 마지막으로 접속
  await db.prepare(`INSERT INTO agent_tokens (user_id, token_hash, created_at, last_used_at) VALUES (1,'h',1,?)`).bind(Date.now() - 2 * 3600e3).run();
  let home = visible(await (await call('/')).text());
  assert.match(home, /1 등록할 수 있는 새 지원/);
  assert.match(home, /2 연락처를 기다리는 새 지원 확장 프로그램이 깔린 PC 크롬이 꺼져 있어요\(마지막 연결 2시간 전\)/);
  assert.match(home, /1 그 밖의 새 지원/);
  let inbox = visible(await (await call('/applicants/inbox')).text());
  assert.match(inbox, /연락처 요청 2건이 기다리고 있어요/);
  assert.match(inbox, /PC 크롬을 기다려요/);
  // 방금 접속했으면 멈춘 게 아니다
  await db.prepare(`UPDATE agent_tokens SET last_used_at=?`).bind(Date.now()).run();
  home = visible(await (await call('/')).text());
  assert.doesNotMatch(home, /연락처를 기다리는 새 지원/);
  assert.match(home, /3 그 밖의 새 지원/);
  inbox = visible(await (await call('/applicants/inbox')).text());
  assert.doesNotMatch(inbox, /기다리고 있어요/);
  assert.match(inbox, /가져오는 중…/);
});
