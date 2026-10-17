// 디자인 검토용: 데모 데이터로 주요 화면을 HTML 파일로 저장한다. (실제 DB/서버는 건드리지 않음)
// 사용: node deploy/dev/render-preview.mjs <출력 폴더>
// 이후 크롬/엣지 headless 로 스크린샷: chrome --headless --screenshot=out.png --window-size=1280,900 file:///.../home.html
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openSqliteD1 } from '../../src/node/d1-sqlite.js';
import { handleRequest } from '../../src/worker.js';
import { createSession } from '../../src/auth.js';
import { hashPassword, encryptText } from '../../src/crypto.js';
import { createCampaign, handleInbound, scheduleCampaign } from '../../src/core.js';
import { saveApplicant } from '../../src/applicants.js';
import { setOutcome } from '../../src/reminders.js';

const out = process.argv[2];
if (!out) { console.error('출력 폴더가 필요합니다.'); process.exit(1); }
mkdirSync(out, { recursive: true });

const db = openSqliteD1(':memory:', fileURLToPath(new URL('../../migrations', import.meta.url)));
const env = {
  DB: db, ENCRYPTION_KEY: 'preview-key', PUBLIC_BASE_URL: 'https://interview.example',
  GATEWAY_URL: 'https://api.sms-gate.app/3rdparty/v1', GATEWAY_PRIVATE_TOKEN: ''
};
const ctx = { waitUntil() {} };

// ---- 데모 데이터 ----
const u = await db.prepare(`INSERT INTO users (username,pass_hash,role,email_verified_at,name,email) VALUES ('admin',?,'super',1,'김관리','admin@willvi.co.kr')`).bind(await hashPassword('demo-password')).run();
const sid = await createSession(db, Number(u.meta.last_row_id));
await db.prepare(`INSERT INTO departments (name) VALUES ('인사팀'),('총무팀')`).run();
await db.prepare(`INSERT INTO gateways (department_id,name,username,password,hook_token,own_number) VALUES (1,'인사팀 폰','demo',?,'tok','01046608711')`)
  .bind(await encryptText('preview-key', 'pw')).run();
const names = ['김민준', '이서연', '박지호', '최수아', '정도윤', '강하은', '조현우', '윤서아', '장예준', '임채원', '한지민', '오세훈'];
const sites = ['1001 강남점', '1001 강남점', '1001 강남점', '1001 강남점', '1002 서초점', '1002 서초점', '1002 서초점', '1003 송파점', '1003 송파점', '1003 송파점', '1003 송파점', '1003 송파점'];
const cands = names.map((n, i) => ({ site: sites[i], name: n, phone: `010-2000-${String(1000 + i)}`, interview_at: '10/20 14:00' }));
const camp = await createCampaign(db, { departmentId: 1, gatewayId: 1, name: '면접 안내 10/20', candidates: cands, userId: 1, retentionDays: 90 });
await db.prepare(`UPDATE campaigns SET status='done', scheduled_at=? WHERE id=?`).bind(Date.now() - 3600000, camp.campaignId).run();
await db.prepare(`UPDATE candidates SET status='sent', sent_at=? WHERE campaign_id=?`).bind(Date.now() - 3500000, camp.campaignId).run();
const replies = [['참석합니다', 0], ['참석', 1], ['불참합니다', 2], ['네 갈게요', 4], ['시간 변경 가능한가요?', 5], ['불참', 7], ['참석 가능합니다', 8], ['ㅇㅇ', 9]];
for (const [msg, i] of replies) await handleInbound(db, 1, { sender: cands[i].phone, message: msg });
const camp2 = await createCampaign(db, { departmentId: 1, gatewayId: 1, name: '면접 안내 10/27', candidates: cands.slice(0, 5), userId: 1 });
await scheduleCampaign(db, camp2.campaignId, Date.now() + 5 * 86400000);
await db.prepare(`INSERT INTO messages (gateway_id,phone,text,status,at,scheduled_at) VALUES
  (1,'01011112222','안녕하세요. 내일 회의는 오전 10시입니다.','sent',?,NULL),
  (1,'01033334444','교육 일정 안내드립니다.\n10/22(수) 14:00 본관 3층','sent',?,NULL),
  (1,'01055556666','월말 정산 자료 제출 부탁드립니다.','scheduled',?,?)`)
  .bind(Date.now() - 600000, Date.now() - 1200000, Date.now(), Date.now() + 86400000).run();
await db.prepare(`INSERT INTO inbound (gateway_id,sender,message,received_at,result) VALUES (1,'01099998888','확인했습니다. 감사합니다.',?, 'unmatched')`).bind(Date.now() - 300000).run();

// 면접 결과·결과 안내 대기
const ids = (await db.prepare(`SELECT id FROM candidates WHERE campaign_id=? ORDER BY id`).bind(camp.campaignId).all()).results.map((r) => r.id);
await setOutcome(db, ids[0], 'passed'); await setOutcome(db, ids[1], 'showed'); await setOutcome(db, ids[4], 'noshow');
// 일정 고르기 안내
const camp3 = await createCampaign(db, { departmentId: 1, gatewayId: 1, name: '면접 일정 고르기 10/21~23', candidates: cands.slice(6, 12), userId: 1,
  slots: ['10/21(화) 14:00', '10/22(수) 10:00', '10/23(목) 15:00'], remindPrev: true, autoRemind: true, autoFollowup: true });
await db.prepare(`UPDATE campaigns SET status='done', scheduled_at=? WHERE id=?`).bind(Date.now() - 7200000, camp3.campaignId).run();
await db.prepare(`UPDATE candidates SET status='sent', sent_at=? WHERE campaign_id=?`).bind(Date.now() - 1800000, camp3.campaignId).run();
for (const [msg, i] of [['2번이요', 6], ['1', 7], ['다음주로 미룰 수 있을까요?', 8], ['불참합니다', 9]]) await handleInbound(db, 1, { sender: cands[i].phone, message: msg });
// 지원자 관리
const appIds = [];
for (const [i, site] of [[0, '아마노코리아(현장HR)'], [1, '아마노코리아(현장HR)'], [4, '아마노코리아(파견)'], [6, ''], [10, '']]) {
  appIds.push((await saveApplicant(db, { name: names[i], phone: cands[i].phone, applied_to: site, job: site ? '주차관리' : '' }, 1, 'manual')).id);
}

// ---- 화면 렌더링 ----
const pages = {
  login: ['/login', false],
  home: ['/', true],
  send: ['/send', true],
  messages: ['/messages', true],
  messages_in: ['/messages?dir=in', true],
  scheduled: ['/messages?dir=scheduled', true],
  campaigns: ['/campaigns', true],
  campaign_new: ['/campaigns/new', true],
  campaign_detail: [`/campaigns/${camp.campaignId}`, true],
  campaign_scheduled: [`/campaigns/${camp2.campaignId}`, true],
  campaign_slots: [`/campaigns/${camp3.campaignId}`, true],
  campaign_new_prefill: [`/campaigns/new?ids=${appIds.join(',')}`, true],
  applicants: ['/applicants', true],
  applicant_detail: [`/applicants/${appIds[0]}`, true],
  admin: ['/admin', true],
  password: ['/password', true],
  people: ['/people', true],
  help_phone: ['/help/phone', true],
  audit: ['/audit', true],
  intro: ['/intro', true],
  signup: ['/signup', false],
  forgot: ['/forgot', false]
};
for (const [name, [path, auth]] of Object.entries(pages)) {
  const res = await handleRequest(new Request('https://interview.example' + path, auth ? { headers: { cookie: `sid=${sid}` } } : {}), env, ctx);
  const html = await res.text();
  writeFileSync(`${out}/${name}.html`, html);
  console.log(name.padEnd(20), res.status, html.length);
}
