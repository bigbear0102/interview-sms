// UI 공통 요소: 아이콘, 표시 형식(전화번호/시각), 상태 뱃지, 진행 막대, 페이지 머리말
// 규칙: 화면에 보이는 값은 여기 함수를 거친다 (전화번호는 010-0000-0000, 시각은 "오늘 13:58" 식).
import { esc, icon } from './views.js';
export { icon };

// ---- 전화번호: 01012345678 → 010-1234-5678 ----
export function fmtPhone(p) {
  const d = String(p ?? '').replace(/\D/g, '');
  if (/^01\d{9}$/.test(d)) return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
  if (/^01\d{8}$/.test(d)) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  return String(p ?? '');
}

// ---- 시각: 한국 시간 기준 "오늘 13:58", "어제 13:58", "10/15(수) 13:58", 해가 다르면 "2025/10/15 13:58" ----
const KST = 9 * 3600000;
const DOW = ['일', '월', '화', '수', '목', '금', '토'];
export function fmtWhen(ms, now = Date.now()) {
  if (!ms) return '';
  const d = new Date(ms + KST), n = new Date(now + KST);
  const p = (x) => String(x).padStart(2, '0');
  const hm = `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  const dayKey = (x) => Math.floor(x.getTime() / 86400000);
  const diff = dayKey(d) - dayKey(n);
  if (diff === 0) return `오늘 ${hm}`;
  if (diff === -1) return `어제 ${hm}`;
  if (diff === 1) return `내일 ${hm}`;
  const md = `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}(${DOW[d.getUTCDay()]})`;
  return d.getUTCFullYear() === n.getUTCFullYear() ? `${md} ${hm}` : `${d.getUTCFullYear()}/${md} ${hm}`;
}

// ---- 상태 뱃지 ----
const BADGES = {
  // 면접 안내 응답
  attending: ['ok', '참석'], absent: ['no', '불참'], unclear: ['review', '확인 필요'],
  sent: ['wait', '답 없음'], pending: ['mute', '보내는 중'], sending: ['mute', '보내는 중'], failed: ['fail', '못 보냄'],
  // 문자 상태
  scheduled: ['info', '예약됨'], cancelled: ['mute', '취소함'],
  // 면접 안내(캠페인) 상태
  draft: ['mute', '아직 안 보냄'], done: ['ok', '모두 보냄'],
  unmatched: ['mute', '일반 문자']
};
export function badge(key, labelOverride) {
  const [tone, label] = BADGES[key] || ['mute', key];
  return `<span class="badge ${tone}">${esc(labelOverride || label)}</span>`;
}
// 문자 목록(보낸/받은)에서 쓰는 상태: 보낸 문자의 sent 는 "보냄"
// 문자 서버가 접수만 했고 폰이 아직 보내지 않은 상태(delivery='queued')
export function phoneWaitBadge(at) {
  const age = at ? Date.now() - at : 0;
  if (age > 24 * 3600000) return '<span class="badge mute" title="하루가 지나 더 이상 확인하지 않아요">보냄(전달 확인 안 됨)</span>';
  const late = age > 10 * 60000;
  return late
    ? '<span class="badge fail" title="폰이 꺼져 있거나 앱의 Cloud server가 꺼져 있을 수 있어요">폰이 아직 안 보냈어요</span>'
    : '<span class="badge wait" title="문자 서버가 받았고, 폰이 보내기를 기다리고 있어요">폰 전달 대기</span>';
}
export function messageBadge(dir, result, delivery = '', at = 0) {
  if (dir === 'out' && result === 'sent') {
    if (delivery === 'delivered') return '<span class="badge ok">전달됨</span>';
    if (delivery === 'failed') return '<span class="badge fail">전달 실패</span>';
    if (delivery === 'queued') return phoneWaitBadge(at);
    return '<span class="badge ok">보냄</span>';
  }
  if (dir === 'out' && result === 'sending') return '<span class="badge mute">보내는 중</span>';
  if (dir === 'out' && result === 'failed') return '<span class="badge fail">못 보냄</span>';
  return badge(result);
}

// 표의 열 머리글(색 뱃지)과 숫자(0 이면 흐리게, 있으면 색 뱃지)
export const colHead = (label, tone) => `<span class="badge ${tone}">${esc(label)}</span>`;
export const colCount = (n, tone) => (Number(n) ? `<span class="badge ${tone}">${Number(n)}</span>` : '<span class="muted">0</span>');

// ---- 응답 구성 막대 (참석/불참/확인 필요/답 없음) ----
export function responseBar({ attending = 0, absent = 0, unclear = 0, noreply = 0 }) {
  const total = attending + absent + unclear + noreply;
  if (!total) return '<div class="rbar none" role="img" aria-label="아직 보낸 사람이 없어요"></div>';
  const seg = (n, cls, label) => (n ? `<span class="${cls}" style="flex:${n}" title="${label} ${n}명"></span>` : '');
  return `<div class="rbar" role="img" aria-label="참석 ${attending}명, 불참 ${absent}명, 확인 필요 ${unclear}명, 답 없음 ${noreply}명">${
    seg(attending, 'yes', '참석')}${seg(absent, 'no', '불참')}${seg(unclear, 'review', '확인 필요')}${seg(noreply, 'wait', '답 없음')}</div>`;
}

// ---- 페이지 머리말: 제목 + 설명 + 오른쪽 주요 동작 ----
export function pageHeader({ title, desc = '', actions = '', back = '' }) {
  return `<header class="phead">
    <div>${back ? `<a class="back" href="${esc(back.href)}">← ${esc(back.label)}</a>` : ''}
      <h1>${esc(title)}</h1>${desc ? `<p class="desc">${desc}</p>` : ''}</div>
    ${actions ? `<div class="pactions">${actions}</div>` : ''}
  </header>`;
}

// 스크롤 가능한 표 틀 (좁은 화면에서 표가 화면 밖으로 밀리지 않게)
export const tableWrap = (html, cls = '') => `<div class="table-wrap ${cls}">${html}</div>`;

// 숫자 카드
export const stat = ({ value, label, tone = '', href = '' }) =>
  `${href ? `<a class="stat ${tone}" href="${esc(href)}">` : `<div class="stat ${tone}">`}<b>${esc(value)}</b><span>${esc(label)}</span>${href ? '</a>' : '</div>'}`;

export const emptyState = ({ title, desc = '', action = '' }) =>
  `<div class="empty"><p class="empty-title">${esc(title)}</p>${desc ? `<p class="muted">${desc}</p>` : ''}${action}</div>`;
