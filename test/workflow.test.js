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
  // 배열 값은 화면의 체크칸처럼 같은 이름으로 여러 번 보낸다(ids=1&ids=2…)
  const post = (path, fields) => {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(fields)) for (const x of [].concat(v)) body.append(k, String(x));
    return call(path, { method: 'POST', body: body.toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });
  };
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

test('오늘 면접: 오늘 면접일시인 사람을 모아 출석·노쇼 기록, 홈 할 일, 문자함에 이름 표시', async () => {
  const { db, call, post } = await setup();
  const now = Date.now();
  const d = new Date(now + 9 * 3600e3);
  const today = `${d.getUTCMonth() + 1}/${d.getUTCDate()} 23:50`;
  const tomorrow = new Date(now + 9 * 3600e3 + 86400e3);
  const tmr = `${tomorrow.getUTCMonth() + 1}/${tomorrow.getUTCDate()} 10:00`;
  await createCampaign(db, { departmentId: 1, gatewayId: 1, name: '오늘 안내', template: '{이름}', userId: 1, candidates: [
    { site: '강남', name: '오늘참석', phone: '01011110001', interview_at: today },
    { site: '강남', name: '오늘무응답', phone: '01011110002', interview_at: today },
    { site: '강남', name: '내일참석', phone: '01011110003', interview_at: tmr },
    { site: '강남', name: '오늘불참', phone: '01011110004', interview_at: today }] });
  await db.prepare(`UPDATE campaigns SET status='done'`).run();
  await db.prepare(`UPDATE candidates SET status='attending', sent_at=? WHERE name IN ('오늘참석','내일참석')`).bind(now).run();
  await db.prepare(`UPDATE candidates SET status='sent', sent_at=? WHERE name='오늘무응답'`).bind(now).run();
  await db.prepare(`UPDATE candidates SET status='absent', sent_at=? WHERE name='오늘불참'`).bind(now).run();

  let page = visible(await (await call('/interviews/today')).text());
  assert.match(page, /오늘 면접/);
  assert.match(page, /23:50 오늘참석/);
  assert.match(page, /참석 답장은 없지만 이날 면접인 사람 1명[\s\S]*오늘무응답/);
  assert.doesNotMatch(page, /내일참석|오늘불참/);
  assert.match(page, /참석 예정 1명 · 기록 0명/);
  let home = visible(await (await call('/')).text());
  assert.match(home, /1 오늘 면접 출석·노쇼 기록이 1명 남았어요/);

  const id = (await cand(db, '01011110001')).id;
  const r = await post('/interviews/outcome', { id, outcome: 'showed' });
  assert.equal(r.status, 303);
  assert.equal((await cand(db, '01011110001')).outcome, 'showed');
  page = visible(await (await call('/interviews/today')).text());
  assert.match(page, /참석 예정 1명 · 기록 1명/);
  home = visible(await (await call('/')).text());
  assert.match(home, /오늘 면접 모두 기록했어요/);
  await post('/interviews/outcome', { id, outcome: '' });           // 다시 누르면 기록 지움
  assert.equal((await cand(db, '01011110001')).outcome, '');
  assert.equal((await post('/interviews/outcome', { id, outcome: 'nope' })).status, 303);
  assert.equal((await cand(db, '01011110001')).outcome, '');

  // 내일로 넘겨 보기
  const tk = new Date(now + 9 * 3600e3 + 86400e3).toISOString().slice(0, 10);
  assert.match(visible(await (await call(`/interviews/today?d=${tk}`)).text()), /내일참석/);

  // 문자함: 번호 대신 이름과 면접 안내
  await handleInbound(db, 1, { sender: '01011110003', message: '네 갈게요' });
  const box = visible(await (await call('/messages')).text());
  assert.match(box, /내일참석 010-1111-0003/);
  assert.match(box, /오늘 안내/);
});

test('D1 값 100개 제한: 새 지원 "전체 선택" 150건 일괄 처리, 문자함 이름 표시가 나눠서 동작', async () => {
  const { db, call, post } = await setup();
  const ids = [];
  for (let i = 0; i < 150; i++) {
    const r = await db.prepare(`INSERT INTO applicant_inbox (source, apply_no, recruit_no, company, job_title, name, received_at, status, resume_url, owner_user_id)
      VALUES ('albamon',?, '1','회사','공고',?,?,'pending','https://www.albamon.com/x',1)`).bind(String(i), '지원' + i, Date.now()).run();
    ids.push(Number(r.meta.last_row_id));
  }
  const r1 = await post('/applicants/inbox/bulk', { op: 'fetch', ids });
  assert.equal(r1.status, 303);
  assert.equal(r1.headers.get('location'), '/applicants/inbox?ok=fetchall&n=150');
  const r2 = await post('/applicants/inbox/bulk', { op: 'ignore', ids });
  assert.match(r2.headers.get('location'), /n=150/);
  assert.equal((await db.prepare(`SELECT COUNT(*) n FROM applicant_inbox WHERE status='ignored'`).first()).n, 150);
  // 문자함: 서로 다른 번호 120개
  for (let i = 0; i < 120; i++) await db.prepare(`INSERT INTO inbound (gateway_id,sender,message,received_at,result) VALUES (1,?,?,?,'unmatched')`).bind('0101234' + String(1000 + i), 'hi', Date.now()).run();
  assert.equal((await call('/messages')).status, 200);
  assert.throws(() => db.prepare('SELECT 1').bind(...new Array(101).fill(1)), /too many SQL variables/);
});

test('직접 정한 사람의 취소·변경 답장은 확인 필요로 올라온다(그 밖의 답장은 원문만)', async () => {
  const { db } = await setup();
  await createCampaign(db, { departmentId: 1, gatewayId: 1, name: 'm', template: '{이름}', userId: 1,
    candidates: [{ site: 's', name: '가', phone: '01011110001', interview_at: '10/21 14:00' }] });
  await db.prepare(`UPDATE candidates SET status='attending', manual=1, sent_at=?`).bind(Date.now()).run();
  await handleInbound(db, 1, { sender: '01011110001', message: '네 감사합니다' });
  assert.equal((await cand(db, '01011110001')).status, 'attending');
  await handleInbound(db, 1, { sender: '01011110001', message: '죄송해요 못 갈 것 같아요' });
  const c = await cand(db, '01011110001');
  assert.equal(c.status, 'unclear');
  assert.equal(c.manual, 0);
});

test('QC: 일괄 등록은 한 번에 100명(나머지는 다시), 읽을 수 없는 면접일시는 올린 직후 경고, 다시 안내 일시 검사', async () => {
  const { db, call, post } = await setup();
  const ids = [];
  for (let i = 0; i < 120; i++) {
    const r = await db.prepare(`INSERT INTO applicant_inbox (source, apply_no, recruit_no, company, job_title, name, received_at, status, phone, owner_user_id)
      VALUES ('albamon',?, '1','회사','공고',?,?,'pending',?,1)`).bind(String(i), '지원' + i, Date.now(), '0105' + String(1000000 + i).slice(1)).run();
    ids.push(Number(r.meta.last_row_id));
  }
  const reg = await post('/applicants/inbox/bulk', { op: 'register', ids });
  assert.match(reg.headers.get('location'), /n=100&s=0&later=20$/);
  assert.match(visible(await (await call(reg.headers.get('location'))).text()), /남은 20명은 한 번 더 눌러 주세요/);
  const reg2 = await post('/applicants/inbox/bulk', { op: 'register', ids });
  assert.match(reg2.headers.get('location'), /n=20/);
  assert.equal((await db.prepare(`SELECT COUNT(*) n FROM applicant_inbox WHERE status='registered'`).first()).n, 120);

  const made = visible(await (await post('/campaigns/new', { mode: 'many', csv: '사업장\t이름\t전화번호\t면접일시\nA\t가\t01011110001\t10/21 14:00\nA\t나\t01011110002\t다음 주 화요일', kind: 'fixed', template: '{이름}', gateway_id: '1', send_mode: 'manual', auto_remind: '1' })).text());
  assert.match(made, /1명은 면접일시를 읽을 수 없어 자동 알림이 가지 않아요[\s\S]*나/);
  const slot = visible(await (await post('/campaigns/new', { mode: 'many', csv: '사업장\t이름\t전화번호\nA\t가\t01011110001', kind: 'slots', slots: '10/22 14:00\n화요일 오후', template: '', gateway_id: '1', send_mode: 'manual', remind_prev: '1' })).text());
  assert.match(slot, /일정 1개은 면접일시를 읽을 수 없어/);

  const k = await db.prepare(`SELECT id FROM campaigns ORDER BY id LIMIT 1`).first();
  await db.prepare(`UPDATE campaigns SET status='done' WHERE id=?`).bind(k.id).run();
  await db.prepare(`UPDATE candidates SET status='unclear', sent_at=? WHERE campaign_id=?`).bind(Date.now(), k.id).run();
  const c = await db.prepare(`SELECT id FROM candidates WHERE campaign_id=? LIMIT 1`).bind(k.id).first();
  const bad = await post(`/campaigns/${k.id}/reschedule`, { id: c.id, when: '다음 주쯤' });
  assert.match(bad.headers.get('location'), /err=when/);
  assert.equal((await db.prepare(`SELECT status FROM candidates WHERE id=?`).bind(c.id).first()).status, 'unclear');
  assert.match(visible(await (await call(`/campaigns/${k.id}?err=when`)).text()), /새 면접일시를 읽을 수 없어요/);
});

test('QC: 발송 처리 중(sending)에 온 아주 빠른 답장도 반영되고, 발송 완료 기록이 덮어쓰지 않는다', async () => {
  const { db, env } = await setup();
  await createCampaign(db, { departmentId: 1, gatewayId: 1, name: 'fast', template: '{이름}', userId: 1,
    candidates: [{ site: 's', name: '빠름', phone: '01011110001', interview_at: '10/21 14:00' }] });
  await db.prepare(`UPDATE campaigns SET status='scheduled', scheduled_at=?`).bind(Date.now() - 1000).run();
  await processQueue(env, { send: async () => {
    // 보내는 도중(배치 기록 전) 답장 도착
    const r = await handleInbound(db, 1, { sender: '01011110001', message: '참석합니다' });
    assert.equal(r.result, 'attending');
    return { id: 'g1' };
  } });
  const c = await cand(db, '01011110001');
  assert.equal(c.status, 'attending');
  assert.equal(c.gw_msg_id, 'g1');
});

test('알바몬 계정 여러 개는 꺼져 있다(문자 2차 인증 때문에): 화면·관리 주소·확장용 목록 모두 동작 안 함', async () => {
  const { db, env, call, post } = await setup();
  const { createAgentToken } = await import('../src/mail-intake.js');
  assert.doesNotMatch(visible(await (await call('/applicants/inbox/connect')).text()), /알바몬 계정 관리자/);
  await post('/applicants/inbox/albamon-account', { label: 'x', login_id: 'corpA', pw: 'p' });
  assert.equal((await db.prepare(`SELECT COUNT(*) n FROM albamon_accounts`).first()).n, 0);
  const key = await createAgentToken(db, 1);
  const r = await (await handleRequest(new Request('https://example.test/api/agent/albamon-accounts', { headers: { authorization: 'Bearer ' + key } }), env, { waitUntil() {} })).json();
  assert.equal(r.allowed, false);
});

test('알바몬 계정 여러 개(켰을 때): 관리자 등록(암호화), 관리자 확장만 비밀번호 받음, 요청 중복 방지, 공고→계정 학습', { skip: !(await import('../src/albamon-accounts.js')).MULTI_ACCOUNT_ENABLED }, async () => {
  const { db, env, call, post } = await setup();
  const { createAgentToken } = await import('../src/mail-intake.js');
  // 관리자 화면에서 계정 2개 등록
  assert.match((await post('/applicants/inbox/albamon-account', { label: '현장HR', login_id: 'corpA', pw: 'pwA!1' })).headers.get('location'), /ok=am_saved/);
  await post('/applicants/inbox/albamon-account', { label: '파견', login_id: 'corpB', pw: 'pwB!2' });
  assert.match((await post('/applicants/inbox/albamon-account', { label: '중복', login_id: 'corpA', pw: 'x' })).headers.get('location'), /err=am_dup/);
  const raw = await db.prepare(`SELECT pw_enc FROM albamon_accounts WHERE login_id='corpA'`).first();
  assert.match(raw.pw_enc, /^enc\$/);                                       // 평문 저장 금지
  const page = visible(await (await call('/applicants/inbox/connect')).text());
  assert.match(page, /알바몬 계정 관리자 · 2개/);
  assert.doesNotMatch(await (await call('/applicants/inbox/connect')).text(), /pwA!1/);   // 화면에 비밀번호 없음

  // 일반 사용자 + 그 사람의 확장
  await db.prepare(`INSERT INTO users (username,pass_hash,role,email_verified_at,name,email) VALUES ('staff','x','admin',1,'담당','s@willvi.co.kr')`).run();
  const adminKey = await createAgentToken(db, 1);
  const staffKey = await createAgentToken(db, 2);
  const agent = (key, path, init = {}) => handleRequest(new Request('https://example.test' + path, { ...init, headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' } }), env, { waitUntil() {} });
  const a1 = await (await agent(adminKey, '/api/agent/albamon-accounts')).json();
  assert.equal(a1.allowed, true);
  assert.deepEqual(a1.accounts.map((x) => [x.login_id, x.pw]), [['corpA', 'pwA!1'], ['corpB', 'pwB!2']]);
  const s1 = await (await agent(staffKey, '/api/agent/albamon-accounts')).json();
  assert.equal(s1.allowed, false);
  assert.equal(s1.accounts.length, 0);                                          // 일반 담당자 확장은 비밀번호를 못 받음

  // 담당자(2) 건 3개, 같은 공고 2개
  for (const [no, rn] of [['1', 'R1'], ['2', 'R1'], ['3', 'R2']]) {
    await db.prepare(`INSERT INTO applicant_inbox (source, apply_no, recruit_no, company, job_title, name, received_at, status, fetch_state, resume_url, owner_user_id)
      VALUES ('albamon',?,?,'회사','공고',?,?,'pending','requested','https://www.albamon.com/x',2)`).bind(no, rn, '사람' + no, Date.now()).run();
  }
  // 관리자 확장은 all=1 로 모든 담당자 건을 가져가고, 가져간 건은 3분 동안 다른 확장이 못 가져감
  const q1 = await (await agent(adminKey, '/api/agent/inbox?limit=2&all=1')).json();
  assert.deepEqual(q1.items.map((x) => x.apply_no), ['1', '2']);
  const q2 = await (await agent(staffKey, '/api/agent/inbox?limit=5')).json();
  assert.deepEqual(q2.items.map((x) => x.apply_no), ['3']);
  const q3 = await (await agent(staffKey, '/api/agent/inbox?limit=5')).json();
  assert.equal(q3.items.length, 0);
  // 결과: corpB(id 2)로 열림 → 공고 R1 은 계정 2 로 학습, 다음 요청에 힌트로 붙음
  await agent(adminKey, `/api/agent/inbox/${q1.items[0].id}/result`, { method: 'POST', body: JSON.stringify({ ok: true, phone: '01012345678', account_id: 2 }) });
  const learned = await db.prepare(`SELECT account_id FROM recruit_accounts WHERE recruit_no='R1'`).first();
  assert.equal(learned.account_id, 2);
  await db.prepare(`UPDATE applicant_inbox SET fetch_at=NULL WHERE apply_no='2'`).run();
  const q4 = await (await agent(adminKey, '/api/agent/inbox?limit=5&all=1')).json();
  assert.equal(q4.items.find((x) => x.apply_no === '2').account_id, 2);
  assert.match(visible(await (await call('/applicants/inbox/connect')).text()), /파견 corpB[\s\S]*마지막 성공[\s\S]*연결된 공고 1개/);
  // 로그인 실패 기록
  await agent(adminKey, '/api/agent/albamon-status', { method: 'POST', body: JSON.stringify({ account_id: 1, error: '알바몬 로그인 실패(아이디·비밀번호 확인)' }) });
  assert.match(visible(await (await call('/applicants/inbox/connect')).text()), /현장HR corpA 알바몬 로그인 실패/);
});

test('그룹웨어 직접 연결: 가짜 그룹웨어로 로그인→메일 세션→알바몬 메일만 새 지원으로, 세션 재사용, 틀린 비밀번호는 쉼', async () => {
  const http = await import('node:http');
  const { scanGwAccount, saveGwAccount, CookieJar } = await import('../src/groupware.js');
  const { db, env, call } = await setup();
  const html = (name, apply) => `<table><tr><th>공고번호</th><td>555</td></tr><tr><th>이름</th><td>${name}</td></tr><tr><th>근무회사명</th><td>회사</td></tr></table><a href="https://www.albamon.com/email-apply-url-route?recruitNo=555&amp;applyNo=${apply}">이력서 보기</a>`;
  const mails = [{ mailId: 'm1', mailboxId: 'b', body: html('김하나', 9001) }, { mailId: 'm2', mailboxId: 'b', body: html('이두리', 9002) }];
  const log = { logins: 0, views: 0 };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'); const ck = req.headers.cookie || '';
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      const j = (o, extra = {}) => { res.writeHead(200, { 'Content-Type': 'application/json', ...extra }); res.end(JSON.stringify(o)); };
      if (u.pathname === '/gw/sub/common/login/cmmLogin.do') { res.writeHead(200, { 'Set-Cookie': 'JSESSIONID=gwpre; Path=/gw' }); return res.end('login'); }
      if (u.pathname === '/gw/data/common/login/selectDepartmentList.do') return j([{ deptId: 'D1', reprsntDeptYn: 'Y' }]);
      if (u.pathname === '/gw/data/common/login/selectLoginFlag.do') {
        const p = JSON.parse(b);
        if (p.userId === 'bigbear' && p.pwd === 'Gw!Secret#771' && p.deptId === 'D1') { log.logins++; return j({ resultCode: 0, mainUrl: '/main.do' }, { 'Set-Cookie': 'SSO=tok; Path=/' }); }
        return j({ resultCode: -20, nowErrorCnt: 1, limitErrorCnt: 5 });
      }
      if (u.pathname === '/gw/main.do') { res.writeHead(200); return res.end('main'); }
      if (u.pathname === '/mail/link/emlMail/emlMailMain.do') {
        if (!ck.includes('SSO=tok')) { res.writeHead(302, { Location: '/gw/sub/common/login/cmmLogin.do' }); return res.end(); }
        res.writeHead(200, { 'Set-Cookie': 'JSESSIONID=mail1; Path=/mail' }); return res.end('mail');
      }
      if (!ck.includes('JSESSIONID=mail1')) { res.writeHead(302, { Location: '/gw/sub/common/login/cmmLogin.do' }); return res.end(); }
      if (u.pathname === '/mail/data/emlMail/selectMailList.do') { const p = JSON.parse(b); return j({ totalCount: mails.length, mailList: p.keyword === 'mailmaster@albamon.com' ? mails.map(({ mailId, mailboxId }) => ({ mailId, mailboxId })) : [] }); }
      if (u.pathname === '/mail/data/emlMail/selectMailView.do') { log.views++; const m = mails.find((x) => x.mailId === u.searchParams.get('mailId')); return j({ mailList: [{ emlMessageVo: { content: m.body } }] }); }
      res.writeHead(404); res.end();
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const opt = { gw: base, mail: base };
  try {
    const { id } = await saveGwAccount(db, env, 1, 'bigbear@willvi.co.kr', 'Gw!Secret#771');
    let a = await db.prepare(`SELECT * FROM gw_accounts WHERE id=?`).bind(id).first();
    assert.match(a.pw_enc, /^enc\$/);
    let r = await scanGwAccount(env, a, opt);
    assert.deepEqual([r.ok, r.added, log.logins, log.views], [true, 2, 1, 2]);
    assert.deepEqual((await db.prepare(`SELECT name, owner_user_id, mail_account FROM applicant_inbox ORDER BY id`).all()).results.map((x) => [x.name, x.owner_user_id, x.mail_account]), [['김하나', 1, 'bigbear'], ['이두리', 1, 'bigbear']]);
    // 새 메일 1통 → 세션 재사용(로그인 안 함), 새 메일 본문만 받음
    mails.unshift({ mailId: 'm3', mailboxId: 'b', body: html('박세리', 9003) });
    a = await db.prepare(`SELECT * FROM gw_accounts WHERE id=?`).bind(id).first();
    assert.ok(a.session_enc.startsWith('enc$'));
    r = await scanGwAccount(env, a, opt);
    assert.deepEqual([r.ok, r.added, log.logins, log.views], [true, 1, 1, 3]);
    // 화면: 연결됨 + 진단 기록(비밀번호 없음)
    const page = await (await call('/applicants/inbox/connect')).text();
    assert.match(visible(page), /bigbear · 김관리 담당 연결됨/);
    assert.match(page, /알바몬 메일 3통 확인, 새로 읽음 1, 새 지원 1/);   // 두 번째는 세션 재사용이라 로그인 단계가 없다
    assert.doesNotMatch(page, /Gw!Secret#771/);
    // 틀린 비밀번호: 쉼(blocked), 다시 시도 안 함
    const w = await saveGwAccount(db, env, 1, 'bigbear', 'wrong');
    a = await db.prepare(`SELECT * FROM gw_accounts WHERE id=?`).bind(w.id).first();
    r = await scanGwAccount(env, a, opt);
    a = await db.prepare(`SELECT * FROM gw_accounts WHERE id=?`).bind(w.id).first();
    assert.equal(a.blocked, 1);
    assert.match(a.last_error, /틀린 횟수 1\/5/);
    const { runGroupwareScan } = await import('../src/groupware.js');
    const before = log.logins;
    await runGroupwareScan(env, opt);
    assert.equal(log.logins, before);                       // 쉬는 계정은 건너뜀
    // 쿠키 보관함: 경로·도메인 규칙
    const jar = new CookieJar([{ name: 'A', value: '1', domain: 'willvi.co.kr', host: false, path: '/' }, { name: 'B', value: '2', domain: 'gw.willvi.co.kr', host: true, path: '/gw' }]);
    assert.equal(jar.header('https://mail.willvi.co.kr/mail/x'), 'A=1');
    assert.equal(jar.header('https://gw.willvi.co.kr/gw/y'), 'A=1; B=2');
  } finally { srv.close(); }
});
