// 디자인 검토용 스크린샷: render-preview.mjs 가 만든 HTML 을 데스크톱(1280)·모바일(390) 폭으로 찍는다.
// 사용(CI): node deploy/dev/render-preview.mjs out && node deploy/dev/shots.mjs out shots
// playwright 는 CI 에서만 설치한다(npm i --no-save playwright).
import { chromium } from 'playwright';
import { mkdirSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const [src, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
// [파일, 찍기 전 동작(선택), 결과 이름 꼬리표]
const SHOTS = [
  ['home'],
  ['inbox'],
  ['applicants'],
  ['applicants', async (p) => { await p.check('.rowchk >> nth=0'); await p.check('.rowchk >> nth=1'); }, 'selected'],
  ['applicant_detail'],
  ['campaign_new_prefill'],
  ['campaign_new', async (p) => { await p.check('input[name=kind][value=slots]'); await p.fill('#slots', '10/21(화) 14:00\n10/22(수) 10:00'); }, 'slots'],
  ['campaign_detail'],
  ['campaign_slots'],
  // 진행 카드(기다리는 동안 걸린 시간·단계): 화면 아래 고정이라 보이는 화면만 찍는다
  ['campaign_new', async (p) => {
    await p.evaluate(() => { const b = window.opBusy('면접 안내 만드는 중'); b.log('서버가 요청을 받았어요'); b.log('명단 12줄을 읽었어요'); b.log('면접일시 2개를 AI가 형식에 맞추는 중…'); });
    await p.waitForTimeout(2300);
    return 'viewport';
  }, 'busy']
];
// SHOTS_ALL=1 이면 미리보기의 모든 화면을 찍는다(전체 검토용)
if (process.env.SHOTS_ALL === '1') {
  for (const f of readdirSync(src).filter((x) => x.endsWith('.html')).map((x) => x.slice(0, -5)).sort()) if (!SHOTS.some(([n, a]) => n === f && !a)) SHOTS.push([f]);
}
const overflow = [];
const browser = await chromium.launch();
for (const [w, tag] of [[1280, 'pc'], [390, 'm']]) {
  const page = await browser.newPage({ viewport: { width: w, height: 900 }, deviceScaleFactor: 1 });
  for (const [name, act, suffix] of SHOTS) {
    await page.goto('file://' + resolve(src, name + '.html'));
    await page.waitForTimeout(300);
    const how = act ? await act(page) : null;
    // 가로 넘침 검사: 화면 폭보다 넓으면 실패로 남긴다
    const sw = await page.evaluate(() => document.documentElement.scrollWidth);
    if (sw > w) { overflow.push(`${tag}-${name}${suffix ? '-' + suffix : ''}: ${sw}px > ${w}px`); }
    const file = `${out}/${tag}-${name}${suffix ? '-' + suffix : ''}.png`;
    await page.screenshot({ path: file, fullPage: how !== 'viewport' });
    console.log(file);
  }
  await page.close();
}
await browser.close();
if (overflow.length) { console.error('가로 넘침:\n' + overflow.join('\n')); process.exitCode = 1; }
