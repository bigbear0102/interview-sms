// D1 쿼리 헬퍼
export const all = async (db, sql, ...a) => (await db.prepare(sql).bind(...a).all()).results;
export const first = (db, sql, ...a) => db.prepare(sql).bind(...a).first();
export const run = (db, sql, ...a) => db.prepare(sql).bind(...a).run();
export const stmt = (db, sql, ...a) => db.prepare(sql).bind(...a);

// D1 은 쿼리 하나에 묶는 값(?)이 100개까지다. IN (...) 목록은 이만큼씩 나눠서 보낸다(다른 값 자리 몫을 남겨 둔다).
export const IN_MAX = 80;
export function chunks(list, size = IN_MAX) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}
