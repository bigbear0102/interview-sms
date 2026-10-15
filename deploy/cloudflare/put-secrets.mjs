// .env 의 값을 Cloudflare Worker 시크릿으로 올린다. (값은 화면에 출력하지 않는다)
// 사용: node --env-file=.env deploy/cloudflare/put-secrets.mjs
import { spawnSync } from 'node:child_process';

const NAMES = ['ENCRYPTION_KEY', 'GATEWAY_PRIVATE_TOKEN'];
for (const name of NAMES) {
  const value = process.env[name];
  if (!value) { console.error(`${name} 이(가) .env 에 없습니다.`); process.exit(1); }
  const r = spawnSync('npx', ['wrangler', 'secret', 'put', name], { input: value, encoding: 'utf8', shell: true });
  console.log(`${name}: ${r.status === 0 ? '업로드 완료' : '실패 — ' + (r.stderr || r.stdout).slice(-200)}`);
  if (r.status !== 0) process.exit(1);
}
