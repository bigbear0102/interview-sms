import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openSqliteD1 } from '../src/node/d1-sqlite.js';
import { parseInterviewAt, queueAutoReminders, setOutcome } from '../src/reminders.js';

const KST = 9 * 3600000;
const kst = (y, mo, d, h, mi = 0) => Date.UTC(y, mo - 1, d, h, mi) - KST;

test('면접일시 글자 해석', () => {
  const now = kst(2026, 10, 15, 12);
  assert.equal(parseInterviewAt('10/20 14:00', now), kst(2026, 10, 20, 14));
  assert.equal(parseInterviewAt('2026-10-20 14:30', now), kst(2026, 10, 20, 14, 30));
  assert.equal(parseInterviewAt('10월 20일 오후 2시 30분', now), kst(2026, 10, 20, 14, 30));
  assert.equal(parseInterviewAt('10/20 오전 9시', now), kst(2026, 10, 20, 9));
  assert.ok(Number.isNaN(parseInterviewAt('추후 안내', now)));
  assert.ok(Number.isNaN(parseInterviewAt('10/20', now))); // 시간이 없으면 자동 리마인드 불가
});

async function setup() {
  const db = openSqliteD1(':memory:', fileURLToPath(new URL('../migrations', import.meta.url)));
  await db.prepare(`INSERT INTO departments (name) VALUES ('인사팀')`).run();
  await db.prepare(`INSERT INTO gateways (department_id,name,username,password,hook_token) VALUES (1,'폰','u','p','t')`).run();
  await db.prepare(`INSERT INTO campaigns (department_id,gateway_id,name,template,created_at,auto_remind,status) VALUES (1,1,'t','{이름}',?,1,'done')`).bind(Date.now()).run();
  return db;
}
const addCand = (db, { name, phone, when, status = 'attending' }) =>
  db.prepare(`INSERT INTO candidates (campaign_id,site,name,phone,interview_at,status) VALUES (1,'1001 강남점',?,?,?,?)`).bind(name, phone, when, status).run();

test('자동 리마인드: 참석자만, 24시간 안쪽에서 한 번만', async () => {
  const db = await setup();
  await addCand(db, { name: '가', phone: '+821011110001', when: '10/16 10:00' });               // 대상
  await addCand(db, { name: '나', phone: '+821011110002', when: '10/16 10:00', status: 'absent' }); // 불참
  await addCand(db, { name: '다', phone: '+821011110003', when: '10/20 10:00' });               // 너무 이름
  await addCand(db, { name: '라', phone: '+821011110004', when: '추후' });                        // 해석 불가
  const now = kst(2026, 10, 15, 18);
  assert.equal(await queueAutoReminders(db, now), 1);
  assert.equal(await queueAutoReminders(db, now + 60000), 0); // 두 번째는 보내지 않음
  const m = await db.prepare(`SELECT phone, text, status FROM messages`).all();
  assert.equal(m.results.length, 1);
  assert.equal(m.results[0].phone, '+821011110001');
  assert.match(m.results[0].text, /10\/16 10:00/);
});

test('자동 리마인드: 밤 시간에는 보내지 않고, 꺼진 안내는 건너뜀', async () => {
  const db = await setup();
  await addCand(db, { name: '가', phone: '+821011110001', when: '10/16 10:00' });
  assert.equal(await queueAutoReminders(db, kst(2026, 10, 15, 23)), 0);
  await db.prepare(`UPDATE campaigns SET auto_remind=0`).run();
  assert.equal(await queueAutoReminders(db, kst(2026, 10, 15, 18)), 0);
});

test('면접 결과 기록', async () => {
  const db = await setup();
  await addCand(db, { name: '가', phone: '+821011110001', when: '10/16 10:00' });
  await setOutcome(db, 1, 'noshow');
  assert.equal((await db.prepare(`SELECT outcome FROM candidates WHERE id=1`).first()).outcome, 'noshow');
  await setOutcome(db, 1, '');
  assert.equal((await db.prepare(`SELECT outcome FROM candidates WHERE id=1`).first()).outcome, '');
  await assert.rejects(() => setOutcome(db, 1, 'bogus'));
});

test('지원자 이력: 같은 번호를 묶고 노쇼 많은 순', async () => {
  const { renderPeople } = await import('../src/people.js');
  const db = await setup();
  await addCand(db, { name: '가', phone: '+821011110001', when: '10/16 10:00' });
  await addCand(db, { name: '가', phone: '+821011110001', when: '10/18 10:00' });
  await addCand(db, { name: '나', phone: '+821011110002', when: '10/16 10:00' });
  await db.prepare(`UPDATE candidates SET outcome='noshow' WHERE phone='+821011110001'`).run();
  const html = await renderPeople(db, [{ id: 1 }], '');
  assert.ok(html.indexOf('가') < html.indexOf('나'));
  assert.match(html, /노쇼 반복/);
  assert.match(await renderPeople(db, [{ id: 1 }], '나'), /나/);
  assert.doesNotMatch(await renderPeople(db, [], ''), /노쇼 반복/);
});
