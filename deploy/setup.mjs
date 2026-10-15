// 최초 1회 실행: 비밀값을 생성해 .env 와 게이트웨이 설정 파일을 만든다. (이미 있으면 건드리지 않음)
//   node deploy/setup.mjs [웹 공개 도메인] [게이트웨이 공개 도메인]
//   예) node deploy/setup.mjs interview.example.com sms.example.com
import { existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const [webHost = 'localhost:8787', gwHost = 'localhost:3000'] = process.argv.slice(2);
const secure = !/^localhost/.test(webHost);
const rand = (n, enc = 'hex') => randomBytes(n).toString(enc);

const envPath = join(root, '.env');
if (existsSync(envPath)) {
  console.log('.env 가 이미 있어 건너뜁니다.');
} else {
  const webUrl = `${secure ? 'https' : 'http'}://${webHost}`;
  const gwUrl = `${secure ? 'https' : 'http'}://${gwHost}`;
  const adminPw = rand(12, 'base64url');
  writeFileSync(envPath, [
    '# 자동 생성됨 — 커밋 금지. 분실하면 복구할 수 없다(특히 ENCRYPTION_KEY).',
    `PORT=8787`,
    `HOST=127.0.0.1`,
    `PUBLIC_BASE_URL=${webUrl}`,
    `GATEWAY_URL=${gwUrl}/api/3rdparty/v1`,
    `ENCRYPTION_KEY=${rand(32)}`,
    `ADMIN_USER=admin`,
    `ADMIN_PASSWORD=${adminPw}`,
    `SEND_BATCH=20`,
    `# 게이트웨이(docker compose) 설정`,
    `GATEWAY_PRIVATE_TOKEN=${rand(24, 'base64url')}`,
    `GATEWAY_DB_PASSWORD=${rand(18, 'base64url')}`,
    `GATEWAY_DB_ROOT_PASSWORD=${rand(18, 'base64url')}`,
    `GATEWAY_JWT_SECRET=${rand(32)}`,
    ''
  ].join('\n'));
  console.log('.env 생성 완료. 초기 관리자 비밀번호:', adminPw);
}

// docker compose 가 읽을 수 있도록 같은 값을 deploy/gateway/.env 로도 복사
const env = Object.fromEntries(readFileSync(envPath, 'utf8').split(/\r?\n/)
  .filter((l) => l && !l.startsWith('#') && l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
mkdirSync(join(root, 'deploy/gateway'), { recursive: true });
const gwHostName = new URL(env.GATEWAY_URL).host;
writeFileSync(join(root, 'deploy/gateway/.env'), [
  `GATEWAY_PRIVATE_TOKEN=${env.GATEWAY_PRIVATE_TOKEN}`,
  `GATEWAY_DB_PASSWORD=${env.GATEWAY_DB_PASSWORD}`,
  `GATEWAY_DB_ROOT_PASSWORD=${env.GATEWAY_DB_ROOT_PASSWORD}`,
  `GATEWAY_JWT_SECRET=${env.GATEWAY_JWT_SECRET}`,
  `GATEWAY_API_HOST=${gwHostName}`,
  ''
].join('\n'));
console.log('deploy/gateway/.env 갱신 완료');
