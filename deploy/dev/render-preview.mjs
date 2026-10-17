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
  GATEWAY_URL: 'https://api.sms-gate.app/3rdparty/v1', GATEWAY_PRIVATE_TOKEN: '',
  NVIDIA_API_KEY: 'preview', NO_REAL_NETWORK: true,  // AI 버튼·표시를 보이게(실제 AI 접속은 하지 않음)
  // 가짜 AI: "AI로 지원자 찾기" 조건만 돌려준다
  AI_FETCH: async () => Response.json({ choices: [{ message: { content: JSON.stringify({ areas: ['아마노'], jobs: ['주차관리'], keywords: [], minStars: null, includeBlacklist: false, limit: null, ignored: [] }) } }] })
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
// AI 표시(미리보기용): 일정 변경 희망 일시, 질문 답장 초안
await db.prepare(`UPDATE candidates SET reply_kind='reschedule', ai_wanted='10/21(수) 15:00', ai_note='AI: 일정 변경 요청(10/21(수) 15:00 희망) · 수요일 오후로 변경 요청' WHERE phone=?`).bind('01020001005').run();
await handleInbound(db, 1, { sender: cands[3].phone, message: '준비물 따로 있나요?' });
await db.prepare(`UPDATE candidates SET ai_note='AI: 질문 · 준비물 문의', ai_draft='신분증만 챙겨 오시면 됩니다. 감사합니다.' WHERE phone=?`).bind('01020001003').run();
const camp2 = await createCampaign(db, { departmentId: 1, gatewayId: 1, name: '면접 안내 10/27', candidates: cands.slice(0, 5), userId: 1 });
await scheduleCampaign(db, camp2.campaignId, Date.now() + 5 * 86400000);
await db.prepare(`INSERT INTO messages (gateway_id,phone,text,status,at,scheduled_at) VALUES
  (1,'01011112222','안녕하세요. 내일 회의는 오전 10시입니다.','sent',?,NULL),
  (1,'01033334444','교육 일정 안내드립니다.\n10/22(수) 14:00 본관 3층','sent',?,NULL),
  (1,'01055556666','월말 정산 자료 제출 부탁드립니다.','scheduled',?,?)`)
  .bind(Date.now() - 600000, Date.now() - 1200000, Date.now(), Date.now() + 86400000).run();
await db.prepare(`INSERT INTO inbound (gateway_id,sender,message,received_at,result,ai_note) VALUES (1,'01099998888','주말 알바 아직 뽑나요?',?, 'unmatched','AI: 지원 문의 · 주말 근무 채용 여부 문의')`).bind(Date.now() - 300000).run();

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
// 별점(담당자 2명): 미리보기에서 목록·상세·AI 찾기 순서 확인용
const u2 = await db.prepare(`INSERT INTO users (username,pass_hash,role,email_verified_at,name,email) VALUES ('lee','x','staff',1,'이담당','lee@willvi.co.kr')`).run();
await db.prepare(`INSERT INTO applicant_ratings (applicant_id,user_id,stars,updated_at) VALUES (?,1,4,?),(?,?,5,?),(?,1,5,?),(?,1,2,?)`)
  .bind(appIds[0], Date.now(), appIds[0], Number(u2.meta.last_row_id), Date.now(), appIds[1], Date.now(), appIds[2], Date.now()).run();

// 새 지원(알바몬 메일): 연락처 있음 1, PC 꺼져 요청 대기 3, 분류 필요 2
const inb = (no, name, phone, state, cc) => db.prepare(`INSERT INTO applicant_inbox (source, apply_no, recruit_no, company, job_title, name, gender, age, address, received_at, status, phone, fetch_state, cost_center, resume_url, owner_user_id)
  VALUES ('albamon',?,?, '㈜윌앤비전-아마노코리아㈜','[아마노코리아] 주차관리 직원 모집',?,'남',?,'서울 강남구',?,'pending',?,?,?,'https://www.albamon.com/x',1)`).bind(no, cc ? '900' : '901', name, 20 + Number(no), Date.now() - Number(no) * 3600e3, phone, state, cc).run();
await inb('1', '김하늘', '01030001111', 'done', '아마노코리아(현장HR)');
for (const [no, nm] of [['2', '박서준'], ['3', '이도현'], ['4', '최유나']]) await inb(no, nm, '', 'requested', '아마노코리아(현장HR)');
await inb('5', '정민재', '', '', ''); await inb('6', '한소희', '', '', '');
await db.prepare(`INSERT INTO ai_postings (recruit_no, cost_center, job, note, at) VALUES ('901','아마노코리아(현장HR)','주차관리','제목의 고객사 이름',?)`).bind(Date.now()).run();
await db.prepare(`INSERT INTO agent_tokens (user_id, token_hash, created_at, last_used_at) VALUES (1,'h',1,?)`).bind(Date.now() - 3 * 3600e3).run();

// 오늘 면접: 오늘 날짜 면접일시로 참석 3명(1명 출석 기록), 무응답 1명
{
  const d = new Date(Date.now() + 9 * 3600e3); const md = `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  const t = await createCampaign(db, { departmentId: 1, gatewayId: 1, name: `면접 안내 ${md}`, userId: 1, candidates: [
    { site: '1001 강남점', name: '서지훈', phone: '010-3100-0001', interview_at: `${md} 10:00` },
    { site: '1001 강남점', name: '문채원', phone: '010-3100-0002', interview_at: `${md} 11:30` },
    { site: '1002 서초점', name: '권나라', phone: '010-3100-0003', interview_at: `${md} 14:00` },
    { site: '1002 서초점', name: '배수지', phone: '010-3100-0004', interview_at: `${md} 15:00` }] });
  await db.prepare(`UPDATE campaigns SET status='done' WHERE id=?`).bind(t.campaignId).run();
  await db.prepare(`UPDATE candidates SET status='attending', sent_at=? WHERE campaign_id=? AND name!='배수지'`).bind(Date.now() - 86400e3, t.campaignId).run();
  await db.prepare(`UPDATE candidates SET status='sent', sent_at=? WHERE campaign_id=? AND name='배수지'`).bind(Date.now() - 86400e3, t.campaignId).run();
  await db.prepare(`UPDATE candidates SET outcome='showed' WHERE campaign_id=? AND name='서지훈'`).bind(t.campaignId).run();
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
  inbox: ['/applicants/inbox', true],
  today: ['/interviews/today', true],
  inbox_connect: ['/applicants/inbox/connect', true],
  postings: ['/applicants/postings', true],
  applicant_ask: ['/applicants/ask?q=' + encodeURIComponent('아마노 주차관리 추천해줘'), true],
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
