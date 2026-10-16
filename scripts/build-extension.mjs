// 크롬 확장(tools/albamon-extension)을 Worker 안에서 내려받을 수 있도록 src/extension-bundle.js 로 묶는다.
// 확장 파일을 고친 뒤에는 이 스크립트를 실행한다(npm run deploy 가 자동으로 실행).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'tools', 'albamon-extension');
const names = ['manifest.json', 'background.js', 'popup.html', 'popup.js', 'README.md'];
const files = {};
for (const n of names) files[n] = readFileSync(join(dir, n), 'utf8').replace(/\r\n/g, '\n');
const version = JSON.parse(files['manifest.json']).version;
const out = `// 자동 생성 파일 — 직접 고치지 마세요. (node scripts/build-extension.mjs)\nexport const EXTENSION_VERSION = ${JSON.stringify(version)};\nexport const EXTENSION_FILES = ${JSON.stringify(files, null, 1)};\n`;
writeFileSync(join(root, 'src', 'extension-bundle.js'), out);
console.log('extension-bundle.js 생성:', names.length, '개 파일, 버전', version);
