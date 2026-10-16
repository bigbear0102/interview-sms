// 에이전트의 순수 판단 로직 (브라우저 없이 시험할 수 있다)

export const PHONE_RE = /01[016789][-\s.]?\d{3,4}[-\s.]?\d{4}/g;

export const digits = (s) => String(s || '').replace(/\D/g, '');

// 글 속에서 휴대폰 번호를 모두 찾는다(숫자만, 중복 제거)
export function findPhones(text) {
  const out = [];
  for (const m of String(text || '').matchAll(PHONE_RE)) {
    const d = digits(m[0]);
    if (/^01[016789]\d{7,8}$/.test(d) && !out.includes(d)) out.push(d);
  }
  return out;
}

// 여러 번호 중 지원자의 연락처를 고른다: "연락처/휴대폰/전화" 표시 근처의 번호를 우선한다.
export function pickPhone(text) {
  const t = String(text || '');
  const all = findPhones(t);
  if (!all.length) return '';
  const lines = t.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (/(연락처|휴대폰|핸드폰|전화번호|휴대전화|mobile)/i.test(lines[i])) {
      const near = findPhones(lines.slice(i, i + 3).join(' '));
      if (near.length) return near[0];
    }
  }
  return all[0];
}

// 연락처를 보여 주는 버튼의 글
const REVEAL_PATTERNS = [
  /(연락처|전화번호|휴대폰|핸드폰|휴대전화).{0,6}(보기|확인|열람|조회)/,
  /(보기|확인|열람|조회).{0,6}(연락처|전화번호|휴대폰|핸드폰)/
];
export function isRevealText(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t || t.length > 24) return false;
  return REVEAL_PATTERNS.some((re) => re.test(t));
}

// 이용권 차감·결제 확인 창으로 보이는 글인지 (보이면 사람이 판단하도록 멈춘다)
const DEDUCT_RE = /(차감|이용권|열람권|포인트|결제|구매|사용하시겠|유료|잔여|캐시|상품)/;
export function looksLikeDeduction(text) {
  return DEDUCT_RE.test(String(text || ''));
}

// 이름이 페이지에 나오는지(마스킹 "김*은" 도 인정)
export function nameMatches(text, name) {
  const n = String(name || '').trim();
  if (!n) return false;
  const t = String(text || '');
  if (t.includes(n)) return true;
  if (n.length >= 2) {
    const masked = n[0] + '*'.repeat(Math.max(n.length - 2, 1)) + n[n.length - 1];
    return t.includes(masked) || t.includes(n[0] + '*' + n.slice(2));
  }
  return false;
}

// 로그인이 필요한 화면인지(주소 또는 비밀번호 입력칸)
export function looksLikeLogin({ url = '', hasPassword = false }) {
  return hasPassword || /(\/login|\/signin|user-account\/login|login\.)/i.test(String(url));
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const jitter = (min, max) => Math.floor(min + Math.random() * (max - min));
