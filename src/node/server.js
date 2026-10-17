// PC/사내 서버에서 실행하는 Node 진입점. Workers 용 핸들러(src/worker.js)를 그대로 사용한다.
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { openSqliteD1 } from './d1-sqlite.js';
import { handleRequest, runScheduled, runGroupwareCron } from '../worker.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1'; // 외부 노출은 Cloudflare Tunnel 이 담당
const DB_PATH = process.env.DB_PATH || `${root}data/app.db`;

const env = {
  DB: openSqliteD1(DB_PATH, `${root}migrations`),
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
  ADMIN_USER: process.env.ADMIN_USER || 'admin',
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
  GATEWAY_URL: process.env.GATEWAY_URL,
  GATEWAY_PRIVATE_TOKEN: process.env.GATEWAY_PRIVATE_TOKEN,
  SEND_BATCH: process.env.SEND_BATCH || '20'
};
if (!env.ENCRYPTION_KEY) {
  console.error('ENCRYPTION_KEY 가 설정되지 않았습니다. .env 를 확인하세요.');
  process.exit(1);
}

const bodyOf = (req) => new Promise((resolve, reject) => {
  const chunks = []; let size = 0;
  req.on('data', (c) => { size += c.length; if (size > 6_000_000) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});

const server = createServer(async (nodeReq, nodeRes) => {
  try {
    const proto = nodeReq.headers['x-forwarded-proto'] || 'http';
    const url = `${proto}://${nodeReq.headers.host}${nodeReq.url}`;
    const hasBody = !['GET', 'HEAD'].includes(nodeReq.method);
    const request = new Request(url, {
      method: nodeReq.method,
      headers: nodeReq.headers,
      body: hasBody ? await bodyOf(nodeReq) : undefined
    });
    const pending = [];
    const ctx = { waitUntil: (p) => pending.push(Promise.resolve(p).catch((e) => console.error(e))) };
    const response = await handleRequest(request, env, ctx);
    const headers = {};
    response.headers.forEach((v, k) => { if (k !== 'set-cookie') headers[k] = v; });
    const cookies = response.headers.getSetCookie?.() ?? [];
    if (cookies.length) headers['set-cookie'] = cookies;
    nodeRes.writeHead(response.status, headers);
    nodeRes.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    console.error(e);
    if (!nodeRes.headersSent) nodeRes.writeHead(500);
    nodeRes.end('internal error');
  }
});

// Workers 의 Cron 대신 10초마다 발송 큐 처리, 매 정각에 파기/정리
let lastHour = -1;
let busy = false;
setInterval(async () => {
  if (busy) return;
  busy = true;
  try {
    const now = new Date();
    const hourKey = now.getUTCHours() + now.getUTCDate() * 24;
    // 정각 작업은 시간당 1회만 실행되도록 minute=0 으로 호출
    const when = hourKey !== lastHour ? Math.floor(Date.now() / 3600000) * 3600000 : Date.now();
    lastHour = hourKey;
    await runScheduled(env, when);
    await runGroupwareCron(env, when);   // 그룹웨어 메일 직접 가져오기(같은 1분 주기)
  } catch (e) { console.error('scheduled error', e); } finally { busy = false; }
}, 10_000);

server.listen(PORT, HOST, () => console.log(`interview-sms (node) listening on http://${HOST}:${PORT}`));
