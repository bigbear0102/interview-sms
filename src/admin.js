// 설정 화면: 문자 보내는 폰 연결, 부서, 관리자. 처음 쓰는 사람도 순서대로 누르기만 하면 되도록 만든다.
import { all, first, run } from './d1.js';
import { esc, fmtTime, icon } from './views.js';
import { fmtPhone, fmtWhen, pageHeader, tableWrap, emptyState } from './ui.js';
import { encryptText, decryptText, randomToken, hashPassword } from './crypto.js';
import { registerWebhook, checkGateway, sendSms, unlockGateway } from './gateway.js';
import { monitorPhones, recentErrors } from './monitor.js';
import { normalizePhone, isValidMobile } from './parser.js';
import { listUsers, normalizeEmail } from './accounts.js';
import { phoneSetupSteps } from './pages-help.js';
import { sortDepartments } from './pages-auth.js';

// 폰 앱에 입력할 주소: .../api/3rdparty/v1 → .../api/mobile/v1
export const phoneApiUrl = (env) => (env.GATEWAY_URL || '').replace('/api/3rdparty/v1', '/api/mobile/v1');
// 공개 클라우드(api.sms-gate.app)를 쓰는지: 이 경우 폰 앱에 서버 주소/토큰을 넣지 않는다
export const isPublicCloud = (env) => (env.GATEWAY_URL || '').includes('://api.sms-gate.app');

async function loadGateway(db, env, id) {
  const row = await first(db, `SELECT * FROM gateways WHERE id=?`, Number(id));
  if (!row) throw new Error('폰을 찾을 수 없어요.');
  return unlockGateway(env, row);
}

// 반환: { ok: boolean, msg: string }
export async function applyAdminAction(db, env, f, publicBase) {
  try {
    switch (f.do) {
      case 'dept': {
        const name = (f.name || '').trim();
        if (!name) return { ok: false, msg: '부서 이름을 적어 주세요.' };
        await run(db, `INSERT INTO departments (name) VALUES (?)`, name);
        return { ok: true, msg: `부서 "${name}"을(를) 만들었어요.` };
      }

      case 'connect': {
        const username = (f.username || '').trim();
        const password = (f.password || '').trim();
        if (!username || !password) return { ok: false, msg: '폰 앱에 보이는 Username(아이디)과 Password(비밀번호)를 둘 다 적어 주세요.' };
        let departmentId = Number(f.department_id);
        const newDept = (f.new_department || '').trim();
        if (newDept) {
          const exist = await first(db, `SELECT id FROM departments WHERE name=?`, newDept);
          departmentId = exist ? exist.id : Number((await run(db, `INSERT INTO departments (name) VALUES (?)`, newDept)).meta.last_row_id);
        }
        if (!departmentId) return { ok: false, msg: '이 폰을 쓸 부서를 고르거나, 새 부서 이름을 적어 주세요.' };
        const dept = await first(db, `SELECT name FROM departments WHERE id=?`, departmentId);
        const name = (f.name || '').trim() || `${dept.name} 폰`;
        const r = await run(db,
          `INSERT INTO gateways (department_id,name,base_url,username,password,send_path,signing_key,hook_token,passphrase)
           VALUES (?,?,?,?,?,?,?,?,?)`, departmentId, name,
          env.GATEWAY_URL || 'https://api.sms-gate.app/3rdparty/v1', username,
          await encryptText(env.ENCRYPTION_KEY, password), '/messages', '', randomToken(18),
          (f.passphrase || '').trim() ? await encryptText(env.ENCRYPTION_KEY, f.passphrase.trim()) : '');
        const gw = await loadGateway(db, env, r.meta.last_row_id);
        try {
          await registerWebhook(gw, publicBase);
        } catch (e) {
          return { ok: false, msg: `폰은 등록했지만 답장 받는 설정이 안 됐어요. 아래 목록에서 "답장 받기 다시 설정"을 눌러 주세요. (${e.message})` };
        }
        return { ok: true, msg: `"${name}" 연결이 끝났어요! 아래 목록에서 "잘 연결됐는지 확인"을 눌러 보세요.` };
      }

      case 'gw_update': {
        const username = (f.username || '').trim();
        const password = (f.password || '').trim();
        if (!username || !password) return { ok: false, msg: 'Username과 Password를 둘 다 적어 주세요.' };
        await run(db, `UPDATE gateways SET username=?, password=?, base_url=? WHERE id=?`,
          username, await encryptText(env.ENCRYPTION_KEY, password), env.GATEWAY_URL || 'https://api.sms-gate.app/3rdparty/v1', Number(f.gateway_id));
        if (f.passphrase !== undefined && f.passphrase.trim() !== '') {
          await run(db, `UPDATE gateways SET passphrase=? WHERE id=?`, await encryptText(env.ENCRYPTION_KEY, f.passphrase.trim()), Number(f.gateway_id));
        }
        if (f.passphrase_off === '1') await run(db, `UPDATE gateways SET passphrase='' WHERE id=?`, Number(f.gateway_id));
        const gw = await loadGateway(db, env, f.gateway_id);
        await registerWebhook(gw, publicBase);
        return { ok: true, msg: '폰 정보를 바꾸고, 답장 받는 설정도 다시 했어요.' };
      }

      case 'gw_check': {
        const gw = await loadGateway(db, env, f.gateway_id);
        const r = await checkGateway(gw);
        if (!r.reachable) return { ok: false, msg: `"${gw.name}": 서버에 연결하지 못했어요. 잠시 후 다시 눌러 보세요. (${r.error})` };
        if (!r.count) return { ok: false, msg: `"${gw.name}": 서버와는 연결됐는데 폰이 보이지 않아요. 폰 앱에서 Online이 되어 있는지 봐 주세요.` };
        const seen = r.lastSeen ? fmtTime(new Date(r.lastSeen).getTime()) : '알 수 없음';
        return r.online
          ? { ok: true, msg: `"${gw.name}": 잘 연결되어 있어요. 문자를 보낼 수 있어요. (폰 마지막 응답 ${seen})` }
          : { ok: false, msg: `"${gw.name}": 폰이 한동안 응답하지 않았어요. (마지막 응답 ${seen}) 폰이 켜져 있는지, 앱이 Online인지 봐 주세요.` };
      }

      // 받기 시험: 폰이 자기 번호로 문자를 보내고, 그 문자가 서버로 알려지는지 기다려서 확인한다
      case 'gw_selftest': {
        const gw = await loadGateway(db, env, f.gateway_id);
        const number = normalizePhone(f.number || gw.own_number);
        if (!isValidMobile(number)) return { ok: false, msg: '이 폰의 전화번호(010으로 시작)를 칸에 적어 주세요.' };
        if (number !== gw.own_number) await run(db, `UPDATE gateways SET own_number=? WHERE id=?`, number, gw.id);
        const code = String(Math.floor(1000 + Math.random() * 9000));
        const text = `수신시험 ${code} 이 문자가 문자함에 보이면 성공이에요`;
        try {
          await sendSms(gw, number, text);
        } catch (e) {
          return { ok: false, msg: `시험 문자를 보내지 못했어요. (${e.message})` };
        }
        const deadline = Date.now() + (Number(env.SELFTEST_WAIT_MS) || 45000);
        for (;;) {
          const row = await first(db, `SELECT id FROM inbound WHERE gateway_id=? AND message LIKE ? ORDER BY id DESC LIMIT 1`, gw.id, `%수신시험 ${code}%`);
          if (row) return { ok: true, msg: '✅ 받기 시험에 성공했어요! 폰이 받은 문자를 서버로 잘 알려 주고 있어요.' };
          if (Date.now() >= deadline) break;
          await new Promise((r) => setTimeout(r, 1500));
        }
        return {
          ok: false,
          msg: '시험 문자는 보냈는데, 폰이 받은 문자를 서버로 알려 주지 않았어요. 폰 SMSGate 앱에서 ① Home의 "Start Service"가 켜져 있는지(Stop Service로 보이는지) ② 설정의 Webhooks에 항목이 있는지 ③ 폰 문자 앱에 시험 문자가 실제로 도착했는지 확인해 주세요. ④ 문자 앱의 채팅(RCS) 기능이 꺼져 있는지 확인해 주세요.'
        };
      }

      case 'monitor_now': {
        const res = await monitorPhones(env);
        const bad = res.filter((r) => r.health === 'down').length;
        return { ok: bad === 0, msg: res.length ? `폰 ${res.length}대를 점검했어요. ${bad ? `확인이 필요한 폰 ${bad}대가 있어요.` : '모두 정상이에요.'}` : '점검할 폰이 없어요.' };
      }

      case 'gw_hook': {
        const gw = await loadGateway(db, env, f.gateway_id);
        await registerWebhook(gw, publicBase);
        return { ok: true, msg: `"${gw.name}": 답장 받는 설정을 다시 했어요.` };
      }

      case 'gw_active': {
        const on = f.active === '1' ? 1 : 0;
        await run(db, `UPDATE gateways SET active=? WHERE id=?`, on, Number(f.gateway_id));
        return { ok: true, msg: on ? '이 폰을 다시 쓰도록 했어요.' : '이 폰을 쓰지 않도록 했어요. 문자 보낼 폰 목록에서 빠져요.' };
      }

      case 'gw_delete': {
        const id = Number(f.gateway_id);
        const g = await first(db, `SELECT id, name, active FROM gateways WHERE id=? AND deleted_at IS NULL`, id);
        if (!g) return { ok: false, msg: '지울 폰을 찾지 못했어요.' };
        if (g.active) return { ok: false, msg: '쓰고 있는 폰은 지울 수 없어요. 먼저 "이 폰 쓰지 않기"를 눌러 주세요.' };
        // 이 폰으로 보낼 예정인 문자가 남아 있으면 지우지 않는다
        const pending = (await first(db,
          `SELECT (SELECT COUNT(*) FROM messages WHERE gateway_id=? AND status IN ('scheduled','sending'))
                + (SELECT COUNT(*) FROM campaigns WHERE gateway_id=? AND status IN ('scheduled','sending')) n`, id, id)).n;
        if (pending > 0) return { ok: false, msg: '이 폰으로 보낼 예정인 문자나 면접 안내가 남아 있어요. 먼저 취소하거나 끝난 뒤에 지워 주세요.' };
        const refs = (await first(db,
          `SELECT (SELECT COUNT(*) FROM campaigns WHERE gateway_id=?) + (SELECT COUNT(*) FROM messages WHERE gateway_id=?)
                + (SELECT COUNT(*) FROM inbound WHERE gateway_id=?) n`, id, id, id)).n;
        if (refs === 0) {
          await run(db, `DELETE FROM gateways WHERE id=?`, id);
          return { ok: true, msg: `"${g.name}" 폰을 지웠어요.` };
        }
        // 기록이 있으면 행은 남기고 목록에서 숨긴다. 접속 정보(비밀번호, 암호화 비밀번호, 서명 키)와 웹훅 주소는 지운다.
        await run(db,
          `UPDATE gateways SET deleted_at=?, active=0, username='', password='', passphrase='', signing_key='', own_number='', hook_token=? WHERE id=?`,
          Date.now(), `deleted-${randomToken(16)}`, id);
        return { ok: true, msg: `"${g.name}" 폰을 지웠어요. 이미 보낸 문자와 면접 안내 기록은 그대로 남아 있어요.` };
      }

      case 'user': {
        const name = (f.name || '').trim();
        const email = normalizeEmail(f.email);
        if (!name || !email.includes('@') || (f.password || '').length < 8) return { ok: false, msg: '이름과 이메일을 적고, 비밀번호는 8글자 이상으로 해 주세요.' };
        if (await first(db, `SELECT id FROM users WHERE email=? OR username=?`, email, email)) return { ok: false, msg: '이미 같은 이메일이 있어요.' };
        const r = await run(db,
          `INSERT INTO users (username,pass_hash,role,active,name,email,phone,email_verified_at,created_at) VALUES (?,?,?,1,?,?,?,?,?)`,
          email, await hashPassword(f.password), f.role === 'super' ? 'super' : 'admin', name, email, normalizePhone(f.phone), Date.now(), Date.now());
        for (const [k, v] of Object.entries(f)) {
          if (k.startsWith('dep_') && v) await run(db, `INSERT OR IGNORE INTO user_departments VALUES (?,?)`, Number(r.meta.last_row_id), Number(k.slice(4)));
        }
        return { ok: true, msg: `"${name}" 계정을 만들었어요. (이메일 인증은 건너뛰어요)` };
      }

      case 'user_edit': {
        const id = Number(f.user_id);
        const name = (f.name || '').trim();
        const email = normalizeEmail(f.email);
        if (!name) return { ok: false, msg: '이름을 적어 주세요.' };
        if (email) {
          const dup = await first(db, `SELECT id FROM users WHERE email=? AND id<>?`, email, id);
          if (dup) return { ok: false, msg: '다른 사람이 쓰는 이메일이에요.' };
        }
        const phone = f.phone ? normalizePhone(f.phone) : '';
        if (phone && !isValidMobile(phone)) return { ok: false, msg: '휴대폰 번호 형식이 달라요.' };
        await run(db, `UPDATE users SET name=?, email=?, phone=?, role=? WHERE id=?`,
          name, email || null, phone, f.role === 'super' ? 'super' : 'admin', id);
        await run(db, `DELETE FROM user_departments WHERE user_id=?`, id);
        for (const [k, v] of Object.entries(f)) {
          if (k.startsWith('dep_') && v) await run(db, `INSERT OR IGNORE INTO user_departments VALUES (?,?)`, id, Number(k.slice(4)));
        }
        return { ok: true, msg: `"${name}" 정보를 저장했어요.` };
      }

      case 'user_verify': {
        await run(db, `UPDATE users SET email_verified_at=?, active=1 WHERE id=?`, Date.now(), Number(f.user_id));
        return { ok: true, msg: '이메일 인증 없이 승인했어요. 이제 로그인할 수 있어요.' };
      }

      case 'user_delete': {
        const id = Number(f.user_id);
        if (id === Number(f._me)) return { ok: false, msg: '내 계정은 지울 수 없어요.' };
        await run(db, `DELETE FROM sessions WHERE user_id=?`, id);
        await run(db, `DELETE FROM email_tokens WHERE user_id=?`, id);
        await run(db, `DELETE FROM user_departments WHERE user_id=?`, id);
        await run(db, `UPDATE campaigns SET created_by=NULL WHERE created_by=?`, id);
        await run(db, `UPDATE messages SET user_id=NULL WHERE user_id=?`, id);
        await run(db, `UPDATE audit SET user_id=NULL WHERE user_id=?`, id);
        await run(db, `DELETE FROM users WHERE id=?`, id);
        return { ok: true, msg: '계정을 지웠어요.' };
      }

      case 'dept_rename': {
        const name = (f.name || '').trim();
        if (!name) return { ok: false, msg: '부서 이름을 적어 주세요.' };
        await run(db, `UPDATE departments SET name=? WHERE id=?`, name, Number(f.department_id));
        return { ok: true, msg: `부서 이름을 "${name}"(으)로 바꿨어요.` };
      }

      case 'dept_delete': {
        const id = Number(f.department_id);
        const used = (await first(db,
          `SELECT (SELECT COUNT(*) FROM user_departments WHERE department_id=?) + (SELECT COUNT(*) FROM gateways WHERE department_id=?)
             + (SELECT COUNT(*) FROM campaigns WHERE department_id=?) n`, id, id, id)).n;
        if (used > 0) return { ok: false, msg: '사용자, 폰, 면접 안내가 연결된 부서는 지울 수 없어요. 먼저 옮겨 주세요.' };
        await run(db, `DELETE FROM departments WHERE id=?`, id);
        return { ok: true, msg: '부서를 지웠어요.' };
      }

      case 'gw_edit': {
        const name = (f.name || '').trim();
        if (!name) return { ok: false, msg: '폰 이름을 적어 주세요.' };
        await run(db, `UPDATE gateways SET name=?, department_id=? WHERE id=?`, name, Number(f.department_id), Number(f.gateway_id));
        return { ok: true, msg: '폰 정보를 저장했어요.' };
      }

      case 'user_reset': {
        if ((f.password || '').length < 8) return { ok: false, msg: '새 비밀번호는 8글자 이상이어야 해요.' };
        await run(db, `UPDATE users SET pass_hash=? WHERE id=?`, await hashPassword(f.password), Number(f.user_id));
        await run(db, `DELETE FROM sessions WHERE user_id=?`, Number(f.user_id));
        return { ok: true, msg: '비밀번호를 바꿨어요. 그 사람은 다시 로그인해야 해요.' };
      }

      case 'user_active': {
        const on = f.active === '1' ? 1 : 0;
        if (!on && Number(f.user_id) === Number(f._me)) return { ok: false, msg: '내 계정은 쓰지 못하게 할 수 없어요.' };
        await run(db, `UPDATE users SET active=? WHERE id=?`, on, Number(f.user_id));
        if (!on) await run(db, `DELETE FROM sessions WHERE user_id=?`, Number(f.user_id));
        return { ok: true, msg: on ? '이 계정을 다시 쓰도록 했어요.' : '이 계정을 쓰지 못하게 했어요.' };
      }

      default:
        return { ok: false, msg: '알 수 없는 요청이에요.' };
    }
  } catch (e) {
    const m = String(e.message || e);
    if (/UNIQUE/i.test(m)) return { ok: false, msg: '같은 이름이 이미 있어요.' };
    return { ok: false, msg: `잘 안 됐어요: ${m}` };
  }
}

const COPY_JS = `<script>
document.addEventListener('click', function (e) {
  var b = e.target.closest('[data-copy]');
  if (!b) return;
  navigator.clipboard.writeText(b.getAttribute('data-copy')).then(function () {
    var t = b.textContent; b.textContent = '복사됐어요 ✔'; setTimeout(function () { b.textContent = t; }, 1800);
  });
});
</script>`;

export async function renderAdmin(db, env, publicBase, result = null) {
  const deps = await all(db, `SELECT * FROM departments ORDER BY name`);
  const gws = await all(db,
    `SELECT g.id,g.name,g.username,g.active,g.own_number,g.department_id,g.health,g.health_note,g.last_seen_at,g.health_checked_at,(g.passphrase != '') AS locked,d.name dept FROM gateways g JOIN departments d ON d.id=g.department_id WHERE g.deleted_at IS NULL ORDER BY g.active DESC, g.id`);
  const users = await listUsers(db);
  const orderedDeps = sortDepartments(deps);
  const apiUrl = phoneApiUrl(env);
  const token = env.GATEWAY_PRIVATE_TOKEN || '';
  const pub = isPublicCloud(env);
  const hasPhone = gws.some((g) => g.active);

  const notice = result ? `<div class="notice ${result.ok ? 'ok' : 'warn'}" role="${result.ok ? 'status' : 'alert'}">${icon(result.ok ? 'check' : 'alert')}<div>${esc(result.msg)}</div></div>` : '';

  const status = hasPhone
    ? ''
    : `<div class="notice warn" role="alert">${icon('alert')}<div><b>아직 문자를 보낼 폰이 연결되지 않았어요.</b><br>아래 1번부터 차례로 해 주세요.</div></div>`;

  const copyBox = (label, value) => `
    <div class="copybox">
      <div class="copylabel">${label}</div>
      <div class="copyvalue">${esc(value || '(설정이 없어요)')}</div>
      ${value ? `<button type="button" class="btn big" data-copy="${esc(value)}">여기를 눌러 복사하기</button>` : ''}
    </div>`;

  const steps = `
    ${phoneSetupSteps({ pub, apiUrl, token, copyBox })}

    <div class="step">
      <div class="num">9</div>
      <div class="body">
        <h3>아이디와 비밀번호 옮겨 적기</h3>
        <ol>
          <li>앱의 <b>Settings → Cloud Server</b> 화면을 엽니다.</li>
          <li>거기에 <b>Username</b>(아이디)과 <b>Password</b>(비밀번호)가 보여요.</li>
          <li>그 두 가지를 아래 칸에 똑같이 적습니다.</li>
        </ol>
        <form method="post" class="stack card">
          <input type="hidden" name="do" value="connect">
          <label>이 폰을 쓸 부서
            <select name="department_id">
              <option value="">— 고르기 —</option>
              ${deps.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}
            </select>
          </label>
          <label>목록에 부서가 없으면 여기에 새 부서 이름 적기
            <input name="new_department" placeholder="예: 인사팀"></label>
          <label>폰 앱의 Username <input name="username" required autocomplete="off"></label>
          <label>폰 앱의 Password <input name="password" required autocomplete="off"></label>
          ${pub ? `<label>암호화 비밀번호 <small>(5번에서 앱에 적은 문장과 똑같이)</small><input name="passphrase" autocomplete="off" required></label>` : `<label>암호화 비밀번호 <small>(앱에서 암호화를 쓰는 경우만)</small><input name="passphrase" autocomplete="off"></label>`}
          <details><summary>폰 이름 정하기 (안 해도 돼요)</summary>
            <label>폰 이름<input name="name" placeholder="예: 인사팀 폰"></label></details>
          <button class="btn big">연결 끝내기</button>
        </form>
        <small>이 버튼을 누르면 답장을 받는 설정도 저절로 돼요.</small>
      </div>
    </div>`;

  const phoneCard = (g) => `
    <div class="card pcard${g.active ? '' : ' off'}">
      <div class="prow">
        <div class="pinfo">
          <div class="ptitle"><b>${esc(g.name)}</b>
            <span class="badge ${g.active ? 'ok' : ''}">${g.active ? '쓰는 중' : '쓰지 않음'}</span>
            ${g.locked ? '<span class="badge info">암호화</span>' : ''}
            ${g.active ? { ok: '<span class="badge ok">정상</span>', warn: '<span class="badge wait">응답 늦음</span>', down: '<span class="badge fail">확인 필요</span>' }[g.health] || '' : ''}</div>
          <div class="muted">${esc(g.dept)}${g.own_number ? ' · ' + esc(fmtPhone(g.own_number)) : ''}</div>
          ${g.active && g.health !== 'unknown' ? `<div class="muted" style="font-size:14px">${g.last_seen_at ? '마지막 응답 ' + fmtWhen(g.last_seen_at) : ''}${g.health_note ? ' · ' + esc(g.health_note) : ''}</div>` : ''}
        </div>
        ${g.active ? `<div class="pbtns">
          <form method="post" class="inline"><input type="hidden" name="do" value="gw_check"><input type="hidden" name="gateway_id" value="${g.id}">
            <button class="btn secondary small">${icon('check', 16)}연결 확인</button></form>
        </div>` : `<div class="pbtns">
          <form method="post" class="inline" data-confirm="이 폰을 목록에서 지울까요? 이미 보낸 문자와 면접 안내 기록은 남아요. 되돌릴 수 없어요.">
            <input type="hidden" name="do" value="gw_delete"><input type="hidden" name="gateway_id" value="${g.id}">
            <button class="btn danger small">삭제</button></form>
        </div>`}
      </div>
      <details class="pmore">
        <summary>더 보기</summary>
        <div class="pgrid">
          ${g.active ? `
          <form method="post" class="stack">
            <input type="hidden" name="do" value="gw_selftest"><input type="hidden" name="gateway_id" value="${g.id}">
            <label>받기 시험 <small>이 폰의 번호로 시험 문자를 보내고, 폰이 받은 문자를 알려 주는지 확인해요.</small>
              <input name="number" value="${esc(g.own_number)}" placeholder="이 폰의 전화번호 010..." inputmode="tel"></label>
            <div class="form-actions"><button class="btn secondary small">받기 시험</button></div>
          </form>
          <form method="post" class="inline"><input type="hidden" name="do" value="gw_hook"><input type="hidden" name="gateway_id" value="${g.id}">
            <p class="muted" style="margin-bottom:8px">받은 문자나 전달 결과가 화면에 안 들어오면 눌러 보세요.</p>
            <button class="btn secondary small">답장·전달 결과 받기 다시 설정</button></form>
          <details><summary>폰 이름·부서 바꾸기</summary>
            <form method="post" class="stack small-form">
              <input type="hidden" name="do" value="gw_edit"><input type="hidden" name="gateway_id" value="${g.id}">
              <label>이름<input name="name" value="${esc(g.name)}" required></label>
              <label>이 폰을 쓰는 부서<select name="department_id">${sortDepartments(deps).map((d) => `<option value="${d.id}"${d.id === g.department_id ? ' selected' : ''}>${esc(d.name)}</option>`).join('')}</select></label>
              <div class="form-actions"><button class="btn small">저장</button></div></form></details>
          <details><summary>폰을 다시 설치했어요</summary>
            <form method="post" class="stack small-form">
              <input type="hidden" name="do" value="gw_update"><input type="hidden" name="gateway_id" value="${g.id}">
              <small>앱을 지우고 다시 설치하면 아이디와 비밀번호가 바뀌어요. 새로 보이는 값을 적어 주세요.</small>
              <input name="username" placeholder="새 Username" required autocomplete="off">
              <input name="password" placeholder="새 Password" required autocomplete="off">
              <input name="passphrase" placeholder="암호화 비밀번호 (바꿀 때만)" autocomplete="off">
              <div class="form-actions"><button class="btn small">저장</button></div></form></details>` : ''}
          <form method="post" class="inline"><input type="hidden" name="do" value="gw_active"><input type="hidden" name="gateway_id" value="${g.id}">
            <input type="hidden" name="active" value="${g.active ? 0 : 1}">
            <button class="btn ${g.active ? 'danger' : 'secondary'} small">${g.active ? '이 폰 쓰지 않기' : '다시 쓰기'}</button></form>
        </div>
      </details>
    </div>`;

  const phones = `
    <section class="section" id="sec-phones">
      <div class="shead"><h2>문자 보내는 폰</h2></div>
      ${gws.length ? gws.map(phoneCard).join('') : emptyState({ title: '아직 연결된 폰이 없어요', desc: '아래 "폰 연결하기"의 1~9번을 차례로 해 주세요.' })}
    </section>`;

  const depChecks = (selectedIds = []) => orderedDeps.map((d) =>
    `<label class="check"><input type="checkbox" name="dep_${d.id}" value="1"${selectedIds.includes(d.id) ? ' checked' : ''}> ${esc(d.name)}</label>`).join('');
  const pending = users.filter((u) => !u.email_verified_at);

  const userRow = (u) => {
    const depIds = (u.dep_ids || '').split(',').filter(Boolean).map(Number);
    const verified = Boolean(u.email_verified_at);
    return `<div class="urow${u.active ? '' : ' off'}">
      <div class="uinfo">
        <div><b>${esc(u.name || u.username)}</b>
          <span class="badge ${u.role === 'super' ? 'info' : ''}">${u.role === 'super' ? '관리자' : '일반 사용자'}</span>
          ${verified ? '' : '<span class="badge wait">이메일 인증 대기</span>'}
          ${u.active ? '' : '<span class="badge">쓰지 않음</span>'}</div>
        <div class="muted">${esc(u.email || u.username)}${u.phone ? ' · ' + esc(fmtPhone(u.phone)) : ''}</div>
        <div class="muted">${esc(u.role === 'super' ? '모든 부서' : u.deps || '부서 없음')}${u.created_at ? ' · 가입 ' + fmtWhen(u.created_at) : ''}</div>
      </div>
      <div class="pbtns">
        ${verified ? '' : `<form method="post" class="inline"><input type="hidden" name="do" value="user_verify"><input type="hidden" name="user_id" value="${u.id}"><button class="btn small">승인하기</button></form>`}
        <details class="pop"><summary class="btn secondary small">수정</summary>
          <form method="post" class="stack small-form" style="min-width:280px">
            <input type="hidden" name="do" value="user_edit"><input type="hidden" name="user_id" value="${u.id}">
            <label>이름<input name="name" value="${esc(u.name || '')}" required></label>
            <label>이메일<input name="email" type="email" value="${esc(u.email || '')}"></label>
            <label>휴대폰<input name="phone" value="${esc(u.phone || '')}" inputmode="tel"></label>
            <label>권한<select name="role"><option value="admin"${u.role === 'super' ? '' : ' selected'}>일반 사용자 (고른 부서만)</option><option value="super"${u.role === 'super' ? ' selected' : ''}>관리자 (모든 것)</option></select></label>
            <fieldset><legend>부서</legend>${depChecks(depIds)}</fieldset>
            <div class="form-actions"><button class="btn small">저장</button></div>
          </form></details>
        <details class="pop"><summary class="btn secondary small">비밀번호</summary>
          <form method="post" class="stack small-form"><input type="hidden" name="do" value="user_reset"><input type="hidden" name="user_id" value="${u.id}">
            <input name="password" type="password" placeholder="새 비밀번호(8글자 이상)" minlength="8" required autocomplete="new-password">
            <div class="form-actions"><button class="btn small">바꾸기</button></div></form></details>
        <form method="post" class="inline"><input type="hidden" name="do" value="user_active"><input type="hidden" name="user_id" value="${u.id}">
          <input type="hidden" name="active" value="${u.active ? 0 : 1}"><button class="btn secondary small">${u.active ? '쓰지 못하게' : '다시 쓰게'}</button></form>
        <form method="post" class="inline" data-confirm="${esc(u.name || u.email || u.username)} 계정을 지울까요? 되돌릴 수 없어요."><input type="hidden" name="do" value="user_delete"><input type="hidden" name="user_id" value="${u.id}">
          <button class="lk" style="color:var(--red-t)">삭제</button></form>
      </div></div>`;
  };

  const people = `
    <section class="section" id="sec-users">
      <div class="shead"><h2>사용자</h2><span class="muted">${users.length}명${pending.length ? ' · 인증 대기 ' + pending.length + '명' : ''}</span></div>
      <div class="card">
        ${users.length ? users.map(userRow).join('') : emptyState({ title: '아직 사용자가 없어요' })}
        <details style="margin-top:16px"><summary><b>사용자 직접 추가하기</b> <small>이메일 인증 없이 바로 만들어요</small></summary>
          <form method="post" class="stack" style="margin-top:12px;max-width:420px">
            <input type="hidden" name="do" value="user">
            <label>이름<input name="name" required></label>
            <label>이메일<input name="email" type="email" required autocomplete="off"></label>
            <label>휴대폰<input name="phone" inputmode="tel" autocomplete="off"></label>
            <label>비밀번호 <small>8글자 이상</small><input name="password" type="password" minlength="8" required autocomplete="new-password"></label>
            <label>권한 <select name="role"><option value="admin">일반 사용자 (고른 부서만 볼 수 있어요)</option><option value="super">관리자 (모든 것을 볼 수 있어요)</option></select></label>
            <fieldset><legend>부서</legend>${depChecks([])}</fieldset>
            <div class="form-actions"><button class="btn">추가하기</button></div>
          </form>
        </details>
      </div>
    </section>

    <section class="section" id="sec-depts">
      <div class="shead"><h2>부서</h2></div>
      <div class="card">
        ${orderedDeps.map((d) => `<div class="urow">
          <div><b>${esc(d.name)}</b></div>
          <div class="pbtns">
            <details class="pop"><summary class="btn secondary small">이름 바꾸기</summary>
              <form method="post" class="stack small-form"><input type="hidden" name="do" value="dept_rename"><input type="hidden" name="department_id" value="${d.id}">
                <input name="name" value="${esc(d.name)}" required><div class="form-actions"><button class="btn small">저장</button></div></form></details>
            <form method="post" class="inline" data-confirm="${esc(d.name)} 부서를 지울까요?"><input type="hidden" name="do" value="dept_delete"><input type="hidden" name="department_id" value="${d.id}">
              <button class="btn danger small">삭제</button></form>
          </div></div>`).join('')}
        <form method="post" class="row" style="margin-top:14px"><input type="hidden" name="do" value="dept">
          <div class="grow"><input name="name" placeholder="새 부서 이름" aria-label="새 부서 이름"></div><button class="btn secondary">부서 추가</button></form>
      </div>
    </section>`;

  const errs = await recentErrors(db, 8);
  const system = `
    <section class="section" id="sec-system">
      <div class="shead"><h2>시스템 상태</h2>
        <form method="post" class="inline"><input type="hidden" name="do" value="monitor_now"><button class="btn secondary small">지금 점검하기</button></form></div>
      <div class="card">
        <p class="muted" style="margin-bottom:12px">폰은 5분마다 자동으로 점검하고, 문제가 있으면 관리자 메일로 알려요. 오류가 계속 나면 메일이 가요.</p>
        ${errs.length ? `<h3 style="margin-bottom:8px">최근 오류</h3><ul class="mlist">${errs.map((e) => `<li class="mrow"><div class="mtop"><span class="badge fail">${esc(e.scope)}</span><span class="when">${fmtWhen(e.at)}</span></div><div class="mtext" style="font-size:14px">${esc(e.path)} ${esc(e.message)}</div></li>`).join('')}</ul>` : '<p>✓ 최근 오류가 없어요.</p>'}
      </div>
    </section>`;

  const connect = `
    <section class="section" id="sec-connect">
      <details class="card" ${hasPhone ? '' : 'open'}>
        <summary><b>폰 연결하기</b> <span class="muted">새 폰을 연결할 때 열어서 1~9번을 차례로 해요</span></summary>
        <p class="muted" style="margin-top:10px">직원에게 보여 주려면 <a href="/help/phone">폰 설치 안내 페이지</a>를 열어 주세요. (Obtainium으로 설치하면 "접근 차단"을 피할 수 있어요)</p>
        <div style="margin-top:16px">${steps}</div>
      </details>
    </section>`;

  const subnav = `<nav class="subnav" aria-label="설정 구역">
      <a href="#sec-phones">문자 보내는 폰</a><a href="#sec-system">시스템 상태</a><a href="#sec-connect">폰 연결하기</a>
      <a href="#sec-users">사용자</a><a href="#sec-depts">부서</a></nav>`;
  return `${pageHeader({ title: '설정', desc: '문자를 보내는 폰과, 이 시스템을 쓰는 사람을 관리해요.' })}
    ${subnav}${status}${notice}${phones}${system}${connect}${people}${COPY_JS}`;
}
