import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findPhones, pickPhone, isRevealText, looksLikeDeduction, nameMatches, looksLikeLogin } from '../tools/albamon-agent/lib.mjs';

test('전화번호 찾기: 모양이 달라도 숫자만 남기고 중복 제거', () => {
  assert.deepEqual(findPhones('연락처 010-1234-5678 / 01012345678 / 010 1234 5678'), ['01012345678']);
  assert.deepEqual(findPhones('대표 02-123-4567, 휴대폰 011-234-5678'), ['0112345678']);
  assert.deepEqual(findPhones('번호 없음'), []);
});

test('번호 고르기: "연락처/휴대폰" 표시 근처를 우선', () => {
  const text = '회사 대표번호 010-0000-1111\n이름 홍길동\n연락처 010-5555-6666\n주소 서울';
  assert.equal(pickPhone(text), '01055556666');
  assert.equal(pickPhone('그냥 010-7777-8888 입니다'), '01077778888');
  assert.equal(pickPhone('없음'), '');
});

test('연락처 보기 버튼 글 판별', () => {
  for (const t of ['연락처 보기', '연락처보기', '전화번호 확인', '휴대폰 번호 보기', '연락처 열람']) assert.ok(isRevealText(t), t);
  for (const t of ['이력서 보기', '지원하기', '', '연락처 보기 버튼을 눌러 이용권을 사용하면 연락처를 확인할 수 있습니다']) assert.ok(!isRevealText(t), t);
});

test('이용권 차감·결제 확인 창은 감지해서 멈춘다', () => {
  assert.ok(looksLikeDeduction('이용권 1개가 차감됩니다. 계속하시겠습니까?'));
  assert.ok(looksLikeDeduction('열람권을 사용하시겠습니까?'));
  assert.ok(!looksLikeDeduction('연락처를 불러오는 중입니다'));
});

test('이름 확인(마스킹 허용), 로그인 화면 판별', () => {
  assert.ok(nameMatches('이름 홍길동 지원', '홍길동'));
  assert.ok(nameMatches('이름 홍*동 지원', '홍길동'));
  assert.ok(nameMatches('이름 김*은', '김주은'));
  assert.ok(!nameMatches('이름 박민수', '홍길동'));
  assert.ok(looksLikeLogin({ url: 'https://www.albamon.com/user-account/login?next=/x' }));
  assert.ok(looksLikeLogin({ url: 'https://x/y', hasPassword: true }));
  assert.ok(!looksLikeLogin({ url: 'https://www.albamon.com/jobs/1' }));
});
