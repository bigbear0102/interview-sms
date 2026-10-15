import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { openDb } from '../src/db.js';
import { createCampaign, scheduleCampaign, processQueue, handleInbound, purgeExpired, campaignStats, remindCampaign } from '../src/core.js';
import { candidatesFromCsv } from '../src/csv.js';
import { verifySignature } from '../src/gateway.js';

function setup() {
  const db = openDb(':memory:');
  db.prepare(`INSERT INTO departments (name) VALUES ('인사팀')`).run();
  db.prepare(`INSERT INTO gateways (department_id,name,base_url,username,password,hook_token) VALUES (1,'폰','http://x','u','p','tok')`).run();
  return db;
}
const CSV = '사업장,이름,전화번호,면접일시\nA점,홍길동,010-1111-2222,10/20 14:00\nB점,김철수,1033334444,10/20 15:00\nA점,홍길동,010-1111-2222,중복\nC점,오류,123,x\n';

test('CSV → 캠페인 생성, 사업장 분리, 중복/오류 제외', () => {
  const db = setup();
  const parsed = candidatesFromCsv(CSV);
  const r = createCampaign(db, { departmentId: 1, gatewayId: 1, name: 't', candidates: parsed.candidates, userId: null });
  assert.equal(r.accepted, 2);
  assert.equal(r.rejected.length, 2);
  assert.deepEqual(campaignStats(db, r.campaignId).map((s) => s.site), ['A점', 'B점']);
});

test('발송 → 답장 매칭 → 상태 갱신 → 리마인드', async () => {
  const db = setup();
  const r = createCampaign(db, { departmentId: 1, gatewayId: 1, name: 't', candidates: candidatesFromCsv(CSV).candidates, userId: null });
  const sent = [];
  scheduleCampaign(db, r.campaignId, Date.now() - 1);
  await processQueue(db, { intervalMs: 0, send: async (gw, phone, text) => { sent.push([phone, text]); } });
  assert.equal(sent.length, 2);
  assert.match(sent[0][1], /A점/);
  assert.equal(db.prepare(`SELECT status FROM campaigns`).get().status, 'done');

  assert.equal(handleInbound(db, 1, { sender: '+821011112222', message: '불참합니다' }).result, 'absent');
  assert.equal(handleInbound(db, 1, { sender: '010-3333-4444', message: '참석합니다' }).result, 'attending');
  assert.equal(handleInbound(db, 1, { sender: '01099998888', message: '참석' }).matched, false);

  assert.equal(remindCampaign(db, r.campaignId), 0); // 모두 응답함 → 리마인드 대상 없음
});

test('보관기간 만료 시 개인정보 파기, 통계 유지', () => {
  const db = setup();
  const r = createCampaign(db, { departmentId: 1, gatewayId: 1, name: 't', retentionDays: 1, candidates: candidatesFromCsv(CSV).candidates, userId: null });
  assert.equal(purgeExpired(db, Date.now() + 2 * 86400000), 1);
  const c = db.prepare(`SELECT * FROM candidates WHERE campaign_id=?`).get(r.campaignId);
  assert.equal(c.phone, '');
  assert.equal(c.name, '');
  assert.equal(campaignStats(db, r.campaignId).length, 2);
});

test('웹훅 서명 검증', () => {
  const body = '{"event":"sms:received"}', ts = String(Math.floor(Date.now() / 1000)), key = 'secret';
  const sig = createHmac('sha256', key).update(body + ts).digest('hex');
  assert.ok(verifySignature(key, body, sig, ts));
  assert.ok(!verifySignature(key, body + 'x', sig, ts));
  assert.ok(!verifySignature(key, body, sig, String(Number(ts) - 1000)));
});
