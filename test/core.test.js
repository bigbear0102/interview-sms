import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openSqliteD1 } from '../src/node/d1-sqlite.js';
const createTestDb = () => openSqliteD1(':memory:', fileURLToPath(new URL('../migrations', import.meta.url)));
import { createCampaign, scheduleCampaign, processQueue, handleInbound, purgeExpired, campaignStats, remindCampaign } from '../src/core.js';
import { candidatesFromCsv } from '../src/csv.js';
import { verifySignature, toE164 } from '../src/gateway.js';
import { hashPassword, verifyPassword, encryptText, decryptText } from '../src/crypto.js';
import { parseKstLocal, fmtTime } from '../src/views.js';

async function setup() {
  const db = createTestDb();
  const key = 'test-key';
  await db.prepare(`INSERT INTO departments (name) VALUES ('인사팀')`).run();
  await db.prepare(`INSERT INTO gateways (department_id,name,username,password,hook_token) VALUES (1,'폰','u',?,'tok')`)
    .bind(await encryptText(key, 'pw')).run();
  return { db, env: { DB: db, ENCRYPTION_KEY: key } };
}
const CSV = '사업장,이름,전화번호,면접일시\nA점,홍길동,010-1111-2222,10/20 14:00\nB점,김철수,1033334444,10/20 15:00\nA점,홍길동,010-1111-2222,중복\nC점,오류,123,x\n';

test('CSV → 캠페인 생성, 사업장 분리, 중복/오류 제외', async () => {
  const { db } = await setup();
  const r = await createCampaign(db, { departmentId: 1, gatewayId: 1, name: 't', candidates: candidatesFromCsv(CSV).candidates, userId: null });
  assert.equal(r.accepted, 2);
  assert.equal(r.rejected.length, 2);
  assert.deepEqual((await campaignStats(db, r.campaignId)).map((s) => s.site), ['A점', 'B점']);
});

test('대량 명단(1000명) 생성', async () => {
  const { db } = await setup();
  const rows = Array.from({ length: 1000 }, (_, i) => ({ site: `사업장${i % 50}`, name: `n${i}`, phone: `010${String(10000000 + i)}`, interview_at: '' }));
  const r = await createCampaign(db, { departmentId: 1, gatewayId: 1, name: 'big', candidates: rows, userId: null });
  assert.equal(r.accepted, 1000);
  assert.equal((await campaignStats(db, r.campaignId)).length, 50);
});

test('발송 배치 처리 → 답장 매칭 → 상태 갱신 → 리마인드', async () => {
  const { db, env } = await setup();
  const r = await createCampaign(db, { departmentId: 1, gatewayId: 1, name: 't', candidates: candidatesFromCsv(CSV).candidates, userId: null });
  const sent = [];
  const send = async (gw, phone, text) => { assert.equal(gw.password, 'pw'); sent.push([phone, text]); };
  await scheduleCampaign(db, r.campaignId, Date.now() - 1);

  // batchSize=1 → 한 번에 1건씩, 두 번 호출해야 완료
  await processQueue(env, { batchSize: 1, send });
  assert.equal(sent.length, 1);
  assert.equal((await db.prepare(`SELECT status FROM campaigns`).first()).status, 'sending');
  await processQueue(env, { batchSize: 1, send });
  assert.equal(sent.length, 2);
  assert.match(sent[0][1], /A점/);
  assert.equal((await db.prepare(`SELECT status FROM campaigns`).first()).status, 'done');

  assert.equal((await handleInbound(db, 1, { sender: '+821011112222', message: '불참합니다' })).result, 'absent');
  assert.equal((await handleInbound(db, 1, { sender: '010-3333-4444', message: '참석합니다' })).result, 'attending');
  assert.equal((await handleInbound(db, 1, { sender: '01099998888', message: '참석' })).matched, false);
  assert.equal(await remindCampaign(db, r.campaignId), 0);
});

test('발송 실패는 failed 로 기록되고 리마인드로 재시도된다', async () => {
  const { db, env } = await setup();
  const r = await createCampaign(db, { departmentId: 1, gatewayId: 1, name: 't', candidates: candidatesFromCsv(CSV).candidates, userId: null });
  await scheduleCampaign(db, r.campaignId, Date.now() - 1);
  await processQueue(env, { send: async () => { throw new Error('boom'); }, log: {} });
  const failed = await db.prepare(`SELECT COUNT(*) n FROM candidates WHERE status='failed'`).first();
  assert.equal(failed.n, 2);
  assert.equal(await remindCampaign(db, r.campaignId), 2);
  await processQueue(env, { send: async () => {} });
  assert.equal((await db.prepare(`SELECT COUNT(*) n FROM candidates WHERE status='sent'`).first()).n, 2);
});

test('보관기간 만료 시 개인정보 파기, 통계 유지', async () => {
  const { db } = await setup();
  const r = await createCampaign(db, { departmentId: 1, gatewayId: 1, name: 't', retentionDays: 1, candidates: candidatesFromCsv(CSV).candidates, userId: null });
  assert.equal(await purgeExpired(db, Date.now() + 2 * 86400000), 1);
  const c = await db.prepare(`SELECT * FROM candidates WHERE campaign_id=?`).bind(r.campaignId).first();
  assert.equal(c.phone, '');
  assert.equal(c.name, '');
  assert.equal((await campaignStats(db, r.campaignId)).length, 2);
});

test('웹훅 서명 검증', async () => {
  const body = '{"event":"sms:received"}', ts = String(Math.floor(Date.now() / 1000)), key = 'secret';
  const sig = createHmac('sha256', key).update(body + ts).digest('hex');
  assert.ok(await verifySignature(key, body, sig, ts));
  assert.ok(!(await verifySignature(key, body + 'x', sig, ts)));
  assert.ok(!(await verifySignature(key, body, sig, String(Number(ts) - 1000))));
});

test('비밀번호 해시/암호화', async () => {
  const h = await hashPassword('s3cret-pw');
  assert.ok(await verifyPassword('s3cret-pw', h));
  assert.ok(!(await verifyPassword('wrong', h)));
  assert.equal(await decryptText('k', await encryptText('k', '값')), '값');
});

test('KST 시각 파싱/표시', () => {
  const ms = parseKstLocal('2026-10-20T14:00');
  assert.equal(new Date(ms).toISOString(), '2026-10-20T05:00:00.000Z');
  assert.equal(fmtTime(ms), '2026-10-20 14:00');
});

test('직접 발송: 번호 검증, 기록, 실패 처리', async () => {
  const { db } = await setup();
  const { sendDirect } = await import('../src/core.js');
  const ok = [];
  const res = await sendDirect(db, { id: 1, password: 'pw' }, ['010-1111-2222', '123', '01033334444'], '안녕',
    null, async (gw, phone, text) => { if (phone === '01033334444') throw new Error('offline'); ok.push([phone, text]); });
  assert.deepEqual(res.map((r) => r.ok), [true, false, false]);
  assert.deepEqual(ok, [['01011112222', '안녕']]);
  const rows = (await db.prepare(`SELECT status FROM messages ORDER BY id`).all()).results.map((r) => r.status);
  assert.deepEqual(rows, ['sent', 'failed']);
});

test('E.164 변환', () => {
  assert.equal(toE164('01029501868'), '+821029501868');
  assert.equal(toE164('010-2950-1868'), '+821029501868');
  assert.equal(toE164('+821029501868'), '+821029501868');
});

test('종단간 암호화: 앱 규격(passphrase) 형식으로 암호화되고 복호화된다', async () => {
  const { createDecipheriv, pbkdf2Sync } = await import('node:crypto');
  const { encryptPassphrase } = await import('../src/crypto.js');
  const { buildSendBody } = await import('../src/gateway.js');
  const s = await encryptPassphrase('긴 비밀 문장 입니다', '안녕하세요 +821012345678', 1000);
  const m = s.match(/^\$aes-256-cbc\/pbkdf2-sha1\$i=(\d+)\$([^$]+)\$([^$]+)$/);
  assert.ok(m, '형식');
  const salt = Buffer.from(m[2], 'base64');
  const key = pbkdf2Sync('긴 비밀 문장 입니다', salt, Number(m[1]), 32, 'sha1');
  const d = createDecipheriv('aes-256-cbc', key, salt);
  assert.equal(Buffer.concat([d.update(Buffer.from(m[3], 'base64')), d.final()]).toString('utf8'), '안녕하세요 +821012345678');

  const plain = await buildSendBody({ passphrase: '' }, '010-1234-5678', 'hi');
  assert.deepEqual(plain, { textMessage: { text: 'hi' }, phoneNumbers: ['+821012345678'] });
  const enc = await buildSendBody({ passphrase: 'pw-pw-pw-pw', iterations: 1000 }, '01012345678', 'hi');
  assert.equal(enc.isEncrypted, true);
  assert.match(enc.phoneNumbers[0], /^\$aes-256-cbc\/pbkdf2-sha1\$i=1000\$/);
  assert.match(enc.textMessage.text, /^\$aes-256-cbc\/pbkdf2-sha1\$i=1000\$/);
});
