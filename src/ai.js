// NVIDIA AI(build.nvidia.com, OpenAI 호환) 공용 호출. 기능별 코드는 reply-ai.js, ai-features.js.
// - 키는 시크릿 NVIDIA_API_KEY. 없거나 AI=off(또는 예전 이름 AI_REPLY=off)면 모든 AI 기능이 꺼지고 규칙만 쓴다.
// - 실패·시간 초과는 { error } 로 돌려준다. 부르는 쪽은 언제나 AI 없이도 동작해야 한다.
// - 시험 중에는 실제 API 에 접속하지 않는다(env.AI_FETCH 가짜를 넣어야 동작, AGENTS 규칙 14).
export const AI_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
export const AI_MODEL = 'openai/gpt-oss-20b';   // 2026-10-17 시험: 한국어 답장 15건 모두 정답, 1~4초
const underTest = () => typeof process !== 'undefined' && !!(process.env && process.env.NODE_TEST_CONTEXT);

export const aiEnabled = (env) => !!env?.NVIDIA_API_KEY && env.AI !== 'off' && env.AI_REPLY !== 'off';

function fetcher(env) {
  if (env.AI_FETCH) return env.AI_FETCH;
  return env.NO_REAL_NETWORK || underTest() ? null : fetch;
}

// 반환: { content } | { error } | null(꺼짐)
export async function askAi(env, { system, user, maxTokens = 1200, timeoutMs = 20000 }) {
  if (!aiEnabled(env)) return null;
  const doFetch = fetcher(env);
  if (!doFetch) return null;
  try {
    const r = await doFetch(AI_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.NVIDIA_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: env.AI_MODEL || AI_MODEL, temperature: 0, max_tokens: maxTokens, reasoning_effort: 'low',
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
      signal: AbortSignal.timeout(Number(env.AI_TIMEOUT_MS) || timeoutMs)
    });
    if (!r.ok) return { error: `http ${r.status}` };
    const j = await r.json();
    const content = j?.choices?.[0]?.message?.content;
    return typeof content === 'string' && content.trim() ? { content } : { error: 'empty' };
  } catch (e) {
    return { error: e?.name === 'TimeoutError' ? 'timeout' : 'network' };
  }
}

// 모델 답에서 JSON 한 덩어리를 꺼낸다(앞뒤 설명이 붙어도). 없으면 null
export function jsonOf(content) {
  const s = String(content ?? '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

// JSON 으로 답하는 AI 호출. 반환: 객체 | { error } | null
export async function askJson(env, opts) {
  const r = await askAi(env, opts);
  if (!r || r.error) return r;
  return jsonOf(r.content) || { error: 'bad output' };
}

const WEEK = '일월화수목금토';
export function todayKst(now = Date.now()) {
  const d = new Date(now + 9 * 3600000);
  return `${d.toISOString().slice(0, 10)}(${WEEK[d.getUTCDay()]})`;
}

// ---------------- 날짜 계산은 코드가 한다 ----------------
// AI 는 날짜 계산(요일·다음주)을 자주 틀린다(2026-10-17 실제 시험: 토요일 기준 "다음주 월요일" → 금요일).
// 그래서 AI 에게는 표현만 나눠 받고(아래 WHEN_SPEC), 실제 날짜는 resolveWhen 이 계산한다.
export const WHEN_SPEC = `일시 객체 형식: {"month":숫자|null,"day":숫자|null,"dayOffset":숫자|null,"weekday":"월|화|수|목|금|토|일"|null,"weekOffset":숫자|null,"time":"HH:MM"|null}
- 직접 계산하지 말고 표현을 그대로 나눈다. "10/25"·"25일" → month/day(월이 없으면 month=null). "오늘"=dayOffset 0, "내일"=1, "모레"=2.
- "이번주 화요일" → weekday "화", weekOffset 0. "다음주 화요일" → weekday "화", weekOffset 1. 그냥 "화요일" → weekday "화", weekOffset null.
- time 은 24시간제("오후 2시"→"14:00", "10시반"→"10:30"). 시각이 없거나 "오전"처럼 모호하면 null.`;

const WD = { 일: 0, 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6 };
// 반환: "MM/DD(요일) HH:MM" | '' (날짜·시각이 둘 다 분명할 때만)
// text(원래 표현)를 주면 요일·"다음주"·"내일"은 원문에서 직접 읽어 AI 값을 덮어쓰고, 날짜와 요일이 안 맞으면 버린다.
export function resolveWhen(w, now = Date.now(), text = null) {
  if (!w || typeof w !== 'object') return '';
  if (text !== null) {
    const t = String(text).replace(/\s+/g, '');
    const hasDate = /\d{1,2}[\/.월]\d{1,2}|\d{1,2}일(?!요)/.test(t);
    // "다음주 화요일", "다음주 화 2시", "화요일", "27일(화)"
    const m1 = t.match(/(다다음주|다음주|담주|이번주|금주)([월화수목금토일])/) || t.match(/()([월화수목금토일])요일/) || t.match(/()\(([월화수목금토일])\)/) || t.match(/()\d일([월화수목금토])/);
    const wdm = m1 ? [m1[0], m1[1] || undefined, m1[2]] : null;
    const rel = t.match(/오늘|내일|모레|글피/);
    w = { ...w };
    if (hasDate) {
      if (!Number.isInteger(w.day)) return '';
      w.dayOffset = null; w.weekday = null;
      w.checkWeekday = wdm ? wdm[2] : null;
    } else if (wdm) {
      w.day = null; w.month = null; w.dayOffset = null;
      w.weekday = wdm[2];
      w.weekOffset = !wdm[1] ? null : /다다음/.test(wdm[1]) ? 2 : /다음|담/.test(wdm[1]) ? 1 : 0;
    } else if (rel) {
      w.day = null; w.month = null; w.weekday = null;
      w.dayOffset = { 오늘: 0, 내일: 1, 모레: 2, 글피: 3 }[rel[0]];
    } else return '';   // 원문에 날짜 표현이 없으면 AI 가 지어낸 날짜를 쓰지 않는다
    // 시각: 원문의 "N시"와 AI 의 시각이 맞아야 한다(오후면 +12)
    const hm = t.match(/(\d{1,2})시/), am = String(w.time ?? '').match(/^(\d{1,2}):/);
    if (hm && am && Number(am[1]) % 12 !== Number(hm[1]) % 12) return '';
  }
  const tm = String(w.time ?? '').match(/^(\d{1,2}):(\d{2})$/);
  if (!tm || Number(tm[1]) > 23 || Number(tm[2]) > 59) return '';
  const today = new Date(now + 9 * 3600000);
  const base = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const DAY = 86400000;
  let d = null;
  const int = (v) => (Number.isInteger(v) ? v : null);
  if (int(w.day) !== null) {
    const day = w.day, month = int(w.month) ?? today.getUTCMonth() + 1;
    if (month < 1 || month > 12 || day < 1 || day > 31) return '';
    let t = Date.UTC(today.getUTCFullYear(), month - 1, day);
    if (new Date(t).getUTCDate() !== day) return '';
    if (int(w.month) === null && t < base) t = Date.UTC(today.getUTCFullYear(), month, day);   // "5일"이 지났으면 다음 달
    else if (t < base - 60 * DAY) t = Date.UTC(today.getUTCFullYear() + 1, month - 1, day);  // 한참 지났으면 내년
    d = t;
  } else if (int(w.dayOffset) !== null && w.dayOffset >= 0 && w.dayOffset <= 14) {
    d = base + w.dayOffset * DAY;
  } else if (w.weekday in WD) {
    const wd = WD[w.weekday], cur = today.getUTCDay();
    if (int(w.weekOffset) !== null && w.weekOffset >= 0 && w.weekOffset <= 4) {
      const monday = base - ((cur + 6) % 7) * DAY;   // 한 주는 월요일부터
      d = monday + ((wd + 6) % 7) * DAY + w.weekOffset * 7 * DAY;
    } else {
      d = base + ((wd - cur + 7) % 7) * DAY;           // 오늘 이후 가장 가까운 그 요일
    }
  }
  if (d === null || d < base) return '';
  const x = new Date(d);
  if (w.checkWeekday && '일월화수목금토'[x.getUTCDay()] !== w.checkWeekday) return '';   // "25일(화)"인데 25일이 화요일이 아니면
  const p2 = (n) => String(n).padStart(2, '0');
  return `${p2(x.getUTCMonth() + 1)}/${p2(x.getUTCDate())}(${'일월화수목금토'[x.getUTCDay()]}) ${p2(Number(tm[1]))}:${tm[2]}`;
}
