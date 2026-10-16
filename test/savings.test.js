import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openSqliteD1 } from '../src/node/d1-sqlite.js';
import { monthStats, estimateMinutes, fmtMinutes, kstMonthStart, renderSavingsCard } from '../src/savings.js';

const KST = 9 * 3600000;
const NOW = Date.UTC(2026, 9, 15, 3, 0, 0); // 2026-10-15 12:00 KST

test('월 시작(KST)과 시간 표기', () => {
  assert.equal(kstMonthStart(NOW), Date.UTC(2026, 9, 1) - KST);
  assert.equal(fmtMinutes(45), '약 45분');
  assert.equal(fmtMinutes(60), '약 1시간');
  assert.equal(fmtMinutes(135), '약 2시간 15분');
});

test('이번 달 집계: 지난달 기록과 수동 처리는 제외', async () => {
  const db = openSqliteD1(':memory:', fileURLToPath(new URL('../migrations', import.meta.url)));
  await db.prepare(`INSERT INTO departments (name) VALUES ('인사팀'),('총무팀')`).run();
  await db.prepare(`INSERT INTO gateways (department_id,name,username,password,hook_token) VALUES (1,'폰','u','p','t')`).run();
  await db.prepare(`INSERT INTO campaigns (department_id,gateway_id,name,template,created_at,status) VALUES (1,1,'a','x',?,'done'),(2,1,'b','x',?,'done')`).bind(NOW, NOW).run();
  const m = kstMonthStart(NOW);
  const ins = db.prepare(`INSERT INTO candidates (campaign_id,site,name,phone,status,sent_at,replied_at,manual,reminded_at) VALUES (?,?,?,?,?,?,?,?,?)`);
  const rows = [
    [1, 'A', 'a', '01011110001', 'attending', m + 1000, m + 2000, 0, m + 5000],  // 이번 달, 자동, 리마인드
    [1, 'A', 'b', '01011110002', 'absent', m + 1000, m + 9000, 0, m + 5000],     // 리마인드 뒤 불참
    [1, 'A', 'c', '01011110003', 'attending', m + 1000, m + 2000, 1, null],      // 수동 처리: 답장 집계 제외
    [1, 'A', 'd', '01011110004', 'sent', m + 1000, null, 0, null],               // 답 없음
    [1, 'A', 'e', '01011110005', 'attending', m - 86400000, m - 80000000, 0, null], // 지난달
    [2, 'B', 'f', '01011110006', 'attending', m + 1000, m + 2000, 0, null]       // 다른 부서
  ];
  for (const r of rows) await ins.bind(...r).run();
  const s = await monthStats(db, [1], NOW);
  assert.deepEqual(s, { sent: 4, replies: 2, reminders: 2, absentAfterRemind: 1 });
  assert.equal(estimateMinutes(s), 4 * 1 + 2 * 1 + 2 * 2);
  const html = renderSavingsCard(s);
  assert.match(html, /이번 달 시스템이 대신한 일/);
  assert.match(html, /약 10분/);
  assert.match(html, /어떻게 계산했나요/);
  assert.equal(renderSavingsCard({ sent: 0, replies: 0, reminders: 0, absentAfterRemind: 0 }), ''); // 활동이 없으면 표시 안 함
  assert.deepEqual(await monthStats(db, [], NOW), { sent: 0, replies: 0, reminders: 0, absentAfterRemind: 0 });
});
