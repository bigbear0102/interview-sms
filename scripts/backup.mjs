// 운영 DB(D1) 백업: SQL 파일로 내보내고 오래된 백업을 정리한다.
//   사용: npm run backup                      (backups/ 폴더, 최근 8개 보관)
//         npm run backup -- --dir D:\백업 --keep 12
// 주의: 파일에 개인정보(이름, 전화번호, 문자 내용)가 들어 있다. 안전한 위치에 두고, 보관 기간이 지나면 삭제한다.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, statSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : def; };
const dir = resolve(opt('--dir', 'backups'));
const keep = Number(opt('--keep', '8'));
const db = opt('--db', 'interview-sms');

mkdirSync(dir, { recursive: true });
const stamp = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 16).replace(/[-:T]/g, '');
const file = join(dir, `${db}-${stamp}.sql`);

console.log(`▶ ${db} 내보내는 중 → ${file}`);
const r = spawnSync('npx', ['wrangler', 'd1', 'export', db, '--remote', '--output', `"${file}"`], { stdio: 'inherit', shell: true });
if (r.status !== 0 || !existsSync(file) || statSync(file).size < 1000) {
  console.error('✖ 백업에 실패했어요.');
  process.exit(1);
}
console.log(`✓ 완료 (${Math.round(statSync(file).size / 1024)}KB)`);

// 오래된 백업 정리
const files = readdirSync(dir).filter((f) => f.startsWith(`${db}-`) && f.endsWith('.sql')).sort();
for (const old of files.slice(0, Math.max(0, files.length - keep))) {
  rmSync(join(dir, old));
  console.log(`  삭제: ${old}`);
}
