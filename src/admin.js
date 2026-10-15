// 설정(관리) 화면: 폰 연결, 부서, 관리자 계정. 처음 쓰는 사람도 따라 할 수 있게 단계별로 구성한다.
import { all, first, run } from './d1.js';
import { esc, fmtTime } from './views.js';
import { encryptText, decryptText, randomToken, hashPassword } from './crypto.js';
import { registerWebhook, checkGateway } from './gateway.js';

// 폰 앱에 입력할 주소: .../api/3rdparty/v1 → .../api/mobile/v1
export const phoneApiUrl = (env) => (env.GATEWAY_URL || '').replace('/api/3rdparty/v1', '/api/mobile/v1');

async function loadGateway(db, env, id) {
  const row = await first(db, `SELECT * FROM gateways WHERE id=?`, Number(id));
  if (!row) throw new Error('폰을 찾을 수 없습니다.');
  return { ...row, password: await decryptText(env.ENCRYPTION_KEY, row.password) };
}

// 반환: { ok: boolean, msg: string }
export async function applyAdminAction(db, env, f, publicBase) {
  try {
    switch (f.do) {
      case 'dept': {
        const name = (f.name || '').trim();
        if (!name) return { ok: false, msg: '부서 이름을 입력하세요.' };
        await run(db, `INSERT INTO departments (name) VALUES (?)`, name);
        return { ok: true, msg: `부서 "${name}"을(를) 추가했습니다.` };
      }

      case 'connect': {
        const username = (f.username || '').trim();
        const password = (f.password || '').trim();
        if (!username || !password) return { ok: false, msg: '폰 앱에 표시된 아이디(Username)와 비밀번호(Password)를 모두 입력하세요.' };
        let departmentId = Number(f.department_id);
        const newDept = (f.new_department || '').trim();
        if (newDept) {
          const exist = await first(db, `SELECT id FROM departments WHERE name=?`, newDept);
          departmentId = exist ? exist.id : Number((await run(db, `INSERT INTO departments (name) VALUES (?)`, newDept)).meta.last_row_id);
        }
        if (!departmentId) return { ok: false, msg: '부서를 선택하거나 새 부서 이름을 입력하세요.' };
        const dept = await first(db, `SELECT name FROM departments WHERE id=?`, departmentId);
        const name = (f.name || '').trim() || `${dept.name} 폰`;
        const r = await run(db,
          `INSERT INTO gateways (department_id,name,base_url,username,password,send_path,signing_key,hook_token)
           VALUES (?,?,?,?,?,?,?,?)`, departmentId, name,
          env.GATEWAY_URL || 'https://api.sms-gate.app/3rdparty/v1', username,
          await encryptText(env.ENCRYPTION_KEY, password), '/messages', '', randomToken(18));
        const gw = await loadGateway(db, env, r.meta.last_row_id);
        try {
          await registerWebhook(gw, publicBase);
        } catch (e) {
          return { ok: false, msg: `폰은 등록했지만 답장 수신 설정에 실패했습니다. 목록의 "답장 수신 다시 설정"을 눌러 주세요. (${e.message})` };
        }
        return { ok: true, msg: `"${name}" 연결을 마쳤습니다. 아래 목록에서 "연결 확인"을 눌러 폰이 켜져 있는지 확인하세요.` };
      }

      case 'gw_update': {
        const username = (f.username || '').trim();
        const password = (f.password || '').trim();
        if (!username || !password) return { ok: false, msg: '아이디와 비밀번호를 모두 입력하세요.' };
        await run(db, `UPDATE gateways SET username=?, password=? WHERE id=?`,
          username, await encryptText(env.ENCRYPTION_KEY, password), Number(f.gateway_id));
        const gw = await loadGateway(db, env, f.gateway_id);
        await registerWebhook(gw, publicBase);
        return { ok: true, msg: '폰 계정 정보를 바꾸고 답장 수신도 다시 설정했습니다.' };
      }

      case 'gw_check': {
        const gw = await loadGateway(db, env, f.gateway_id);
        const r = await checkGateway(gw);
        if (!r.reachable) return { ok: false, msg: `"${gw.name}": 서버에 연결하지 못했습니다. (${r.error})` };
        if (!r.count) return { ok: false, msg: `"${gw.name}": 서버에는 연결되었지만 등록된 폰이 없습니다. 폰 앱에서 Online 상태인지 확인하세요.` };
        const seen = r.lastSeen ? fmtTime(new Date(r.lastSeen).getTime()) : '알 수 없음';
        return r.online
          ? { ok: true, msg: `"${gw.name}": 정상입니다. 폰이 켜져 있습니다. (마지막 응답 ${seen})` }
          : { ok: false, msg: `"${gw.name}": 폰이 한동안 응답하지 않았습니다. (마지막 응답 ${seen}) 폰 앱이 Online인지 확인하세요.` };
      }

      case 'gw_hook': {
        const gw = await loadGateway(db, env, f.gateway_id);
        await registerWebhook(gw, publicBase);
        return { ok: true, msg: `"${gw.name}": 답장 수신 설정을 다시 했습니다.` };
      }

      case 'gw_active': {
        const on = f.active === '1' ? 1 : 0;
        await run(db, `UPDATE gateways SET active=? WHERE id=?`, on, Number(f.gateway_id));
        return { ok: true, msg: on ? '폰을 다시 사용합니다.' : '폰 사용을 중지했습니다. 발송 폰 목록에서 사라집니다.' };
      }

      case 'user': {
        const username = (f.username || '').trim();
        if (!username || (f.password || '').length < 8) return { ok: false, msg: '아이디를 입력하고 비밀번호는 8자 이상으로 하세요.' };
        const r = await run(db, `INSERT INTO users (username,pass_hash,role) VALUES (?,?,?)`,
          username, await hashPassword(f.password), f.role === 'super' ? 'super' : 'admin');
        for (const [k, v] of Object.entries(f)) {
          if (k.startsWith('dep_') && v) await run(db, `INSERT OR IGNORE INTO user_departments VALUES (?,?)`, Number(r.meta.last_row_id), Number(k.slice(4)));
        }
        return { ok: true, msg: `관리자 "${username}"을(를) 추가했습니다.` };
      }

      case 'user_reset': {
        if ((f.password || '').length < 8) return { ok: false, msg: '새 비밀번호는 8자 이상이어야 합니다.' };
        await run(db, `UPDATE users SET pass_hash=? WHERE id=?`, await hashPassword(f.password), Number(f.user_id));
        await run(db, `DELETE FROM sessions WHERE user_id=?`, Number(f.user_id));
        return { ok: true, msg: '비밀번호를 바꿨습니다. 해당 사용자는 다시 로그인해야 합니다.' };
      }

      case 'user_active': {
        const on = f.active === '1' ? 1 : 0;
        await run(db, `UPDATE users SET active=? WHERE id=?`, on, Number(f.user_id));
        if (!on) await run(db, `DELETE FROM sessions WHERE user_id=?`, Number(f.user_id));
        return { ok: true, msg: on ? '계정을 다시 사용합니다.' : '계정을 중지했습니다.' };
      }

      default:
        return { ok: false, msg: '알 수 없는 요청입니다.' };
    }
  } catch (e) {
    const m = String(e.message || e);
    if (/UNIQUE/i.test(m)) return { ok: false, msg: '이미 같은 이름이 있습니다.' };
    return { ok: false, msg: `처리하지 못했습니다: ${m}` };
  }
}

const COPY_JS = `<script>
document.addEventListener('click', function (e) {
  var b = e.target.closest('[data-copy]');
  if (!b) return;
  navigator.clipboard.writeText(b.getAttribute('data-copy')).then(function () {
    var t = b.textContent; b.textContent = '복사됨'; setTimeout(function () { b.textContent = t; }, 1500);
  });
});
</script>`;

export async function renderAdmin(db, env, publicBase, result = null) {
  const deps = await all(db, `SELECT * FROM departments ORDER BY name`);
  const gws = await all(db,
    `SELECT g.id,g.name,g.username,g.active,d.name dept FROM gateways g JOIN departments d ON d.id=g.department_id ORDER BY g.active DESC, g.id`);
  const users = await all(db,
    `SELECT u.id,u.username,u.role,u.active,
       (SELECT group_concat(d.name, ', ') FROM user_departments ud JOIN departments d ON d.id=ud.department_id WHERE ud.user_id=u.id) deps
     FROM users u ORDER BY u.id`);
  const apiUrl = phoneApiUrl(env);
  const token = env.GATEWAY_PRIVATE_TOKEN || '';
  const hasPhone = gws.some((g) => g.active);

  const notice = result
    ? `<div class="${result.ok ? 'ok' : 'warn'}">${esc(result.msg)}</div>` : '';

  const copyRow = (label, value) => `<tr><th>${label}</th><td><code>${esc(value || '(설정 없음)')}</code></td>
    <td>${value ? `<button type="button" class="btn small" data-copy="${esc(value)}">복사</button>` : ''}</td></tr>`;

  const steps = `
    <details${hasPhone ? '' : ' open'}>
      <summary><b>① 폰 준비하기</b> <small>(처음 한 번만, 폰마다 필요)</small></summary>
      <ol class="steps">
        <li>문자를 보낼 <b>안드로이드 폰</b>에 <b>SMS Gateway</b> 앱을 설치하고, 처음 실행할 때 <b>문자(SMS) 권한을 허용</b>합니다.
            <br><small>권한 허용 버튼이 회색이면: 설정 → 앱 → SMS Gateway → 우측 위 ⋮ → "제한된 설정 허용" 후 다시 허용</small></li>
        <li>앱의 <b>설정 → Cloud Server</b>에 아래 두 값을 그대로 입력합니다.
          <table class="kv">
            ${copyRow('서버 주소 (API URL)', apiUrl)}
            ${copyRow('비밀 토큰 (Private Token)', token)}
          </table></li>
        <li>앱 첫 화면에서 <b>Cloud server</b> 스위치를 켜고 <b>Offline</b> 버튼을 눌러 <b>Online</b>이 될 때까지 기다립니다.</li>
        <li>앱에 표시되는 <b>Username</b>과 <b>Password</b>를 메모합니다. → 아래 ②에 입력합니다.</li>
      </ol>
    </details>`;

  const connect = `
    <h3>② 폰 연결하기</h3>
    <form method="post" class="stack card">
      <input type="hidden" name="do" value="connect">
      <label>이 폰을 쓸 부서
        <select name="department_id">
          <option value="">— 선택 —</option>
          ${deps.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}
        </select>
      </label>
      <label>또는 새 부서 이름 <small>(목록에 없으면 여기에 입력)</small>
        <input name="new_department" placeholder="예: 인사팀"></label>
      <label>폰 이름 <small>(비워 두면 자동)</small><input name="name" placeholder="예: 인사팀 폰"></label>
      <label>폰 앱의 Username <input name="username" required autocomplete="off"></label>
      <label>폰 앱의 Password <input name="password" required autocomplete="off"></label>
      <button class="btn">연결하기</button>
      <small>연결하면 답장을 받는 설정도 자동으로 합니다.</small>
    </form>`;

  const phones = `
    <h3>③ 연결된 폰</h3>
    ${gws.length ? `<table><tr><th>부서</th><th>폰 이름</th><th>상태</th><th>작업</th></tr>
      ${gws.map((g) => `<tr${g.active ? '' : ' class="off"'}>
        <td>${esc(g.dept)}</td><td>${esc(g.name)}</td><td>${g.active ? '사용 중' : '중지됨'}</td>
        <td class="actions">
          ${g.active ? `
          <form method="post" class="inline"><input type="hidden" name="do" value="gw_check"><input type="hidden" name="gateway_id" value="${g.id}"><button>연결 확인</button></form>
          <form method="post" class="inline"><input type="hidden" name="do" value="gw_hook"><input type="hidden" name="gateway_id" value="${g.id}"><button>답장 수신 다시 설정</button></form>
          <details class="inline"><summary>계정 변경</summary>
            <form method="post" class="stack small-form"><input type="hidden" name="do" value="gw_update"><input type="hidden" name="gateway_id" value="${g.id}">
              <small>폰 앱을 다시 설치했다면 새 Username/Password를 입력하세요.</small>
              <input name="username" placeholder="새 Username" required autocomplete="off">
              <input name="password" placeholder="새 Password" required autocomplete="off">
              <button>저장</button></form></details>` : ''}
          <form method="post" class="inline"><input type="hidden" name="do" value="gw_active"><input type="hidden" name="gateway_id" value="${g.id}">
            <input type="hidden" name="active" value="${g.active ? 0 : 1}"><button>${g.active ? '사용 중지' : '다시 사용'}</button></form>
        </td></tr>`).join('')}</table>`
      : '<p>아직 연결된 폰이 없습니다. 위 ①, ②를 진행하세요.</p>'}`;

  const people = `
    <h3>관리자 계정</h3>
    <table><tr><th>아이디</th><th>권한</th><th>담당 부서</th><th>작업</th></tr>
    ${users.map((u) => `<tr${u.active ? '' : ' class="off"'}><td>${esc(u.username)}</td>
      <td>${u.role === 'super' ? '전체 관리자' : '일반 관리자'}</td><td>${esc(u.role === 'super' ? '전체' : u.deps || '(없음)')}</td>
      <td class="actions">
        <details class="inline"><summary>비밀번호 재설정</summary>
          <form method="post" class="stack small-form"><input type="hidden" name="do" value="user_reset"><input type="hidden" name="user_id" value="${u.id}">
            <input name="password" type="password" placeholder="새 비밀번호(8자 이상)" minlength="8" required>
            <button>저장</button></form></details>
        <form method="post" class="inline"><input type="hidden" name="do" value="user_active"><input type="hidden" name="user_id" value="${u.id}">
          <input type="hidden" name="active" value="${u.active ? 0 : 1}"><button>${u.active ? '사용 중지' : '다시 사용'}</button></form>
      </td></tr>`).join('')}</table>
    <details><summary><b>관리자 추가</b></summary>
      <form method="post" class="stack card">
        <input type="hidden" name="do" value="user">
        <label>아이디 <input name="username" required autocomplete="off"></label>
        <label>비밀번호 <small>(8자 이상)</small><input name="password" type="password" minlength="8" required></label>
        <label>권한 <select name="role"><option value="admin">일반 관리자 (선택한 부서만)</option><option value="super">전체 관리자</option></select></label>
        <fieldset><legend>담당 부서 <small>(일반 관리자만 해당)</small></legend>
          ${deps.length ? deps.map((d) => `<label class="check"><input type="checkbox" name="dep_${d.id}" value="1"> ${esc(d.name)}</label>`).join('') : '<small>부서가 아직 없습니다.</small>'}
        </fieldset>
        <button class="btn">관리자 추가</button>
      </form>
    </details>`;

  const depsSec = `
    <h3>부서</h3>
    <p>${deps.length ? deps.map((d) => `<span class="chip">${esc(d.name)}</span>`).join(' ') : '<small>아직 없습니다. ②에서 새 부서 이름을 입력하면 자동으로 만들어집니다.</small>'}</p>
    <form method="post" class="row"><input type="hidden" name="do" value="dept">
      <input name="name" placeholder="새 부서 이름"><button class="btn">부서 추가</button></form>`;

  return `<h2>설정</h2>${notice}${steps}${connect}${phones}${depsSec}${people}${COPY_JS}`;
}
