// 답장 문자 해석. 규칙은 docs/PARSING_RULES.md 와 test/parser.test.js 에 고정되어 있다.
// 반환: 'attending' | 'absent' | 'unclear'

const NEGATIVE = [
  '불참', '미참', '불가', '못가', '못갑', '못감', '못올', '못와', '못해', '못할', '못참석',
  '안가', '안갈', '안갑', '안감', '못갈', '안올', '안와', '안할', '안참석', '참석못', '참석안', '참석어렵', '참석힘들',
  '어렵', '힘들', '힘듭', '곤란', '취소', '포기', '죄송', '사양', '아니요', '아니오', '아뇨', '안됩', '안되',
  '안돼', '없습니다', '어려울', '불참석', '미참석', '거절', '노쇼'
];

const POSITIVE = [
  '참석', '참여', '갈게', '갑니다', '가겠', '가능', '방문', '출석', '올게', '오겠', '하겠', '확인했', '확인하였',
  '넵', '네', '예', '옙', '좋습니다', '알겠', '감사'
];

function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    // NFKC 는 한글 자모(ㅇㅇ)를 변형하므로 쓰지 않고 전각 숫자만 변환한다
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\s.,!?~^*'"()\[\]{}]/g, '');
}

export function parseReply(text, extra = {}) {
  const t = normalize(text);
  if (!t) return 'unclear';
  // 질문형 문의("변경 가능한가요?")는 긍정으로 오인하지 않도록 부정 검사 후 unclear 처리
  const isQuestion = /[?？]|한가요|인가요|되나요|있나요|할까요|될까요|하나요|가요$/.test(String(text ?? '').replace(/\s/g, ''));

  const negative = [...NEGATIVE, ...(extra.negative ?? [])];
  const positive = [...POSITIVE, ...(extra.positive ?? [])];

  // 숫자만 온 경우: 1 = 참석, 2 = 불참
  if (/^[12]$/.test(t)) return t === '1' ? 'attending' : 'absent';

  // 부정 표현을 먼저 검사한다. ("불참"에 "참"이 들어있기 때문)
  if (negative.some((k) => t.includes(k))) return 'absent';
  if (isQuestion) return 'unclear';
  if (positive.some((k) => t.includes(k))) return 'attending';
  if (/^(ㅇㅇ|ㅇㅋ|ok|okay|yes|y)$/.test(t)) return 'attending';
  if (/^(ㄴㄴ|no|n)$/.test(t)) return 'absent';
  return 'unclear';
}

// 일정 변경 요청("다른 날로 바꿀 수 있나요?", "다음 주로 미뤄 주세요")인지. 참석/불참 판정과는 따로 표시만 한다.
const RESCHEDULE = ['변경', '바꿀', '바꾸', '바꿔', '바뀔', '다른날', '다른시간', '다른요일', '다른일정', '미룰', '미뤄', '미루', '연기', '조정', '늦춰', '당겨', '다음주', '다음날', '다른때'];
export function isRescheduleRequest(text) {
  const t = normalize(text);
  return !!t && RESCHEDULE.some((k) => t.includes(k));
}

// 일정 고르기 답장 해석. n = 후보 개수. 반환: { result: 'attending'|'absent'|'unclear', slot?: 1..n, positive?: true }
//  - 번호 하나(1~n)만 있으면 그 일정으로 참석. ("2번이요", "1 가능합니다")
//  - 시각·날짜 숫자(14시, 10/21, 14:00, 21일)는 번호로 보지 않는다.
//  - 번호와 부정 표현이 함께 있거나 번호가 여러 개면 사람이 확인한다(unclear).
//  - 번호 없이 부정이면 불참, 번호 없이 긍정이면 positive 로 알려 준다(이미 일정이 정해진 사람이면 참석 유지).
export function parseSlotReply(text, n) {
  const t = normalize(text);
  if (!t) return { result: 'unclear' };
  const negative = NEGATIVE.some((k) => t.includes(k));
  const stripped = t
    .replace(/\d+[\/\-.]\d+/g, ' ')            // 10/21, 10-21
    .replace(/\d+(?=[:시월일분])/g, ' ')           // 14시, 10월, 21일, 14:00 의 앞 숫자
    .replace(/:\d+/g, ' ');                       // 14:00 의 뒤 숫자
  const nums = [...new Set((stripped.match(/\d+/g) || []).map(Number))];
  if (nums.length === 1 && nums[0] >= 1 && nums[0] <= n) {
    return negative ? { result: 'unclear' } : { result: 'attending', slot: nums[0] };
  }
  if (nums.length) return { result: 'unclear' };
  if (negative) return { result: 'absent' };
  const r = parseReply(text);
  return r === 'attending' ? { result: 'unclear', positive: true } : { result: 'unclear' };
}

// 전화번호를 숫자만 남기고 국내 형식(010...)으로 통일
export function normalizePhone(raw) {
  let d = String(raw ?? '').replace(/[^\d+]/g, '');
  if (d.startsWith('+82')) d = '0' + d.slice(3);
  else if (d.startsWith('82') && d.length >= 11) d = '0' + d.slice(2);
  d = d.replace(/\D/g, '');
  if (/^10\d{8,9}$/.test(d)) d = '0' + d; // 엑셀에서 앞의 0이 사라진 경우
  return d;
}

export function isValidMobile(phone) {
  return /^01[016789]\d{7,8}$/.test(phone);
}
