// 답장 AI 해석: 규칙(parser.js)으로 판단하지 못한 답장("22일 10시요", "다른 데 붙었어요")을 NVIDIA AI 로 한 번 더 본다.
// - 보내는 것: 답장 원문·일정 후보·정해진 면접 일시·오늘 날짜(질문이면 보낸 안내 문자, 이름·번호는 가림). 이름·전화번호는 보내지 않는다.
// - 확실할 때만 적용한다(아래 MIN). 실패·시간 초과·애매하면 그대로 "확인 필요"(담당자 확인)로 둔다.
// - 일정 변경 요청이면 원하는 일시를 뽑아 "새 일정으로 다시 안내" 칸에 미리 채운다(ai_wanted, 보내기는 담당자).
// - 질문이면 보낸 안내 문자 안의 정보로만 답장 초안을 만든다(ai_draft, 보내기는 담당자). 안내에 없으면 만들지 않는다.
// - 면접 안내와 연결되지 않은 문자(문자함 "일반 문자")는 종류·요약만 붙인다(aiReviewUnmatched).
// - 웹훅 응답을 늦추지 않도록 답장 저장 뒤 ctx.waitUntil 로 돈다. 그 사이 새 답장이 오면 적용하지 않는다.
import { first, run } from './d1.js';
import { renderTemplate, SLOT_CONFIRM_TEMPLATE } from './core.js';
import { askJson, jsonOf, todayKst, WHEN_SPEC, resolveWhen } from './ai.js';
import { parseInterviewAt } from './reminders.js';

const MIN = 0.8;              // 이 이상 확실할 때만 적용
const MIN_OVERRIDE = 0.9;     // 규칙이 "불참"이라 본 것을 참석으로 바꿀 때
const INTENTS = ['attending', 'absent', 'reschedule', 'question', 'unclear'];
const LABEL = { attending: '참석', absent: '불참', reschedule: '일정 변경 요청', question: '질문', unclear: '애매함' };

const SYSTEM = `너는 면접 안내 문자에 온 지원자 답장을 분류한다. JSON 한 개만 출력한다.
형식: {"intent":"attending|absent|reschedule|question|unclear","slot":번호 또는 null,"wanted":일시 객체 또는 null,"confidence":0~1,"note":"담당자용 한 줄 요약(30자 이내)"}
- attending: 면접에 오겠다는 뜻. 일정 후보가 있으면 고른 후보 번호를 slot 에 넣는다. 날짜·시각·요일·"첫번째"처럼 말해도 후보 하나와 같으면 그 번호. 후보에 없는 날짜·시각이면 reschedule.
- absent: 오지 않겠다, 지원 취소, 다른 곳에 합격·취업했다.
- reschedule: 다른 날짜·시각을 원함. 원하는 일시가 있으면 wanted 에 일시 객체로(없으면 null).
- question: 질문(장소, 주차, 준비물 등)만 있음.
- unclear: 판단 어려움. 조금이라도 애매하면 confidence 를 0.6 이하로 낮춘다.
${WHEN_SPEC}`;

const DRAFT_SYSTEM = `너는 채용 담당자를 돕는다. 지원자 질문에 대한 짧은 답장 문자 초안을 쓴다. JSON 한 개만 출력한다.
형식: {"answerable":true|false,"reply":"답장 문자(존댓말, 2문장 이내, 90자 이내)"}
- 반드시 "보낸 안내 문자"에 적힌 정보만 쓴다. 안내 문자에 답이 없으면 answerable=false, reply 는 빈 문자열.
- 추측하거나 새로운 사실(주차 가능, 시간 변경 등)을 만들지 않는다. 이름은 쓰지 않는다.`;

// 모델 답(객체)을 검사해 { intent, slot, wanted, confidence, note } 로. 형식이 틀리면 null.
export function normalizeAi(j, nSlots, now = Date.now(), message = '') {
  if (typeof j === 'string') j = jsonOf(j);
  if (!j || !INTENTS.includes(j.intent)) return null;
  const slot = Number.isInteger(j.slot) && j.slot >= 1 && j.slot <= nSlots ? j.slot : null;
  const confidence = Math.max(0, Math.min(1, Number(j.confidence) || 0));
  // 원하는 일시: 날짜 계산은 코드가 하고(resolveWhen), 시스템이 읽을 수 있을 때만 쓴다
  let wanted = resolveWhen(j.wanted, now, message);
  if (wanted && !Number.isFinite(parseInterviewAt(wanted, now))) wanted = '';
  return { intent: j.intent, slot, wanted, confidence, note: String(j.note ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) };
}

// 반환: { intent, slot, wanted, confidence, note } | { error } | null(꺼짐)
export async function classifyReply(env, { message, slots = [], interviewAt = '', now = Date.now() }) {
  const user = [
    `오늘: ${todayKst(now)}`,
    `정해진 면접 일시: ${slots.length ? (interviewAt ? `${interviewAt}(이미 고름)` : '(후보 중 고르는 중)') : (interviewAt || '안내문 참고')}`,
    `일정 후보: ${slots.length ? slots.map((s, i) => `${i + 1}) ${s}`).join(' / ') : '없음'}`,
    `답장: ${String(message).slice(0, 500)}`
  ].join('\n');
  const j = await askJson(env, { system: SYSTEM, user });
  if (!j || j.error) return j;
  return normalizeAi(j, slots.length, now, message) || { error: 'bad output' };
}

// 보낸 안내 문자에서 이름·전화번호를 가린다(AI 로 보내기 전)
export function maskGuide(text, cand) {
  let s = String(text || '');
  if (cand.name && cand.name.length >= 2) s = s.split(cand.name).join('OOO');
  return s.replace(/01[016789][-\s.]?\d{3,4}[-\s.]?\d{4}/g, '010-XXXX-XXXX').slice(0, 1500);
}

// 질문 답장 초안. 반환: 문자열(못 만들면 '')
export async function draftAnswer(env, { question, guide }) {
  if (!guide.trim()) return '';
  const j = await askJson(env, { system: DRAFT_SYSTEM, user: `보낸 안내 문자:\n${guide}\n\n지원자 질문: ${String(question).slice(0, 300)}` });
  if (!j || j.error || j.answerable !== true) return '';
  return String(j.reply ?? '').replace(/\s+\n/g, '\n').trim().slice(0, 200);
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

  // 일정 변경 요청: 원하는 일시(담당자가 확인 후 보냄) / 질문: 답장 초안(담당자가 확인 후 보냄)
  const wanted = kind === 'reschedule' && ai.intent === 'reschedule' ? ai.wanted : '';
  let draft = '';
  if (ai.intent === 'question' && status === 'unclear') draft = await draftAnswer(env, { question: message, guide: maskGuide(cand.message_text, cand) });

  const label = `AI: ${LABEL[ai.intent]}${ai.slot && slotText ? `(${ai.slot}번 일정)` : ''}${wanted ? `(${wanted} 희망)` : ''}${sure ? '' : ' 추정'}${ai.note ? ` · ${ai.note}` : ''}`.slice(0, 120);
  const changed = slotText && slotText !== cand.interview_at;
  // 조건(replied_at=at)을 다시 걸어 그 사이 새 답장이 들어온 경우 덮어쓰지 않는다
  const r = await run(db,
    `UPDATE candidates SET status=?, reply_kind=?, ai_note=?, ai_wanted=?, ai_draft=?${slotText ? ', interview_at=?' : ''}${changed ? ', reminded_at=NULL, reminded_prev_at=NULL' : ''}
      WHERE id=? AND replied_at=? AND manual=0`,
    ...[status, kind, label, wanted, draft, ...(slotText ? [slotText] : []), cand.id, at]);
  if (!r?.meta?.changes) return { applied: false };
  if (changed) {
    await run(db, `INSERT INTO messages (gateway_id,phone,text,status,user_id,at,scheduled_at) VALUES (?,?,?,'scheduled',NULL,?,?)`,
      cand.camp_gateway, cand.phone, renderTemplate(SLOT_CONFIRM_TEMPLATE, { ...cand, interview_at: slotText }), now, now);
  }
  if (status !== cand.status) {
    await run(db, `UPDATE inbound SET result=? WHERE candidate_id=? AND received_at=?`, status, cand.id, at);
  }
  return { applied: status !== cand.status || kind !== (cand.reply_kind || ''), result: status, kind, slot: slotText, wanted, draft: !!draft, note: label };
}

// ---------------- 면접 안내와 연결되지 않은 문자(문자함 "일반 문자") ----------------
const KINDS = { apply: '지원 문의', interview: '면접 관련', work: '업무 연락', ad: '광고·스팸', other: '기타' };
const UNMATCHED_SYSTEM = `회사 채용 담당 휴대폰으로 온 문자를 분류한다. JSON 한 개만 출력한다.
형식: {"kind":"apply|interview|work|ad|other","note":"담당자용 한 줄 요약(30자 이내, 이름·번호 쓰지 않음)"}
- apply: 채용·지원·근무 조건 문의 / interview: 면접 참석·일정·장소 이야기 / work: 회사 업무 연락 / ad: 광고·스팸·인증번호·안내 문자 / other: 그 밖`;

export async function aiReviewUnmatched(env, { gatewayId, phone, message, at }) {
  const j = await askJson(env, { system: UNMATCHED_SYSTEM, user: `문자: ${String(message).slice(0, 500)}`, maxTokens: 800 });
  if (!j || j.error || !KINDS[j.kind]) return { applied: false, error: j?.error || (j ? 'bad output' : undefined) };
  const note = `AI: ${KINDS[j.kind]}${j.note ? ` · ${String(j.note).replace(/\s+/g, ' ').trim().slice(0, 60)}` : ''}`;
  await run(env.DB, `UPDATE inbound SET ai_note=? WHERE gateway_id=? AND sender=? AND received_at=? AND candidate_id IS NULL`, note, gatewayId, phone, at);
  return { applied: true, kind: j.kind, note };
}
