// 설정 화면: 문자 보내는 폰 연결, 부서, 관리자. 처음 쓰는 사람도 순서대로 누르기만 하면 되도록 만든다.
import { all, first, run } from './d1.js';
import { esc, fmtTime, icon } from './views.js';
import { fmtPhone, fmtWhen, pageHeader, tableWrap, emptyState } from './ui.js';
import { encryptText, decryptText, randomToken, hashPassword } from './crypto.js';
import { registerWebhook, checkGateway, sendSms, unlockGateway } from './gateway.js';
import { normalizePhone, isValidMobile } from './parser.js';
import { listUsers, normalizeEmail } from './accounts.js';
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
    `SELECT g.id,g.name,g.username,g.active,g.own_number,g.department_id,(g.passphrase != '') AS locked,d.name dept FROM gateways g JOIN departments d ON d.id=g.department_id ORDER BY g.active DESC, g.id`);
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
    <h2>폰 연결하기</h2>
    <p class="lead">문자를 보낼 <b>안드로이드 폰</b>에서 하는 일이에요. 폰 1대당 <b>한 번만</b> 하면 돼요. 약 10분 걸려요.</p>

    <div class="step">
      <div class="num">1</div>
      <div class="body">
        <h3>앱 설치하기</h3>
        <ol>
          <li>폰에서 <b>인터넷(크롬)</b>을 엽니다.</li>
          <li>위쪽 주소 칸에 아래 주소를 입력하고 이동합니다.<br>
              <code>github.com/capcom6/android-sms-gateway/releases</code></li>
          <li>맨 위에 있는 최신 버전에서 <b>Assets</b>(에셋)를 눌러 펼칩니다.</li>
          <li>이름이 <b>.apk</b>로 끝나는 파일을 누릅니다.<br>
              <small>파일이 여러 개이면 이름에 <b>insecure</b>가 들어간 것은 고르지 마세요.</small></li>
          <li>다운로드가 끝나면 <b>열기</b>를 누르고, <b>설치</b>를 누릅니다.<br>
              <small>"이 출처 허용" 같은 화면이 나오면 스위치를 켜고 뒤로 가서 다시 <b>설치</b>를 누르세요.</small></li>
          <li>설치가 끝나면 <b>열기</b>를 눌러 앱(<b>SMSGate</b>)을 엽니다.</li>
        </ol>
      </div>
    </div>

    <div class="step">
      <div class="num">2</div>
      <div class="body">
        <h3>문자 보내기 허용하기</h3>
        <ol>
          <li>앱을 열면 "문자를 보내도록 허용할까요?" 같은 창이 나와요. <b>허용</b>을 누릅니다.</li>
          <li>"전화 걸기/관리" 허용 창이 나오면 그것도 <b>허용</b>을 누릅니다.</li>
        </ol>
        <details class="help">
          <summary>🔧 <b>허용 버튼이 회색이라 눌리지 않아요</b> (갤럭시 폴드 등에서 자주 생겨요)</summary>
          <ol>
            <li>안 눌리는 <b>허용</b> 버튼을 <b>한 번 눌러 보고</b> 나옵니다.</li>
            <li><b>설정</b> 앱 → <b>애플리케이션</b>(또는 <b>앱</b>) → <b>SMSGate</b>를 누릅니다.</li>
            <li>화면 <b>오른쪽 위의 점 세 개(⋮)</b>를 누릅니다.</li>
            <li><b>제한된 설정 허용</b>을 누르고, 지문이나 비밀번호로 확인합니다.</li>
            <li>뒤로 가서 <b>권한</b> → <b>문자(SMS)</b> → <b>허용</b>을 누릅니다.</li>
          </ol>
          <small>점 세 개(⋮)가 안 보이면 1번을 다시 한 뒤, 이 화면을 닫았다가 다시 열어 보세요.</small>
        </details>
      </div>
    </div>

    <div class="step">
      <div class="num">3</div>
      <div class="body">
        <h3>문자 앱의 "채팅(RCS)" 기능 끄기 <small>(꼭 해야 해요)</small></h3>
        <p>갤럭시 폰은 문자가 일반 문자가 아니라 <b>인터넷 채팅 메시지(RCS)</b>로 오는 경우가 있어요.
           이렇게 오면 SMSGate가 <b>받은 문자를 알아보지 못해요.</b> 이 폰에서는 채팅 기능을 꺼 두세요.</p>
        <ol>
          <li><b>메시지</b> 앱(삼성 메시지)을 엽니다.</li>
          <li>오른쪽 위 <b>점 세 개(⋮)</b> → <b>설정</b>을 누릅니다.</li>
          <li><b>채팅 설정</b>(또는 <b>채팅 서비스</b>)을 누릅니다.</li>
          <li><b>채팅 기능</b> 스위치를 <b>끕니다</b>.</li>
        </ol>
        <details class="help">
          <summary>🔧 <b>구글 "메시지" 앱을 쓰고 있다면</b></summary>
          <ol>
            <li>앱 오른쪽 위 <b>프로필 사진</b> → <b>메시지 설정</b>을 누릅니다.</li>
            <li><b>RCS 채팅</b>을 누릅니다.</li>
            <li><b>RCS 채팅 사용</b>을 <b>끕니다</b>.</li>
          </ol>
        </details>
        <small>끈 뒤 10분쯤 지나면 상대방 폰에서도 이 폰으로 일반 문자가 가요. 삼성 메시지와 구글 메시지가 둘 다 설치되어 있으면 <b>둘 다</b> 끄세요.</small>
      </div>
    </div>

    <div class="step">
      <div class="num">4</div>
      <div class="body">
        <h3>폰이 꺼지지 않게 설정하기</h3>
        <ol>
          <li><b>설정</b> 앱 → <b>애플리케이션</b> → <b>SMSGate</b> → <b>배터리</b>를 누릅니다.</li>
          <li><b>제한 없음</b>을 선택합니다.</li>
          <li>이 폰은 <b>충전기에 계속 꽂아 두고</b> 전원을 켜 두세요.</li>
        </ol>
      </div>
    </div>

    ${pub ? `<div class="step">
      <div class="num">5</div>
      <div class="body">
        <h3>문자 내용 암호화 켜기 <small>(꼭 하세요)</small></h3>
        <p>이 시스템은 <b>공개 문자 서버</b>를 거쳐 문자를 보내요. 서버가 문자 내용과 전화번호를 볼 수 없도록 <b>암호 비밀번호</b>를 정해 두 곳에 똑같이 넣어요.</p>
        <ol>
          <li>폰 SMSGate 앱 → <b>Settings</b> → <b>Encryption</b>(암호화)을 엽니다.</li>
          <li><b>Passphrase</b> 칸에 <b>길고 아무도 모르는 문장</b>(예: 12자 이상)을 적고 저장합니다.</li>
          <li>그 문장을 <b>아래 7번 칸의 "암호화 비밀번호"</b>에도 똑같이 적습니다.</li>
        </ol>
        <small>서버 주소와 토큰은 따로 넣지 않아요. 앱의 <b>Cloud Server</b> 서버 주소 칸은 <b>기본값 그대로</b> 두세요.</small>
      </div>
    </div>` : `<div class="step">
      <div class="num">5</div>
      <div class="body">
        <h3>앱에 서버 정보 넣기</h3>
        <p>아래 두 개를 차례로 <b>복사</b>해서 앱에 <b>붙여넣어요</b>.</p>
        ${copyBox('① 서버 주소 (앱에서는 "API URL"이라고 써 있어요)', apiUrl)}
        ${copyBox('② 비밀 번호표 (앱에서는 "Private Token"이라고 써 있어요)', token)}
        <ol>
          <li>폰의 앱에서 아래쪽 메뉴의 <b>Settings</b>(설정)를 누릅니다.</li>
          <li>아래로 내려 <b>Cloud Server</b>를 찾아 누릅니다.</li>
          <li><b>API URL</b> 칸을 길게 눌러 <b>붙여넣기</b>를 누릅니다.</li>
          <li><b>Private Token</b> 칸도 같은 방법으로 붙여넣습니다.</li>
          <li>저장(✔) 버튼이 있으면 누릅니다.</li>
        </ol>
      </div>
    </div>`}

    <div class="step">
      <div class="num">6</div>
      <div class="body">
        <h3>켜기</h3>
        <ol>
          <li>앱 아래쪽 메뉴에서 <b>Home</b>을 누릅니다.</li>
          <li><b>Cloud server</b> 스위치를 <b>켭니다</b>.</li>
          <li><b>Offline</b> 버튼을 누릅니다.</li>
          <li>버튼이 <b>Online</b>으로 바뀔 때까지 기다립니다. (몇 초 걸려요)</li>
        </ol>
        <small>Online이 안 되면: 서버 주소(①)에 빠진 글자가 없는지, 폰이 인터넷에 연결되어 있는지 확인하세요.</small>
      </div>
    </div>

    <div class="step">
      <div class="num">7</div>
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
            ${g.locked ? '<span class="badge info">암호화</span>' : ''}</div>
          <div class="muted">${esc(g.dept)}${g.own_number ? ' · ' + esc(fmtPhone(g.own_number)) : ''}</div>
        </div>
        ${g.active ? `<div class="pbtns">
          <form method="post" class="inline"><input type="hidden" name="do" value="gw_check"><input type="hidden" name="gateway_id" value="${g.id}">
            <button class="btn secondary small">${icon('check', 16)}연결 확인</button></form>
        </div>` : ''}
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
            <p class="muted" style="margin-bottom:8px">받은 문자가 화면에 안 들어오면 눌러 보세요.</p>
            <button class="btn secondary small">답장 받기 다시 설정</button></form>
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
    <section class="section">
      <div class="shead"><h2>문자 보내는 폰</h2></div>
      ${gws.length ? gws.map(phoneCard).join('') : emptyState({ title: '아직 연결된 폰이 없어요', desc: '아래 "폰 연결하기"의 1~7번을 차례로 해 주세요.' })}
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
          <button class="btn danger small">삭제</button></form>
      </div></div>`;
  };

  const people = `
    <section class="section">
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

    <section class="section">
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

  const connect = `
    <section class="section">
      <details class="card" ${hasPhone ? '' : 'open'}>
        <summary><b>폰 연결하기</b> <span class="muted">새 폰을 연결할 때 열어서 1~7번을 차례로 해요</span></summary>
        <div style="margin-top:16px">${steps}</div>
      </details>
    </section>`;

  return `${pageHeader({ title: '설정', desc: '문자를 보내는 폰과, 이 시스템을 쓰는 사람을 관리해요.' })}
    ${status}${notice}${phones}${connect}${people}${COPY_JS}`;
}
