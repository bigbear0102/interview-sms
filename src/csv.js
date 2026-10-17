// 의존성 없는 CSV 파서 + 지원자 명단 컬럼 매핑
// 엑셀에서 표를 복사해 붙여넣으면 탭으로 구분된 글자가 된다(TSV). 첫 줄에 탭이 있으면 탭만 구분자로 쓰고,
// 아니면 쉼표만 구분자로 쓴다. (칸 안에 쉼표가 있어도 엑셀 붙여넣기는 깨지지 않는다)
import { normalizePhone, isValidMobile } from './parser.js';

export function parseCsv(text) {
  const s = String(text ?? '').replace(/^﻿/, '');
  const firstLine = s.split(/\r\n|\r|\n/).find((l) => l.trim() !== '') ?? '';
  const delim = firstLine.includes('\t') ? '\t' : ',';
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}

const ALIASES = {
  site: ['사업장', '사업장명', '사업장(원가중심점)', '원가중심점', '원가중심점명', '원가센터', '코스트센터', '코스트센터명',
    'costcenter', 'cost_center', 'cost-center', '사업장코드', '지점', '지점명', '점포', '점포명', '근무지', 'site'],
  name: ['이름', '성명', '지원자', '지원자명', 'name'],
  phone: ['전화번호', '휴대폰', '휴대폰번호', '연락처', '핸드폰', '핸드폰번호', 'phone', 'mobile'],
  interview_at: ['면접일시', '면접일', '면접시간', '일시', '면접', 'interview', 'interview_at']
};

// 제목 줄이 없는 표(엑셀에서 데이터만 복사한 경우)는 칸의 내용을 보고 열을 추정한다.
//   전화번호: 휴대폰 번호 모양인 칸 / 면접일시: 날짜·시간 모양인 칸 / 나머지 글자 칸: 앞에서부터 사업장, 이름
const isPhoneCell = (v) => isValidMobile(normalizePhone(v));
const isWhenCell = (v) => {
  const t = String(v || '').trim();
  if (!t || isPhoneCell(t)) return false;
  return /\d{1,2}\s*[:시]\s*\d{0,2}/.test(t) || /\d{1,2}\s*[\/.\-월]\s*\d{1,2}/.test(t);
};

function inferColumns(rows) {
  const width = Math.max(...rows.map((r) => r.length));
  const sample = rows.slice(0, 30);
  const ratio = (col, fn) => {
    const vals = sample.map((r) => (r[col] ?? '').trim()).filter((v) => v !== '');
    return vals.length ? vals.filter(fn).length / vals.length : 0;
  };
  let phone = -1, best = 0;
  for (let c = 0; c < width; c++) {
    const r = ratio(c, isPhoneCell);
    if (r > best) { best = r; phone = c; }
  }
  if (best < 0.5) return null;
  let when = -1; best = 0;
  for (let c = 0; c < width; c++) {
    if (c === phone) continue;
    const r = ratio(c, isWhenCell);
    if (r > best) { best = r; when = c; }
  }
  if (best < 0.5) when = -1;
  const rest = [];
  for (let c = 0; c < width; c++) if (c !== phone && c !== when) rest.push(c);
  // 글자 칸이 둘 이상이면 (사업장, 이름) 순서, 하나면 이름
  const site = rest.length >= 2 ? rest[0] : -1;
  const name = rest.length >= 2 ? rest[1] : rest.length === 1 ? rest[0] : -1;
  return { site, name, phone, interview_at: when };
}

// 열 위치를 이미 알 때(AI 가 맞춘 경우) 명단을 만든다. hasHeader=true 면 첫 줄은 건너뛴다
export function candidatesFromRows(rows, idx, hasHeader = true) {
  const get = (r, k) => (idx[k] >= 0 ? (r[idx[k]] ?? '').trim() : '');
  return (hasHeader ? rows.slice(1) : rows).map((r) => ({ site: get(r, 'site'), name: get(r, 'name'), phone: get(r, 'phone'), interview_at: get(r, 'interview_at') }));
}

// 반환: { candidates: [{site,name,phone,interview_at}], errors: [string], inferred: boolean }
// requireSite=false 이면 사업장 열이 없어도 된다(화면에서 사업장을 직접 입력한 경우)
export function candidatesFromCsv(text, { requireSite = true } = {}) {
  const rows = parseCsv(text);
  if (rows.length < 1) return { candidates: [], errors: ['데이터 행이 없습니다.'], inferred: false };
  const header = rows[0].map((h) => h.trim().toLowerCase().replace(/\s/g, ''));
  let idx = {};
  for (const [key, names] of Object.entries(ALIASES)) {
    idx[key] = header.findIndex((h) => names.includes(h));
  }
  let dataRows = rows.slice(1);
  let inferred = false;
  if (idx.phone < 0) {
    // 제목 줄이 없거나 알 수 없는 이름: 내용으로 추정한다
    const guess = inferColumns(rows);
    if (!guess) {
      return {
        candidates: [],
        errors: rows.length < 2
          ? ['데이터 행이 없습니다.']
          : ['전화번호 칸을 찾지 못했어요. 휴대폰 번호가 들어 있는 열이 있는지 확인해 주세요. (제목 줄에 "전화번호"라고 적어도 돼요)'],
        inferred: false
      };
    }
    idx = guess;
    inferred = true;
    // 첫 줄이 제목이면(전화번호 칸이 번호 모양이 아니면) 건너뛴다
    const firstIsData = isPhoneCell(rows[0][idx.phone] ?? '');
    dataRows = firstIsData ? rows : rows.slice(1);
  } else if (rows.length < 2) {
    return { candidates: [], errors: ['데이터 행이 없습니다.'], inferred: false };
  }
  const errors = [];
  if (idx.site < 0 && requireSite) errors.push('"사업장"(또는 원가중심점) 컬럼을 찾을 수 없습니다. 화면의 사업장 칸에 직접 적어도 됩니다.');
  if (errors.length) return { candidates: [], errors, inferred };
  const get = (r, k) => (idx[k] >= 0 ? (r[idx[k]] ?? '').trim() : '');
  const candidates = dataRows.map((r) => ({
    site: get(r, 'site'),
    name: get(r, 'name'),
    phone: get(r, 'phone'),
    interview_at: get(r, 'interview_at')
  }));
  return { candidates, errors, inferred };
}

export function toCsv(rows) {
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + rows.map((r) => r.map(esc).join(',')).join('\r\n');
}
