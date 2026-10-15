// Cloudflare D1 내보내기 파일을 로컬(회사 서버) SQLite 로 옮긴다. (D1 → Node 이전용)
// 1) 내보내기:  npx wrangler d1 export interview-sms --remote --output backup.sql
// 2) 가져오기:  node deploy/cloudflare/import-d1-export.mjs backup.sql data/app.db
// 이미 data/app.db 가 있으면 중단한다. 개인정보가 들어 있으니 끝나면 backup.sql 을 삭제한다.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const [dump, target = 'data/app.db'] = process.argv.slice(2);
if (!dump) { console.error('사용법: node deploy/cloudflare/import-d1-export.mjs <backup.sql> [data/app.db]'); process.exit(1); }
if (existsSync(target)) { console.error(`${target} 가 이미 있습니다. 덮어쓰지 않습니다.`); process.exit(1); }
mkdirSync(dirname(target), { recursive: true });

const db = new DatabaseSync(target);
db.exec('PRAGMA foreign_keys = OFF;');
db.exec(readFileSync(dump, 'utf8'));
db.exec('PRAGMA foreign_keys = ON;');

// 마이그레이션이 이미 적용된 것으로 표시해 서버 시작 시 중복 적용되지 않게 한다
db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
const dir = fileURLToPath(new URL('../../migrations/', import.meta.url));
const ins = db.prepare('INSERT OR IGNORE INTO _migrations (name, applied_at) VALUES (?, ?)');
for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) ins.run(f, Date.now());

for (const t of ['users', 'departments', 'gateways', 'campaigns', 'candidates', 'messages', 'inbound']) {
  console.log(`${t}: ${db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n}행`);
}
