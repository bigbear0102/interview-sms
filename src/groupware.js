// 그룹웨어(willvi) 메일함에서 알바몬 지원 메일을 서버가 직접 가져온다(PC·확장 프로그램 없이, 1분마다).
// 흐름(확장 프로그램이 브라우저에서 하던 것과 같다):
//   1) 그룹웨어 로그인 화면 → 부서 목록 → 로그인 확인(selectLoginFlag.do, resultCode 0 이면 성공, 쿠키로 세션)
//   2) 메일 화면을 한 번 열어 메일 쪽 세션을 만든다(리다이렉트를 따라가며 쿠키를 모은다)
//   3) 메일 목록 API(보낸 사람 mailmaster@albamon.com) → 새 메일만 본문 API → 기존 해석기로 새 지원에 저장
// - 비밀번호·세션 쿠키는 암호화해 저장한다. 세션을 재사용하고, 풀렸을 때만 다시 로그인한다.
// - 비밀번호가 틀리면(resultCode -20 등) 계정 잠김을 막으려고 비밀번호를 고칠 때까지 쉰다.
// - Workers 무료 요금제의 외부 요청 한도(호출당 50)를 넘지 않게 한 번에 받는 본문 수를 제한한다.
// - 각 단계 결과(상태 코드·쿠키 이름·주소, 비밀값 없음)를 diag 에 남겨 연결 문제를 화면에서 진단한다.
import { all, first, run } from './d1.js';
import { encryptText, decryptText } from './crypto.js';
import { parseAlbamonApply, saveParsed } from './mail-intake.js';

export const GW_BASE = 'https://gw.willvi.co.kr';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';
export const MAIL_BASE = 'https://mail.willvi.co.kr';
const ALBAMON_FROM = 'mailmaster@albamon.com';
const BODY_BUDGET = 25;        // 한 번에 받는 본문 수(외부 요청 한도)
const LIST_SIZE = 50;          // 최신 몇 통까지 확인할지(1분마다라 충분)
const TIMEOUT = 15000;

export const gwId = (s) => String(s || '').split('@')[0].trim().toLowerCase();

// ---------------- 쿠키 보관함 ----------------
// 도메인(.willvi.co.kr 처럼 상위 도메인 포함)·경로를 지켜서 보낸다.
export class CookieJar {
  constructor(list = []) { this.list = Array.isArray(list) ? list : []; }
  static parse(json) { try { return new CookieJar(JSON.parse(json)); } catch { return new CookieJar(); } }
  toJSON() { return this.list; }
  names() { return [...new Set(this.list.map((c) => c.name))]; }
  store(url, res) {
    const u = new URL(url);
    const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
    for (const line of raw) {
      const parts = line.split(';').map((x) => x.trim());
      const eq = parts[0].indexOf('=');
      if (eq < 1) continue;
      const c = { name: parts[0].slice(0, eq), value: parts[0].slice(eq + 1), domain: u.hostname, host: true, path: '/' };
      let expired = false;
      for (const p of parts.slice(1)) {
        const [k, ...v] = p.split('='); const key = k.toLowerCase(); const val = v.join('=');
        if (key === 'domain' && val) { c.domain = val.replace(/^\./, '').toLowerCase(); c.host = false; }
        else if (key === 'path' && val) c.path = val;
        else if (key === 'max-age' && Number(val) <= 0) expired = true;
        else if (key === 'expires' && Date.parse(val) < Date.now()) expired = true;
      }
      this.list = this.list.filter((x) => !(x.name === c.name && x.domain === c.domain && x.path === c.path));
      if (!expired) this.list.push(c);
    }
  }
  header(url) {
    const u = new URL(url);
    const h = u.hostname.toLowerCase();
    return this.list.filter((c) => (c.host ? h === c.domain : (h === c.domain || h.endsWith('.' + c.domain))) && u.pathname.startsWith(c.path))
      .map((c) => `${c.name}=${c.value}`).join('; ');
  }
}

// 쿠키를 들고 요청한다. 리다이렉트는 직접 따라가며(최대 8번) 각 응답의 쿠키를 모은다.
async function req(jar, url, init = {}, diag = null, label = '') {
  let cur = url, method = init.method || 'GET', body = init.body;
  for (let hop = 0; hop < 8; hop++) {
    // 그룹웨어는 브라우저 정보(User-Agent)를 해석하므로 실제 크롬과 같은 값을 보낸다(낯선 값이면 로그인이 500 으로 실패한 사례)
    const headers = { 'User-Agent': BROWSER_UA, 'Accept-Language': 'ko-KR,ko;q=0.9', Accept: init.accept || '*/*', ...(init.headers || {}) };
    // Cloudflare Worker 의 요청에는 접속 IP 로 IPv6(2a06:98c0:3600::103)가 붙는데, 그룹웨어는 로그인 기록에 이를 저장하지 못해
    // 로그인 성공 시점에 500(JPA rollback)이 난다(2026-10-17 진단). 이 서버의 실제 IPv4 를 접속 IP 로 함께 보낸다.
    if (jar.ipv4) headers['X-Forwarded-For'] = jar.ipv4;
    const ck = jar.header(cur);
    if (ck) headers.Cookie = ck;
    const res = await fetch(cur, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT) });
    jar.store(cur, res);
    const loc = res.headers.get('location');
    if (diag) diag.push(`${label || method} ${new URL(cur).host}${new URL(cur).pathname.slice(0, 60)} → ${res.status}${loc ? ' ↪ ' + new URL(loc, cur).host + new URL(loc, cur).pathname.slice(0, 60) : ''}`);
    if (res.status >= 300 && res.status < 400 && loc) {
      cur = new URL(loc, cur).toString();
      if (res.status !== 307 && res.status !== 308) { method = 'GET'; body = undefined; }
      continue;
    }
    return { res, url: cur };
  }
  throw new Error('리다이렉트가 너무 많아요');
}
// 로그인 화면의 $.common.ajax 와 같은 모양(Content-Type: application/json, 같은 출처 Origin·Referer)
const jsonPost = (jar, url, obj, diag, label) => {
  const o = new URL(url).origin;
  return req(jar, url, {
    method: 'POST', body: JSON.stringify(obj), accept: 'application/json, text/javascript, */*; q=0.01',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', Origin: o, Referer: o + (o.includes('mail') ? '/mail/link/emlMail/emlMailMain.do' : '/gw/sub/common/login/cmmLogin.do') }
  }, diag, label);
};

// 이 서버(Cloudflare)가 밖에서 보이는 IPv4. 한 실행(isolate) 동안 기억한다
let cachedV4 = '';
export async function egressIPv4() {
  if (cachedV4) return cachedV4;
  for (const u of ['https://api.ipify.org?format=json', 'https://httpbin.org/ip']) {
    try {
      const j = await (await fetch(u, { signal: AbortSignal.timeout(5000) })).json();
      const v4 = String(j.ip || j.origin || '').split(',').map((x) => x.trim()).find((x) => /^\d{1,3}(\.\d{1,3}){3}$/.test(x));
      if (v4) return (cachedV4 = v4);
    } catch { /* 다음 주소로 */ }
  }
  return '';
}

// 그룹웨어 로그인. 반환: { ok } | { ok:false, wrong:true, code, now, limit } | { ok:false, error }
export async function gwLogin(jar, id, pw, diag = [], base = GW_BASE) {
  const host = new URL(base).host;
  await req(jar, `${base}/gw/sub/common/login/cmmLogin.do`, {}, diag, '로그인 화면');
  const dr = await jsonPost(jar, `${base}/gw/data/common/login/selectDepartmentList.do?_=${Date.now()}t`, { deptId: '', langCode: 'ko', gwUrl: host, userId: gwId(id), pwd: '', sec: '' }, diag, '부서 목록');
  let depts = [];
  try { depts = await dr.res.json(); } catch { /* 부서 목록이 없으면 빈 값으로 */ }
  const d = Array.isArray(depts) ? (depts.find((x) => x.reprsntDeptYn === 'Y') || depts[0]) : null;
  diag.push(`부서 ${Array.isArray(depts) ? depts.length : '없음'}개${d ? ' (대표 부서 있음)' : ''}`);
  const r = await jsonPost(jar, `${base}/gw/data/common/login/selectLoginFlag.do?lang=ko&_=${Date.now()}t`, { deptId: d ? d.deptId : '', langCode: 'ko', gwUrl: host, userId: gwId(id), pwd: pw, sec: '', token: null }, diag, '로그인');
  const text = await r.res.text();
  let j = {};
  try { j = JSON.parse(text); } catch {
    // 오류 화면의 앞부분만 남긴다(진단용, 우리가 보낸 값은 들어 있지 않다)
    diag.push('로그인 응답 앞부분: ' + text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200));
    return { ok: false, error: `로그인 응답을 읽지 못했어요(${r.res.status})` };
  }
  diag.push(`로그인 결과 코드 ${j.resultCode}`);
  if (String(j.resultCode) === '0') {
    if (j.mainUrl) await req(jar, `${base}/gw${j.mainUrl}`, {}, diag, '메인');
    return { ok: true };
  }
  if (['-20', '-10', '-40'].includes(String(j.resultCode)) || j.nowErrorCnt != null) return { ok: false, wrong: true, code: String(j.resultCode), now: j.nowErrorCnt, limit: j.limitErrorCnt };
  return { ok: false, error: `로그인 실패(코드 ${j.resultCode})` };
}

// 메일 목록(알바몬 발신, 최신 순). 세션이 없으면 { error:'session' }
export async function listAlbamon(jar, diag = [], mail = MAIL_BASE, size = LIST_SIZE) {
  const r = await jsonPost(jar, `${mail}/mail/data/emlMail/selectMailList.do?_=${Date.now()}t`,
    { isLazy: 'N', boxCode: 'recv', pageNo: '1', pageSize: String(size), mailType: 'all', searchField: 'mailFrom', keyword: ALBAMON_FROM, startDt: null, endDt: null }, diag, '메일 목록');
  if (r.res.status !== 200 || /login/i.test(new URL(r.url).pathname)) return { error: 'session' };
  let j;
  try { j = await r.res.json(); } catch { return { error: 'session' }; }
  const list = Array.isArray(j.mailList) ? j.mailList : null;
  if (!list) return { error: 'session' };
  return { mails: list.filter((m) => m && m.mailId && m.mailboxId).map((m) => ({ id: String(m.mailId), mb: String(m.mailboxId) })), total: Number(j.totalCount) || 0 };
}

export async function fetchBody(jar, m, mail = MAIL_BASE) {
  const url = `${mail}/mail/data/emlMail/selectMailView.do?_=${Date.now()}&mode=view&mailType=all&searchField=&mailboxId=${encodeURIComponent(m.mb)}&pageSize=30&startDt=&endDt=&mailId=${encodeURIComponent(m.id)}&isLazy=Y&keyword=`;
  const r = await req(jar, url, { accept: 'application/json' });
  const j = await r.res.json();
  const c = j && j.mailList && j.mailList[0] && j.mailList[0].emlMessageVo && j.mailList[0].emlMessageVo.content;
  return typeof c === 'string' ? c : '';
}

// 메일 쪽 세션 만들기: 메일 화면을 열면 그룹웨어 세션으로 메일 서버 세션이 생긴다
async function openMail(jar, diag, mail = MAIL_BASE) {
  await req(jar, `${mail}/mail/link/emlMail/emlMailMain.do`, { accept: 'text/html' }, diag, '메일 화면');
}

// ---------------- 계정 저장 ----------------
export async function listGwAccounts(db, userId = null) {
  return all(db, `SELECT g.id, g.user_id, g.login_id, g.active, g.blocked, g.last_check_at, g.last_ok_at, g.last_error, g.last_added, g.diag,
      COALESCE(NULLIF(u.name,''), u.username) owner FROM gw_accounts g LEFT JOIN users u ON u.id=g.user_id
      ${userId != null ? 'WHERE g.user_id=?' : ''} ORDER BY g.id`, ...(userId != null ? [userId] : []));
}
export async function saveGwAccount(db, env, userId, loginId, pw) {
  const lid = gwId(loginId);
  if (!lid || !pw) return { error: 'gw_need' };
  const enc = await encryptText(env.ENCRYPTION_KEY, String(pw));
  const now = Date.now();
  await run(db, `INSERT INTO gw_accounts (user_id, login_id, pw_enc, updated_at, created_at) VALUES (?,?,?,?,?)
    ON CONFLICT(user_id, login_id) DO UPDATE SET pw_enc=excluded.pw_enc, session_enc='', blocked=0, active=1, last_error='', updated_at=excluded.updated_at`, userId, lid, enc, now, now);
  return { ok: true, id: (await first(db, `SELECT id FROM gw_accounts WHERE user_id=? AND login_id=?`, userId, lid)).id };
}
export async function deleteGwAccount(db, id, userId, isSuper) {
  const a = await first(db, `SELECT id, user_id FROM gw_accounts WHERE id=?`, Number(id));
  if (!a || (!isSuper && a.user_id !== userId)) return false;
  await run(db, `DELETE FROM gw_seen WHERE account_id=?`, a.id);
  await run(db, `DELETE FROM gw_accounts WHERE id=?`, a.id);
  return true;
}

// ---------------- 한 계정 확인 ----------------
// 반환: { ok, added, error? }
export async function scanGwAccount(env, acct, { gw = GW_BASE, mail = MAIL_BASE, budget = BODY_BUDGET, now = Date.now(), ipv4: opts_ipv4 } = {}) {
  const db = env.DB;
  const diag = [];
  const jar = acct.session_enc ? CookieJar.parse(await decryptText(env.ENCRYPTION_KEY, acct.session_enc).catch(() => '[]')) : new CookieJar();
  jar.ipv4 = opts_ipv4 !== undefined ? opts_ipv4 : await egressIPv4();
  if (jar.ipv4) diag.push(`접속 IP(IPv4)로 보냄: ${jar.ipv4}`);
  const done = async (fields) => {
    const sets = Object.keys(fields).map((k) => `${k}=?`).join(', ');
    await run(db, `UPDATE gw_accounts SET ${sets}, last_check_at=?, diag=? WHERE id=?`, ...Object.values(fields), now, diag.join('\n').slice(0, 3000), acct.id);
  };
  try {
    let list = jar.list.length ? await listAlbamon(jar, diag, mail) : { error: 'session' };
    if (list.error) {
      // 세션이 없거나 풀림 → 로그인(계정당 한 번) → 메일 화면으로 메일 세션 → 다시 목록
      jar.list = [];
      const pw = await decryptText(env.ENCRYPTION_KEY, acct.pw_enc);
      const lg = await gwLogin(jar, acct.login_id, pw, diag, gw);
      if (!lg.ok) {
        if (lg.wrong) {
          const cnt = lg.limit ? ` (틀린 횟수 ${lg.now}/${lg.limit})` : '';
          await done({ blocked: 1, session_enc: '', last_error: `그룹웨어 아이디 또는 비밀번호가 맞지 않아요${cnt}. 계정 잠김을 막으려고 비밀번호를 다시 저장할 때까지 쉬어요.` });
        } else await done({ last_error: lg.error || '그룹웨어에 로그인하지 못했어요.' });
        return { ok: false, error: lg.error || 'login' };
      }
      await openMail(jar, diag, mail);
      list = await listAlbamon(jar, diag, mail);
      if (list.error) {
        diag.push(`쿠키: ${jar.names().join(', ')}`);
        await done({ session_enc: '', last_error: '그룹웨어에는 로그인됐지만 메일 목록을 읽지 못했어요(메일 쪽 연결). 관리자에게 진단 기록을 보여 주세요.' });
        return { ok: false, error: 'mail' };
      }
    }
    // 새 메일만(이미 읽은 메일 제외)
    const ids = list.mails.map((m) => m.id);
    const seen = new Set();
    for (let i = 0; i < ids.length; i += 80) {
      const part = ids.slice(i, i + 80);
      for (const r of await all(db, `SELECT mail_id FROM gw_seen WHERE account_id=? AND mail_id IN (${part.map(() => '?').join(',')})`, acct.id, ...part)) seen.add(r.mail_id);
    }
    const todo = list.mails.filter((m) => !seen.has(m.id)).slice(0, budget);
    let added = 0;
    for (const m of todo) {
      let html = '';
      try { html = await fetchBody(jar, m, mail); } catch { continue; }   // 못 받은 건은 다음에 다시
      const p = html ? parseAlbamonApply(html) : null;
      if (p && p.name) {
        const r = await saveParsed(db, p, now, acct.user_id, gwId(acct.login_id));
        if (r && !r.duplicate) added++;   // 원가중심점이 정해진 공고면 저장할 때 연락처 요청까지 걸린다(saveParsed)
      }
      await run(db, `INSERT OR IGNORE INTO gw_seen (account_id, mail_id, at) VALUES (?,?,?)`, acct.id, m.id, now);
    }
    diag.push(`알바몬 메일 ${list.mails.length}통 확인, 새로 읽음 ${todo.length}, 새 지원 ${added}`);
    await done({ session_enc: await encryptText(env.ENCRYPTION_KEY, JSON.stringify(jar)), last_ok_at: now, last_error: '', last_added: added });
    return { ok: true, added };
  } catch (e) {
    diag.push('오류: ' + String(e.message || e).slice(0, 200));
    await done({ last_error: `그룹웨어에 연결하지 못했어요(${String(e.message || e).slice(0, 80)}). 잠시 뒤 다시 시도해요.` });
    return { ok: false, error: String(e.message || e) };
  }
}

// 주기 작업: 쓰는 계정을 차례로 확인한다(1분마다, 쉬는 계정 제외). 반환: 새로 들어온 지원 수
export async function runGroupwareScan(env, { now = Date.now(), maxAccounts = 1, ...opts } = {}) {
  const rows = await all(env.DB, `SELECT * FROM gw_accounts WHERE active=1 AND blocked=0 ORDER BY COALESCE(last_check_at,0) LIMIT ?`, maxAccounts);
  let added = 0;
  for (const a of rows) {
    const r = await scanGwAccount(env, a, { now, ...opts });
    if (r.ok) added += r.added;
  }
  return added;
}

// 진단(관리자가 applicant_settings 'gw_probe'=1 로 켜면 다음 주기에 한 번): 이 서버가 밖으로 보내는 요청에
// 어떤 머리말·IP 가 실리는지(httpbin), 없는 아이디로 로그인했을 때 그룹웨어 응답이 어떤지 기록한다. 실제 계정은 쓰지 않는다.
export async function runProbe(env) {
  const db = env.DB;
  const flag = await first(db, `SELECT value FROM applicant_settings WHERE key='gw_probe'`);
  if (!flag || flag.value !== '1') return false;
  await run(db, `UPDATE applicant_settings SET value='0' WHERE key='gw_probe'`);
  const out = [];
  try {
    const h = await (await fetch('https://httpbin.org/headers', { headers: { 'User-Agent': BROWSER_UA } })).json();
    out.push('밖으로 나가는 머리말: ' + JSON.stringify(h.headers));
    const ip = await (await fetch('https://httpbin.org/ip')).json();
    out.push('밖에서 보이는 IP: ' + JSON.stringify(ip));
    // 접속 IP 머리말을 IPv4 로 직접 보내면 바뀌는지(그룹웨어가 IPv6 를 저장하지 못하는 문제 확인용)
    const v4 = String(ip.origin || '').split(',').map((x) => x.trim()).find((x) => /^\d+\.\d+\.\d+\.\d+$/.test(x)) || '';
    if (v4) {
      const h2 = await (await fetch('https://httpbin.org/headers', { headers: { 'X-Forwarded-For': v4, 'X-Real-IP': v4 } })).json();
      const ip2 = await (await fetch('https://httpbin.org/ip', { headers: { 'X-Forwarded-For': v4, 'X-Real-IP': v4 } })).json();
      out.push(`IPv4(${v4})를 직접 보냈을 때 → IP: ${JSON.stringify(ip2)} / 머리말: ${JSON.stringify({ xff: h2.headers['X-Forwarded-For'], real: h2.headers['X-Real-Ip'] })}`);
    }
  } catch (e) { out.push('httpbin 실패: ' + e.message); }
  try {
    const jar = new CookieJar();
    const diag = [];
    const r = await gwLogin(jar, 'zzprobe' + String(Date.now()).slice(-6), 'not-a-real-password', diag);
    out.push('없는 아이디 로그인: ' + JSON.stringify(r));
    out.push(...diag);
  } catch (e) { out.push('없는 아이디 로그인 실패: ' + e.message); }
  await run(db, `INSERT INTO applicant_settings (key, value) VALUES ('gw_probe_result', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, out.join('\n').slice(0, 4000));
  return true;
}

