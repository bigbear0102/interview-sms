import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EXTENSION_FILES } from '../src/extension-bundle.js';
import { makeZip } from '../src/zip.js';

test('확장 묶음이 tools/albamon-extension 과 같다(고친 뒤 build-extension 실행 필요)', () => {
  for (const [n, body] of Object.entries(EXTENSION_FILES)) {
    const disk = readFileSync(new URL('../tools/albamon-extension/' + n, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    assert.equal(body, disk, n + ' 이(가) 묶음과 달라요. node scripts/build-extension.mjs 를 실행하세요.');
  }
});

test('ZIP 구조가 맞다(끝 기록, 파일 이름, 내용 크기)', () => {
  const zip = makeZip({ 'a.txt': '안녕', 'dir/b.txt': 'hello' });
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = zip.length - 22;
  assert.equal(v.getUint32(end, true), 0x06054b50);
  assert.equal(v.getUint16(end + 10, true), 2);
  let p = v.getUint32(end + 16, true);
  const names = [];
  for (let i = 0; i < 2; i++) {
    assert.equal(v.getUint32(p, true), 0x02014b50);
    const size = v.getUint32(p + 24, true);
    const nl = v.getUint16(p + 28, true);
    const off = v.getUint32(p + 42, true);
    names.push(new TextDecoder().decode(zip.slice(p + 46, p + 46 + nl)));
    assert.equal(v.getUint32(off, true), 0x04034b50);
    assert.equal(v.getUint32(off + 18, true), size);
    p += 46 + nl;
  }
  assert.deepEqual(names, ['a.txt', 'dir/b.txt']);
});
