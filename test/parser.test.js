import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReply, normalizePhone, isValidMobile } from '../src/parser.js';

const cases = [
  ['참석', 'attending'], ['참석합니다', 'attending'], ['네 참석하겠습니다', 'attending'], ['넵', 'attending'],
  ['1', 'attending'], ['갈게요', 'attending'], ['참석 가능합니다!', 'attending'], ['ㅇㅇ', 'attending'],
  ['불참', 'absent'], ['불참합니다', 'absent'], ['미참', 'absent'], ['참석 못합니다', 'absent'],
  ['참석 어렵습니다', 'absent'], ['죄송하지만 참석이 어려울 것 같습니다', 'absent'], ['2', 'absent'],
  ['안 갈게요', 'absent'], ['아니요', 'absent'], ['참석 불가', 'absent'], ['불참석', 'absent'],
  ['언제인가요?', 'unclear'], ['', 'unclear'], ['시간 변경 가능한가요', 'attending'] // '가능' 포함: 현재 규칙상 참석 — 알려진 한계, docs/PARSING_RULES.md 참고
];

for (const [text, want] of cases) {
  test(`parseReply(${JSON.stringify(text)}) = ${want}`, () => assert.equal(parseReply(text), want));
}

test('normalizePhone', () => {
  assert.equal(normalizePhone('010-1234-5678'), '01012345678');
  assert.equal(normalizePhone('+82 10-1234-5678'), '01012345678');
  assert.equal(normalizePhone('1012345678'), '01012345678');
  assert.ok(isValidMobile('01012345678'));
  assert.ok(!isValidMobile('0212345678'));
});
