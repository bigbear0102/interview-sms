// 알바몬 기업회원 계정 여러 개: 관리자가 등록, 확장 프로그램(관리자 PC)이 계정을 바꿔 가며 연락처를 가져온다.
// - 비밀번호는 암호화해 저장하고 화면에는 다시 보여 주지 않는다.
// - 공고 → 계정은 처음 성공한 계정으로 배운다(recruit_accounts). 같은 공고의 다음 지원자는 그 계정으로 바로 연다.
import { all, first, run } from './d1.js';
import { encryptText, decryptText } from './crypto.js';

export async function listAccounts(db) {
  return all(db,
    `SELECT a.id, a.label, a.login_id, a.active, a.updated_at, a.last_ok_at, a.last_error, a.last_error_at,
            (SELECT COUNT(*) FROM recruit_accounts r WHERE r.account_id=a.id) postings
       FROM albamon_accounts a ORDER BY a.id`);
}

// 반환: { ok } | { error: 'am_need'|'am_pw'|'am_gone'|'am_dup' }
export async function saveAccount(db, env, { id = null, label, login_id, pw }) {
  const l = String(label || '').trim().slice(0, 40);
  const lid = String(login_id || '').trim().slice(0, 60);
  const p = String(pw || '');
  if (!l || !lid) return { error: 'am_need' };
  if (!id && !p) return { error: 'am_pw' };
  const now = Date.now();
  if (id) {
    const cur = await first(db, `SELECT id FROM albamon_accounts WHERE id=?`, Number(id));
    if (!cur) return { error: 'am_gone' };
    if (p) await run(db, `UPDATE albamon_accounts SET label=?, login_id=?, pw_enc=?, updated_at=?, last_error='', last_error_at=NULL WHERE id=?`, l, lid, await encryptText(env.ENCRYPTION_KEY, p), now, cur.id);
    else await run(db, `UPDATE albamon_accounts SET label=?, login_id=?, updated_at=? WHERE id=?`, l, lid, now, cur.id);
    return { ok: true };
  }
  if (await first(db, `SELECT 1 x FROM albamon_accounts WHERE login_id=?`, lid)) return { error: 'am_dup' };
  await run(db, `INSERT INTO albamon_accounts (label, login_id, pw_enc, active, updated_at, created_at) VALUES (?,?,?,1,?,?)`,
    l, lid, await encryptText(env.ENCRYPTION_KEY, p), now, now);
  return { ok: true };
}

export async function setAccountActive(db, id, on) {
  await run(db, `UPDATE albamon_accounts SET active=?, updated_at=? WHERE id=?`, on ? 1 : 0, Date.now(), Number(id));
}
export async function deleteAccount(db, id) {
  await run(db, `DELETE FROM recruit_accounts WHERE account_id=?`, Number(id));
  await run(db, `DELETE FROM albamon_accounts WHERE id=?`, Number(id));
}

// 확장 프로그램용(관리자 키만): 쓰는 계정과 비밀번호. 최근에 성공한 계정이 앞에 온다(처음 보는 공고를 시도하는 순서).
export async function accountsForAgent(db, env) {
  const rows = await all(db, `SELECT id, label, login_id, pw_enc, updated_at FROM albamon_accounts WHERE active=1 ORDER BY COALESCE(last_ok_at,0) DESC, id`);
  const out = [];
  for (const r of rows) {
    try { out.push({ id: r.id, label: r.label, login_id: r.login_id, pw: await decryptText(env.ENCRYPTION_KEY, r.pw_enc), updated_at: r.updated_at }); } catch { /* 키가 바뀌었으면 건너뛴다 */ }
  }
  return out;
}

// 결과 기록: 성공하면 공고 → 계정을 배우고 마지막 성공 시각, 로그인 실패 등은 계정 오류로
export async function noteAccountResult(db, accountId, { ok, recruitNo = '', error = '' }, now = Date.now()) {
  const id = Number(accountId);
  if (!id) return;
  if (ok) {
    await run(db, `UPDATE albamon_accounts SET last_ok_at=?, last_error='', last_error_at=NULL WHERE id=?`, now, id);
    if (recruitNo) await run(db, `INSERT INTO recruit_accounts (recruit_no, account_id, learned_at) VALUES (?,?,?) ON CONFLICT(recruit_no) DO UPDATE SET account_id=excluded.account_id, learned_at=excluded.learned_at`, String(recruitNo), id, now);
  } else if (error) {
    await run(db, `UPDATE albamon_accounts SET last_error=?, last_error_at=? WHERE id=?`, String(error).slice(0, 190), now, id);
  }
}
