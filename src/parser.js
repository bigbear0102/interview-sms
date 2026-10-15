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
