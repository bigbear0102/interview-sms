// 진행 기록: 시간이 걸리는 작업(버튼을 누르고 기다리는 동안) 화면 아래 진행 카드에 서버의 실제 단계를 보여 준다.
// - 화면(APP_JS)이 제출할 때 작업 번호(_op)를 붙이고, 1초마다 /ops/<번호> 로 기록을 읽어 간다.
// - 서버는 요청을 받으면 "요청을 받았어요"를 자동으로 남기고, 오래 걸리는 처리(명단 올리기, AI, 그룹웨어 등)는 단계별로 남긴다.
// - 기록에는 개인정보(이름·전화번호·문자 내용)를 쓰지 않는다. 하루 지나면 지운다(purgeOpLogs).
import { all, run } from './d1.js';

const OPS = new WeakMap();   // request → 기록 함수
const VALID = /^[a-z0-9]{8,24}$/;

export function opIdOf(url) {
  const id = url.searchParams.get('_op') || '';
  return VALID.test(id) ? id : '';
}

// 이 요청의 기록 함수를 만든다(작업 번호가 없으면 아무것도 하지 않는 함수)
export function startOp(request, db, url, user) {
  const id = opIdOf(url);
  if (!id || !user) { OPS.set(request, noop); return noop; }
  const log = async (msg) => {
    try { await run(db, `INSERT INTO op_logs (op, user_id, at, msg) VALUES (?,?,?,?)`, id, user.id, Date.now(), String(msg).slice(0, 200)); } catch { /* 기록 실패는 작업에 영향 없음 */ }
  };
  OPS.set(request, log);
  return log;
}
const noop = async () => {};

// 핸들러 안에서: const log = opFor(request); await log('…');
export const opFor = (request) => OPS.get(request) || noop;

export async function readOp(db, id, userId) {
  if (!VALID.test(id)) return [];
  return all(db, `SELECT at, msg FROM op_logs WHERE op=? AND user_id=? ORDER BY at, rowid LIMIT 100`, id, userId);
}

export async function purgeOpLogs(db, now = Date.now()) {
  await run(db, `DELETE FROM op_logs WHERE at < ?`, now - 86400000);
}
