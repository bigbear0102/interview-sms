// 답장 AI 해석: 규칙(parser.js)으로 판단하지 못한 답장("22일 10시요", "다른 데 붙었어요")을 NVIDIA AI 로 한 번 더 본다.
// - NVIDIA API(build.nvidia.com, OpenAI 호환). 키는 시크릿 NVIDIA_API_KEY, 없으면 아무것도 하지 않는다(규칙만).
// - 보내는 것: 답장 원문·일정 후보·정해진 면접 일시·오늘 날짜. 이름·전화번호는 보내지 않는다.
// - 확실할 때만 적용한다(아래 MIN). 실패·시간 초과·애매하면 그대로 "확인 필요"(담당자 확인)로 둔다.
// - 웹훅 응답을 늦추지 않도록 답장 저장 뒤 ctx.waitUntil 로 돈다. 그 사이 새 답장이 오면 적용하지 않는다.
// - 시험 중에는 실제 API 에 접속하지 않는다(env.AI_FETCH 가짜를 넣어야 동작, AGENTS 규칙 14).
import { first, run } from './d1.js';
import { renderTemplate, SLOT_CONFIRM_TEMPLATE } from './core.js';

export const AI_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
export const AI_MODEL = 'openai/gpt-oss-20b';   // 2026-10-17 시험: 한국어 답장 10건 중 9건 정답, 1건은 "애매"(안전), 1~3초
const MIN = 0.8;              // 이 이상 확실할 때만 적용
const MIN_OVERRIDE = 0.9;     // 규칙이 "불참"이라 본 것을 참석으로 바꿀 때
const INTENTS = ['attending', 'absent', 'reschedule', 'question', 'unclear'];
const LABEL = { attending: '참석', absent: '불참', reschedule: '일정 변경 요청', question: '질문', unclear: '애매함' };
const underTest = () => typeof process !== 'undefined' && !!(process.env && process.env.NODE_TEST_CONTEXT);

const SYSTEM = `너는 면접 안내 문자에 온 지원자 답장을 분류한다. JSON 한 개만 출력한다.
형식: {"intent":"attending|absent|reschedule|question|unclear","slot":번호 또는 null,"confidence":0~1,"note":"담당자용 한 줄 요약(30자 이내)"}
- attending: 면접에 오겠다는 뜻. 일정 후보가 있으면 고른 후보 번호를 slot 에 넣는다. 날짜·시각·요일·"첫번째"처럼 말해도 후보 하나와 같으면 그 번호. 후보에 없는 날짜·시각이면 reschedule.
- absent: 오지 않겠다, 지원 취소, 다른 곳에 합격·취업했다.
- reschedule: 다른 날짜·시각을 원함.
- question: 질문(장소, 주차, 준비물 등)만 있음.
- unclear: 판단 어려움. 조금이라도 애매하면 confidence 를 0.6 이하로 낮춘다.`;

const WEEK = '일월화수목금토';
function todayKst(now) {
  const d = new Date(now + 9 * 3600000);
  return `${d.toISOString().slice(0, 10)}(${WEEK[d.getUTCDay()]})`;
}

// 모델 답(문자열)을 검사해 { intent, slot, confidence, note } 로. 형식이 틀리면 null.
export function normalizeAi(content, nSlots) {
  const m = String(content ?? '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  let j;
  try { j = JSON.parse(m[0]); } catch { return null; }
  if (!INTENTS.includes(j.intent)) return null;
  const slot = Number.isInteger(j.slot) && j.slot >= 1 && j.slot <= nSlots ? j.slot : null;
  const confidence = Math.max(0, Math.min(1, Number(j.confidence) || 0));
  return { intent: j.intent, slot, confidence, note: String(j.note ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) };
}

// 반환: { intent, slot, confidence, note } | { error } | null(꺼짐)
export async function classifyReply(env, { message, slots = [], interviewAt = '', now = Date.now() }) {
  if (!env?.NVIDIA_API_KEY || env.AI_REPLY === 'off') return null;
  const doFetch = env.AI_FETCH || (env.NO_REAL_NETWORK || underTest() ? null : fetch);
  if (!doFetch) return null;
  const user = [
    `오늘: ${todayKst(now)}`,
    `정해진 면접 일시: ${slots.length ? (interviewAt ? `${interviewAt}(이미 고름)` : '(후보 중 고르는 중)') : (interviewAt || '안내문 참고')}`,
    `일정 후보: ${slots.length ? slots.map((s, i) => `${i + 1}) ${s}`).join(' / ') : '없음'}`,
    `답장: ${String(message).slice(0, 500)}`
  ].join('\n');
  try {
    const r = await doFetch(AI_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.NVIDIA_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: env.AI_MODEL || AI_MODEL, temperature: 0, max_tokens: 1200, reasoning_effort: 'low',
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }] }),
      signal: AbortSignal.timeout(Number(env.AI_TIMEOUT_MS) || 20000)
    });
    if (!r.ok) return { error: `http ${r.status}` };
    const j = await r.json();
    return normalizeAi(j?.choices?.[0]?.message?.content, slots.length) || { error: 'bad output' };
  } catch (e) {
    return { error: e?.name === 'TimeoutError' ? 'timeout' : 'network' };
  }
}

// 규칙 결과를 AI 로 다시 볼지: 확인 필요는 항상, 불참은 긴 문장일 때만("늦어서 죄송해요 참석할게요"처럼 "죄송"만 보고 불참이 된 경우)
export function needsAi(result, message) {
  if (result === 'unclear') return true;
  if (result === 'absent') return String(message ?? '').replace(/[\s.,!?~]/g, '').length > 6;
  return false;
}

// 답장 저장 뒤(handleInbound) 호출. 반환: { applied, result?, note? } — 적용했으면 applied=true
export async function aiReviewReply(env, { candidateId, message, at, now = Date.now() }) {
  const db = env.DB;
  const cand = await first(db,
    `SELECT c.*, k.slots camp_slots, k.gateway_id camp_gateway, k.purged_at camp_purged FROM candidates c JOIN campaigns k ON k.id=c.campaign_id WHERE c.id=?`, candidateId);
  // 그 사이 새 답장이 왔거나, 담당자가 직접 정했거나, 규칙 결과가 바뀌었으면 손대지 않는다
  if (!cand || cand.camp_purged || cand.replied_at !== at || cand.manual || !needsAi(cand.status, message)) return { applied: false };
  const slots = cand.template_override ? [] : String(cand.camp_slots || '').split('\n').map((x) => x.trim()).filter(Boolean);
  const ai = await classifyReply(env, { message, slots, interviewAt: cand.interview_at, now });
  if (!ai || ai.error) return { applied: false, error: ai?.error };

  let status = cand.status, slotText = '', kind = cand.reply_kind || '';
  const sure = ai.confidence >= (cand.status === 'absent' ? MIN_OVERRIDE : MIN);
  if (sure && ai.intent === 'attending') {
    if (slots.length) {
      if (ai.slot) { slotText = slots[ai.slot - 1]; status = 'attending'; }
    } else if (kind !== 'reschedule') status = 'attending';
  } else if (sure && ai.intent === 'absent' && kind !== 'reschedule') status = 'absent';
  else if (sure && ai.intent === 'reschedule') { kind = 'reschedule'; if (status === 'absent') status = 'unclear'; }

  const label = `AI: ${LABEL[ai.intent]}${ai.slot && slotText ? `(${ai.slot}번 일정)` : ''}${sure ? '' : ' 추정'}${ai.note ? ` · ${ai.note}` : ''}`.slice(0, 120);
  const changed = slotText && slotText !== cand.interview_at;
  // 조건(replied_at=at)을 다시 걸어 그 사이 새 답장이 들어온 경우 덮어쓰지 않는다
  const r = await run(db,
    `UPDATE candidates SET status=?, reply_kind=?, ai_note=?${slotText ? ', interview_at=?' : ''}${changed ? ', reminded_at=NULL, reminded_prev_at=NULL' : ''}
      WHERE id=? AND replied_at=? AND manual=0`,
    ...[status, kind, label, ...(slotText ? [slotText] : []), cand.id, at]);
  if (!r?.meta?.changes) return { applied: false };
  if (changed) {
    await run(db, `INSERT INTO messages (gateway_id,phone,text,status,user_id,at,scheduled_at) VALUES (?,?,?,'scheduled',NULL,?,?)`,
      cand.camp_gateway, cand.phone, renderTemplate(SLOT_CONFIRM_TEMPLATE, { ...cand, interview_at: slotText }), now, now);
  }
  if (status !== cand.status) {
    await run(db, `UPDATE inbound SET result=? WHERE candidate_id=? AND received_at=?`, status, cand.id, at);
  }
  return { applied: status !== cand.status || kind !== (cand.reply_kind || ''), result: status, kind, slot: slotText, note: label };
}

