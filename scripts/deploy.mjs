// 안전한 배포: 테스트 → (원격 DB 마이그레이션 적용) → Worker 배포 → 상태 확인
// 순서를 지키지 않으면 새 코드가 아직 없는 컬럼을 읽어 운영이 깨질 수 있다. 어느 단계든 실패하면 즉시 멈춘다.
//   사용: npm run deploy            (전체)
//         npm run deploy -- --skip-tests   (테스트 생략: 긴급 시에만)
//         npm run deploy -- --dry-run      (실제 변경 없이 순서만 출력)
import { spawnSync } from 'node:child_process';

const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry-run');
const URL_BASE = process.env.DEPLOY_HEALTH_URL || 'https://interview.bigbears.me';

function step(title, cmd, cmdArgs, { retries = 0 } = {}) {
  console.log(`\n▶ ${title}`);
  if (DRY) { console.log(`   (dry-run) ${cmd} ${cmdArgs.join(' ')}`); return; }
  for (let i = 0; i <= retries; i++) {
    const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit', shell: true });
    if (r.status === 0) return;
    if (i < retries) console.log(`   실패 — ${i + 2}번째 시도를 합니다…`);
  }
  console.error(`\n✖ "${title}" 단계가 실패했어요. 배포를 중단합니다. (이전 단계까지의 변경은 이미 적용되었을 수 있어요)`);
  process.exit(1);
}

// 0) 작업 트리 상태 알림 (커밋되지 않은 변경이 있으면 알려 준다)
const dirty = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8', shell: true }).stdout.trim();
if (dirty) console.log('⚠ 커밋되지 않은 변경이 있어요. 배포는 현재 작업 폴더 기준으로 진행돼요.');

step('0/4 확장 프로그램 묶음 갱신', 'node', ['scripts/build-extension.mjs']);
if (!args.has('--skip-tests')) step('1/4 테스트', 'npm', ['test']);
step('2/4 원격 DB 마이그레이션 적용 (코드 배포보다 먼저)', 'npx', ['wrangler', 'd1', 'migrations', 'apply', 'interview-sms', '--remote'], { retries: 2 });
step('3/4 Worker 배포', 'npx', ['wrangler', 'deploy'], { retries: 1 });

// 4) 상태 확인: /healthz 가 DB 까지 정상이어야 한다
console.log('\n▶ 4/4 상태 확인');
if (DRY) {
  console.log(`   (dry-run) GET ${URL_BASE}/healthz`);
} else {
  let ok = false;
  for (let i = 0; i < 6 && !ok; i++) {
    await new Promise((r) => setTimeout(r, i === 0 ? 2000 : 4000));
    try {
      const res = await fetch(`${URL_BASE}/healthz`, { headers: { 'cache-control': 'no-cache' } });
      const body = await res.json().catch(() => ({}));
      ok = res.ok && body.ok === true && body.db === true;
      console.log(`   ${i + 1}회차: HTTP ${res.status} ${JSON.stringify(body)}`);
    } catch (e) {
      console.log(`   ${i + 1}회차: 연결 실패 (${e.message})`);
    }
  }
  if (!ok) {
    console.error('\n✖ 배포는 끝났지만 상태 확인에 실패했어요. 즉시 확인하세요:');
    console.error('   npx wrangler tail            # 실시간 로그');
    console.error('   npx wrangler rollback        # 직전 버전으로 되돌리기');
    process.exit(1);
  }
}
console.log('\n✓ 배포 완료');
