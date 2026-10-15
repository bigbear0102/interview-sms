// 로컬 SQLite(data/app.db)의 데이터를 D1 로 옮기기 위한 SQL 파일을 만든다.
// 사용: node deploy/cloudflare/export-to-d1.mjs <출력 .sql 경로> [sqlite 경로]
// 이후: npx wrangler d1 execute interview-sms --remote --file=<출력 .sql>
// 주의: 출력 파일에는 개인정보가 들어 있으므로 업로드 후 반드시 삭제한다.
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';

const [out, dbPath = 'data/app.db'] = process.argv.slice(2);
if (!out) { console.error('출력 경로가 필요합니다.'); process.exit(1); }
const db = new DatabaseSync(dbPath, { readOnly: true });

// 외래키 순서대로 (부모 → 자식). 세션/로그인 실패 기록은 옮기지 않는다.
const TABLES = ['departments', 'users', 'gateways', 'user_departments', 'campaigns', 'candidates', 'messages', 'inbound', 'audit'];
const lit = (v) => v === null || v === undefined ? 'NULL'
  : typeof v === 'number' || typeof v === 'bigint' ? String(v)
  : `'${String(v).replaceAll("'", "''")}'`;

const lines = [];
// 대상 DB 에 남아 있는 세션/로그인 실패 기록은 users 를 참조하므로 먼저 비운다
lines.push('DELETE FROM sessions;', 'DELETE FROM login_fail;');
// 자식 → 부모 순서로 비우고
for (const t of [...TABLES].reverse()) lines.push(`DELETE FROM ${t};`);
// 부모 → 자식 순서로 채운다
for (const t of TABLES) {
  const rows = db.prepare(`SELECT * FROM ${t}`).all();
  for (const r of rows) {
    const cols = Object.keys(r);
    lines.push(`INSERT INTO ${t} (${cols.join(',')}) VALUES (${cols.map((c) => lit(r[c])).join(',')});`);
  }
  console.log(`${t}: ${rows.length}행`);
}
writeFileSync(out, lines.join('\n') + '\n');
