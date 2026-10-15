// D1 쿼리 헬퍼
export const all = async (db, sql, ...a) => (await db.prepare(sql).bind(...a).all()).results;
export const first = (db, sql, ...a) => db.prepare(sql).bind(...a).first();
export const run = (db, sql, ...a) => db.prepare(sql).bind(...a).run();
export const stmt = (db, sql, ...a) => db.prepare(sql).bind(...a);
