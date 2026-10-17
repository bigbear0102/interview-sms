// Node 실행용: node:sqlite 위에 Cloudflare D1 API(prepare/bind/first/all/run/batch)를 구현한다.
// 같은 코드(src/worker.js)를 Workers 와 Node(PC/사내 서버) 양쪽에서 쓰기 위한 어댑터.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

class Stmt {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...args) {
    // D1 과 같게: 쿼리 하나에 묶는 값은 100개까지(로컬 시험에서도 같은 제한으로 잡는다)
    if (args.length > 100) throw new Error(`D1_ERROR: too many SQL variables (${args.length} > 100)`);
    this.args = args.map((a) => (a === undefined ? null : a)); return this;
  }
  _first() { return this.db.prepare(this.sql).get(...this.args) ?? null; }
  _all() { return { results: this.db.prepare(this.sql).all(...this.args).map((r) => ({ ...r })) }; }
  _run() {
    const r = this.db.prepare(this.sql).run(...this.args);
    return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  async first() { return this._first(); }
  async all() { return this._all(); }
  async run() { return this._run(); }
}

export function openSqliteD1(path, migrationsDir) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  raw.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  if (migrationsDir) {
    const done = new Set(raw.prepare('SELECT name FROM _migrations').all().map((r) => r.name));
    for (const f of readdirSync(migrationsDir).filter((n) => n.endsWith('.sql')).sort()) {
      if (done.has(f)) continue;
      raw.exec('BEGIN');
      try {
        raw.exec(readFileSync(join(migrationsDir, f), 'utf8'));
        raw.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?,?)').run(f, Date.now());
        raw.exec('COMMIT');
      } catch (e) { raw.exec('ROLLBACK'); throw new Error(`마이그레이션 실패 ${f}: ${e.message}`); }
    }
  }
  return {
    raw,
    prepare: (sql) => new Stmt(raw, sql),
    // 동기적으로 실행해 다른 요청이 트랜잭션 중간에 끼어들지 못하게 한다
    async batch(stmts) {
      raw.exec('BEGIN');
      try {
        const out = stmts.map((s) => s._run());
        raw.exec('COMMIT');
        return out;
      } catch (e) { raw.exec('ROLLBACK'); throw e; }
    }
  };
}
