// 의존성 없는 CSV 파서 + 지원자 명단 컬럼 매핑
export function parseCsv(text) {
  const s = String(text ?? '').replace(/^﻿/, '');
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',' || c === '\t') { row.push(cell); cell = ''; }
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

// 반환: { candidates: [{site,name,phone,interview_at}], errors: [string] }
// requireSite=false 이면 사업장 열이 없어도 된다(화면에서 사업장을 직접 입력한 경우)
export function candidatesFromCsv(text, { requireSite = true } = {}) {
  const rows = parseCsv(text);
  if (rows.length < 2) return { candidates: [], errors: ['데이터 행이 없습니다.'] };
  const header = rows[0].map((h) => h.trim().toLowerCase().replace(/\s/g, ''));
  const idx = {};
  for (const [key, names] of Object.entries(ALIASES)) {
    idx[key] = header.findIndex((h) => names.includes(h));
  }
  const errors = [];
  if (idx.phone < 0) errors.push('"전화번호" 컬럼을 찾을 수 없습니다.');
  if (idx.site < 0 && requireSite) errors.push('"사업장"(또는 원가중심점) 컬럼을 찾을 수 없습니다. 화면의 사업장 칸에 직접 적어도 됩니다.');
  if (errors.length) return { candidates: [], errors };
  const get = (r, k) => (idx[k] >= 0 ? (r[idx[k]] ?? '').trim() : '');
  const candidates = rows.slice(1).map((r) => ({
    site: get(r, 'site'),
    name: get(r, 'name'),
    phone: get(r, 'phone'),
    interview_at: get(r, 'interview_at')
  }));
  return { candidates, errors };
}

export function toCsv(rows) {
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + rows.map((r) => r.map(esc).join(',')).join('\r\n');
}
