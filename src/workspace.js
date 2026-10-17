// 지원자 관리 작업 공간의 공통 조각: 위쪽 탭, 자동 수집 연결 상태, 정리할 공고 수
import { all, first } from './d1.js';
import { icon } from './views.js';

// 일의 순서대로(새 지원 → 지원자 → 공고 정리 → 면접 이력). 연결 설정은 오른쪽 끝.
export function peopleTabs(active, pending = 0, todo = 0) {
  const t = (key, href, label, cnt = 0, warn = false) =>
    `<a href="${href}"${active === key ? ' aria-current="page"' : ''}>${label}${cnt ? `<span class="cnt${warn ? ' warn' : ''}" aria-label="${cnt}건">${cnt}</span>` : ''}</a>`;
  return `<nav class="wstabs" aria-label="지원자 관리 메뉴">${t('inbox', '/applicants/inbox', '새 지원', pending)}${
    t('list', '/applicants', '지원자')}${
    t('postings', '/applicants/postings', '공고 정리', todo, true)}${
    t('history', '/people', '면접 이력')}<a class="push" href="/applicants/inbox/connect"${active === 'connect' ? ' aria-current="page"' : ''}>${icon('settings', 16)}연결 설정</a></nav>`;
}

// 자동 수집 연결 상태(서버가 아는 것만): 내 확장이 최근에 시스템에 접속했는지
export function connState(a) {
  if (!a.hasKey) return { cls: '', text: '자동 수집 설정 필요', hint: '연결 설정에서 한 번만 설정해요' };
  if (!a.lastUsedAt) return { cls: 'idle', text: '확장 프로그램 연결 대기', hint: '확장을 설치하고 이 PC 크롬에서 연결 설정을 열어 주세요' };
  const min = Math.round((Date.now() - a.lastUsedAt) / 60000);
  if (min <= 15) return { cls: 'on', text: '자동 수집 켜짐', hint: min <= 1 ? '방금 확인했어요' : `${min}분 전 확인` };
  const when = min < 120 ? `${min}분 전` : min < 2880 ? `${Math.round(min / 60)}시간 전` : `${Math.round(min / 1440)}일 전`;
  return { cls: 'idle', text: '자동 수집 멈춤', hint: `마지막 확인 ${when} · 크롬이 꺼져 있을 수 있어요` };
}

// 확장 프로그램(내 PC 크롬)이 지금 연락처 요청을 처리하지 못하는 상태인지: 키가 없거나 15분 넘게 접속이 없음
export function agentIdle(a) {
  return !a.hasKey || !a.lastUsedAt || Date.now() - a.lastUsedAt > 15 * 60000;
}
// 연락처 요청이 멈춰 있을 때 무엇을 하면 되는지
export function stalledText(a) {
  if (!a.hasKey) return '아직 연락처 자동 가져오기를 설정하지 않았어요. 연결 설정에서 확장 프로그램을 한 번만 설치해 주세요.';
  if (!a.lastUsedAt) return '확장 프로그램이 아직 한 번도 연결되지 않았어요. 확장을 설치한 PC의 크롬에서 연결 설정을 열어 주세요.';
  const min = Math.round((Date.now() - a.lastUsedAt) / 60000);
  const when = min < 120 ? `${min}분 전` : min < 2880 ? `${Math.round(min / 60)}시간 전` : `${Math.round(min / 1440)}일 전`;
  return `확장 프로그램이 깔린 PC 크롬이 꺼져 있어요(마지막 연결 ${when}). 그 PC에서 크롬을 켜면 자동으로 이어서 채워져요.`;
}

// 원가중심점이 비어 있는 공고 수(지원 건 + 수신함 대기 건)
export async function unclassifiedPostings(db) {
  const r = await first(db, `SELECT COUNT(DISTINCT recruit_no) n FROM (
      SELECT recruit_no FROM applicant_applications WHERE recruit_no != '' AND applied_to = ''
      UNION SELECT recruit_no FROM applicant_inbox WHERE status='pending' AND recruit_no != '' AND cost_center = '')`);
  return r ? r.n : 0;
}

// 공고 제목의 대괄호 안(예: [아마노코리아(주)])에서 고객사 이름을 뽑는다
export function bracketName(title) {
  const m = String(title || '').match(/\[([^\]]{1,60})\]/);
  if (!m) return '';
  return m[1].replace(/\(주\)|㈜|\(유\)|주식회사|\s+/g, '').trim();
}

// 원가중심점 목록에서 비슷한 이름을 제안한다(목록이 없으면 빈 배열)
export async function suggestCostCenters(db, title, limit = 4) {
  const core = bracketName(title);
  if (core.length < 2) return [];
  const rows = await all(db, `SELECT name FROM cost_centers WHERE name LIKE ? ORDER BY name LIMIT ?`, '%' + core.replace(/[%_]/g, '') + '%', limit);
  return rows.map((r) => r.name);
}

// 여러 제목의 제안을 한꺼번에(같은 고객사 이름은 한 번만 찾는다). 반환: Map(제목 → 이름 배열)
export async function suggestForTitles(db, titles, limit = 3) {
  const byCore = new Map();
  const out = new Map();
  for (const t of new Set(titles)) {
    const core = bracketName(t);
    if (!core) { out.set(t, []); continue; }
    if (!byCore.has(core)) byCore.set(core, await suggestCostCenters(db, t, limit));
    out.set(t, byCore.get(core));
  }
  return out;
}
