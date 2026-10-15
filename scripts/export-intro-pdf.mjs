// 소개 페이지(/)를 발표용 PDF(16:9, 장당 한 쪽)로 내보낸다.
// 사용: npm run export:intro   →  exports/문자관리시스템_소개.pdf
// 크롬(또는 엣지)이 설치되어 있어야 한다. 환경변수 CHROME 으로 경로를 직접 지정할 수 있다.
import { mkdirSync, writeFileSync, existsSync, mkdtempSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { renderLanding } from '../src/landing.js';

const candidates = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].filter(Boolean);
const chrome = candidates.find((p) => existsSync(p));
if (!chrome) { console.error('크롬/엣지를 찾지 못했어요. CHROME 환경변수에 경로를 지정해 주세요.'); process.exit(1); }

// 16:9(1280x720) 한 장씩. 화면용 고정 바/쪽 번호는 숨기고 장표가 한 쪽에 들어가도록 여백을 줄인다.
const PRINT_CSS = `<style>
@page{size:1280px 720px;margin:0}
html{scroll-snap-type:none!important}
body{background:#fff!important;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.top,.pg{display:none!important}
.slide{min-height:0!important;height:720px;padding:44px 72px!important;break-after:page;page-break-after:always;overflow:hidden;border:0!important;align-items:center}
.slide:last-child{break-after:auto;page-break-after:auto}
.g2{grid-template-columns:1fr 1fr!important}.g3{grid-template-columns:repeat(3,1fr)!important}.g4{grid-template-columns:repeat(4,1fr)!important}
.slide{align-items:center!important}
.flow .card{flex:1 1 0!important}
h1{font-size:60px!important}h2{font-size:38px!important}.lead{font-size:22px!important}
.list li{font-size:18px!important}
</style>`;
const html = renderLanding({ loggedIn: false }).replace('</head>', PRINT_CSS + '</head>');

const work = mkdtempSync(join(tmpdir(), 'intro-pdf-'));
const src = join(work, 'intro.html');
writeFileSync(src, html);
mkdirSync('exports', { recursive: true });
const out = join('exports', '문자관리시스템_소개.pdf');
const tmpPdf = join(work, 'intro.pdf'); // 크롬은 한글 경로를 못 쓰는 경우가 있어 임시 파일로 만든 뒤 복사한다
execFileSync(chrome, ['--headless', '--disable-gpu', '--no-pdf-header-footer', '--virtual-time-budget=4000',
  `--print-to-pdf=${tmpPdf}`, pathToFileURL(src).href], { stdio: 'ignore' });
if (!existsSync(tmpPdf)) { console.error('PDF 를 만들지 못했어요.'); process.exit(1); }
copyFileSync(tmpPdf, out);
console.log('저장했어요:', out);
