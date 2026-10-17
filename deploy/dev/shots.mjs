// 디자인 검토용 스크린샷: render-preview.mjs 가 만든 HTML 을 데스크톱(1280)·모바일(390) 폭으로 찍는다.
// 사용(CI): node deploy/dev/render-preview.mjs out && node deploy/dev/shots.mjs out shots
// playwright 는 CI 에서만 설치한다(npm i --no-save playwright).
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
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
  ['campaign_slots']
];
const browser = await chromium.launch();
for (const [w, tag] of [[1280, 'pc'], [390, 'm']]) {
  const page = await browser.newPage({ viewport: { width: w, height: 900 }, deviceScaleFactor: 1 });
  for (const [name, act, suffix] of SHOTS) {
    await page.goto('file://' + resolve(src, name + '.html'));
    await page.waitForTimeout(300);
    if (act) await act(page);
    const file = `${out}/${tag}-${name}${suffix ? '-' + suffix : ''}.png`;
    await page.screenshot({ path: file, fullPage: true });
    console.log(file);
  }
  await page.close();
}
await browser.close();
