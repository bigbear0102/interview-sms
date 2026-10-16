import { test } from 'node:test';
import assert from 'node:assert/strict';
import { candidatesFromCsv, parseCsv } from '../src/csv.js';

test('엑셀 붙여넣기(탭 구분): 제목 줄이 있으면 순서와 상관없이 인식', () => {
  const tsv = '이름\t전화번호\t사업장\t면접일시\n홍길동\t010-1234-5678\t아마노코리아(현장HR)\t10/20 14:00\n김영희\t01023456789\t아마노코리아(현장HR)\t10/20 14:30';
  const r = candidatesFromCsv(tsv);
  assert.equal(r.errors.length, 0);
  assert.equal(r.inferred, false);
  assert.deepEqual(r.candidates[0], { site: '아마노코리아(현장HR)', name: '홍길동', phone: '010-1234-5678', interview_at: '10/20 14:00' });
  assert.equal(r.candidates.length, 2);
});

test('엑셀 붙여넣기: 제목 줄 없이 데이터만 붙여도 열을 추정', () => {
  const tsv = '아마노코리아(현장HR)\t홍길동\t010-1234-5678\t10/20 14:00\n아마노코리아(현장HR)\t김영희\t010-2345-6789\t10/20 14:30\n';
  const r = candidatesFromCsv(tsv);
  assert.equal(r.errors.length, 0);
  assert.equal(r.inferred, true);
  assert.equal(r.candidates.length, 2); // 첫 줄도 데이터로 읽는다
  assert.equal(r.candidates[0].site, '아마노코리아(현장HR)');
  assert.equal(r.candidates[0].name, '홍길동');
  assert.equal(r.candidates[1].interview_at, '10/20 14:30');
});

test('엑셀 붙여넣기: 사업장 열 없이 이름·전화번호만 붙이고 사업장은 화면에서 입력', () => {
  const r = candidatesFromCsv('홍길동\t010-1234-5678\n김영희\t010-2345-6789', { requireSite: false });
  assert.equal(r.errors.length, 0);
  assert.equal(r.candidates.length, 2);
  assert.equal(r.candidates[0].name, '홍길동');
  assert.equal(r.candidates[0].site, '');
  // 사업장이 필요한데 없으면 안내
  const need = candidatesFromCsv('홍길동\t010-1234-5678', { requireSite: true });
  assert.ok(need.errors.length);
});

test('엑셀 붙여넣기: 앞의 0이 사라진 번호, 칸 안의 쉼표, 알 수 없는 제목도 처리', () => {
  const r = candidatesFromCsv('지점\t성함\tHP\t시간\n서울, 강남\t홍길동\t1012345678\t10/20 14:00', { requireSite: true });
  // 제목을 못 알아봐도 내용(번호 모양)으로 추정하고, 제목 줄은 건너뛴다
  assert.equal(r.errors.length, 0);
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].site, '서울, 강남');
  assert.equal(r.candidates[0].phone, '1012345678'); // 정규화는 명단 등록 단계에서 수행
});

test('기존 CSV(쉼표) 입력은 그대로 동작', () => {
  const r = candidatesFromCsv('사업장,이름,전화번호,면접일시\nA점,홍길동,010-1111-2222,10/20 14:00\n');
  assert.equal(r.errors.length, 0);
  assert.equal(r.candidates.length, 1);
  assert.equal(parseCsv('a,b\n1,2').length, 2);
});

test('전화번호가 하나도 없으면 쉬운 안내', () => {
  const r = candidatesFromCsv('홍길동\t서울\n김영희\t부산');
  assert.equal(r.candidates.length, 0);
  assert.match(r.errors[0], /전화번호/);
});
