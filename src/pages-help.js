// 폰 설치/연결 안내: 설정 화면의 단계 안내와 /help/phone 에서 같이 쓴다.
// 핵심: 최신 안드로이드는 GitHub 에서 받은 APK 의 문자(SMS) 권한을 막는다(제한된 설정/자동 차단).
//       그래서 처음부터 Obtainium(오픈소스 앱 설치·업데이트 도구)으로 설치하고, 막힘을 미리 풀어 둔다.
import { esc, icon } from './views.js';
import { pageHeader } from './ui.js';

export const OBTAINIUM_URL = 'github.com/ImranR98/Obtainium/releases/latest';
export const SMSGATE_URL = 'https://github.com/capcom6/android-sms-gateway';

const copy = (value, label = '복사') =>
  `<button type="button" class="btn secondary small" data-copy="${esc(value)}">${esc(label)}</button>`;

const urlLine = (value, label) =>
  `<div class="copybox"><div class="copylabel">${esc(label)}</div><div class="copyvalue">${esc(value)}</div>${copy(value)}</div>`;

// 단계 카드. n: 번호, title, body(html)
const step = (n, title, body) =>
  `<div class="step"><div class="num">${n}</div><div class="body"><h3>${title}</h3>${body}</div></div>`;

const warn = (html) => `<div class="notice warn" role="note">${icon('alert')}<div>${html}</div></div>`;
const info = (html) => `<div class="notice info">${icon('info')}<div>${html}</div></div>`;

// ctx: { pub, apiUrl, token, copyBox }  — 서버 정보 단계에만 쓴다
export function phoneSetupSteps(ctx = {}) {
  const { pub = false, apiUrl = '', token = '', copyBox = null, showSecrets = true } = ctx;
  const box = (label, v) => (copyBox ? copyBox(label, v) : urlLine(v || '(설정이 없어요)', label));

  const s1 = step(1, '설치 전에 막힘을 먼저 풀어 두기', `
    <p>설치 도중에 "차단됨" 화면이 나와서 당황하지 않도록 <b>미리</b> 풀어 둡니다. <small>(삼성 갤럭시 기준이에요. 다른 폰은 메뉴 이름이 조금 달라요.)</small></p>
    <ol>
      <li><b>자동 차단</b> 끄기<br><small>설정 → <b>보안 및 개인정보 보호</b> → <b>자동 차단</b> → 스위치 끄기. 켜 두면 외부 앱 설치가 막혀요. 메뉴가 없으면 건너뛰세요.</small></li>
      <li><b>Chrome의 "알 수 없는 앱 설치" 허용</b><br><small>설정 → <b>애플리케이션</b> → <b>Chrome</b> → <b>알 수 없는 앱 설치</b> → <b>허용</b></small></li>
      <li><b>Play 프로텍트의 앱 검사</b> 끄기 <small>(설치가 끝나면 다시 켜도 돼요)</small><br><small><b>Play 스토어</b> → 오른쪽 위 내 사진 → <b>Play 프로텍트</b> → 오른쪽 위 톱니바퀴 → <b>Play 프로텍트로 앱 검사</b> 끄기</small></li>
      <li>이 폰은 <b>문자 전용(회사 폰)</b>으로 쓰고, 화면 잠금과 충전기를 준비해 두세요.</li>
    </ol>
    ${info('앱 설치 후에 자동 차단을 다시 켜면, 앞으로 <b>앱 업데이트가 막힐 수 있어요.</b> 문자 전용 폰이라면 꺼 둔 채로 쓰는 것을 권해요.')}`);

  const s2 = step(2, 'Obtainium 설치하기', `
    <p><b>Obtainium</b>은 GitHub의 앱을 안전하게 설치하고 업데이트해 주는 무료 오픈소스 앱이에요. 이걸로 SMSGate를 설치하면 문자 권한이 <b>막히지 않아요.</b></p>
    <ol>
      <li>폰에서 <b>Chrome</b>을 열고 아래 주소로 들어가요.</li>
    </ol>
    ${urlLine(OBTAINIUM_URL, 'Obtainium 내려받기 주소')}
    <ol start="2">
      <li>아래로 내려 <b>Assets</b>를 눌러 펼치고, <b>app-release.apk</b> 를 눌러요. <small>(이름이 비슷한 파일이 많아요. 모르면 <b>app-release.apk</b> 하나만 고르면 돼요.)</small></li>
      <li>다운로드가 끝나면 <b>열기</b> → <b>설치</b>를 눌러요. "이 출처 허용" 화면이 나오면 스위치를 켜고 뒤로 간 뒤 다시 <b>설치</b>를 눌러요.</li>
      <li>설치 후 <b>Obtainium</b>을 열어 두세요. (알림 허용은 선택이에요.)</li>
    </ol>`);

  const s3 = step(3, 'Obtainium으로 SMSGate 설치하기', `
    <ol>
      <li>Obtainium 아래 메뉴에서 <b>앱 추가</b>(Add App)를 눌러요.</li>
      <li>입력칸에 아래 주소를 붙여넣고 <b>추가</b>(Add)를 눌러요.</li>
    </ol>
    ${urlLine(SMSGATE_URL, 'SMSGate 주소')}
    <ol start="3">
      <li>파일 목록이 나오면 <b>app-release.apk</b> 를 골라요.<br>${warn('<b>app-insecure.apk</b> 나 <b>.aab</b> 파일은 고르지 마세요.')}</li>
      <li>앱 목록에서 <b>SMSGate</b>의 <b>설치</b>(Install)를 눌러요. 처음에는 "Obtainium의 알 수 없는 앱 설치"를 <b>허용</b>하라고 물어요. 허용하고 뒤로 간 뒤 다시 <b>설치</b>를 눌러요.</li>
      <li>설치가 끝나면 <b>SMSGate</b> 앱이 생겨요. 이후 업데이트도 Obtainium이 알려 줘요.</li>
    </ol>`);

  const s4 = step(4, '문자 권한 허용하기', `
    <ol>
      <li><b>SMSGate</b>를 열면 권한 창이 나와요. <b>문자(SMS)</b>와 <b>전화</b> 권한을 모두 <b>허용</b>해요.</li>
      <li>"문자를 보내고 보기"처럼 묻는 창에서 <b>허용</b>을 누르면 돼요.</li>
    </ol>
    <details class="help">
      <summary>🔧 <b>허용이 회색이거나 "접근이 차단되었어요 / 제한된 설정"이 나올 때</b></summary>
      <p style="margin-top:8px">Obtainium으로 설치했는데도 막히는 폰이 있어요. 아래 순서로 한 번만 풀면 돼요.</p>
      <ol>
        <li>안 눌리는 <b>허용</b>(또는 권한 항목)을 <b>한 번 눌러 보고</b> 나와요.</li>
        <li><b>설정</b> → <b>애플리케이션</b> → <b>SMSGate</b> 를 눌러요.</li>
        <li>오른쪽 위 <b>점 세 개(⋮)</b> → <b>제한된 설정 허용</b> → 지문/비밀번호로 확인해요.</li>
        <li>뒤로 가서 <b>권한</b> → <b>문자</b> → <b>허용</b>을 눌러요.</li>
      </ol>
      <small>점 세 개가 안 보이면 1번을 한 뒤 화면을 닫았다가 다시 열어 보세요.</small>
    </details>`);

  const s5 = step(5, '문자 앱의 "채팅(RCS)" 기능 끄기 <small>(꼭 해야 해요)</small>', `
    <p>갤럭시는 문자가 일반 문자가 아니라 <b>인터넷 채팅(RCS)</b>으로 오는 경우가 있어요. 이렇게 오면 SMSGate가 <b>받은 문자를 알아보지 못해요.</b></p>
    <ol>
      <li><b>메시지</b> 앱 → 오른쪽 위 <b>점 세 개(⋮)</b> → <b>설정</b> → <b>채팅 설정</b>(또는 채팅 서비스)</li>
      <li><b>채팅 기능</b> 스위치를 <b>끕니다</b>.</li>
    </ol>
    <small>구글 "메시지" 앱도 쓰고 있다면 프로필 사진 → 메시지 설정 → <b>RCS 채팅</b>에서 끄고, 둘 다 설치되어 있으면 <b>둘 다</b> 끄세요. 끈 뒤 10분쯤 지나면 효과가 나타나요.</small>`);

  const s6 = step(6, '폰이 꺼지지 않게 설정하기', `
    <ol>
      <li><b>설정</b> → <b>애플리케이션</b> → <b>SMSGate</b> → <b>배터리</b> → <b>제한 없음</b></li>
      <li><b>설정</b> → <b>배터리</b> → <b>백그라운드 사용 제한</b> → <b>사용하지 않는 앱 절전</b>을 끄거나, SMSGate를 <b>절전 예외</b>로 해 둬요.</li>
      <li>SMSGate <b>Settings → Ping → Interval(seconds)</b> 를 <b>300</b>으로 하면 폰 상태를 더 정확히 볼 수 있어요. <small>(배터리를 조금 더 써요)</small></li>
      <li>이 폰은 <b>충전기에 꽂아 두고 전원을 켜 두세요.</b></li>
    </ol>`);

  const s7 = pub
    ? step(7, '문자 내용 암호화 켜기 <small>(꼭 하세요)</small>', `
      <p>이 시스템은 <b>공개 문자 서버</b>를 거쳐 문자를 보내요. 서버가 문자 내용과 전화번호를 볼 수 없도록 <b>암호 문장</b>을 정해 앱과 웹 두 곳에 똑같이 넣어요.</p>
      <ol>
        <li>SMSGate → <b>Settings</b> → <b>Encryption</b> → <b>Passphrase</b>에 <b>길고 아무도 모르는 문장</b>(12자 이상)을 적고 저장해요.</li>
        <li>같은 문장을 아래 <b>9번의 "암호화 비밀번호"</b>에도 똑같이 적어요.</li>
      </ol>
      <small>서버 주소 칸은 <b>기본값 그대로</b> 두세요. <b>Encryption 메뉴가 안 보이면</b> Settings를 맨 아래까지 내려 보세요(Webhooks… 다음, Ping 위에 있어요).</small>`)
    : step(7, '앱에 서버 정보 넣기', `
      ${showSecrets ? `<p>아래 두 개를 차례로 <b>복사</b>해서 앱에 <b>붙여넣어요</b>.</p>
      ${box('① 서버 주소 (앱에서는 "API URL")', apiUrl)}
      ${box('② 비밀 번호표 (앱에서는 "Private Token")', token)}` : '<p>서버 주소와 비밀 번호표는 <b>관리자에게</b> 받으세요.</p>'}
      <ol>
        <li>SMSGate → <b>Settings</b> → <b>Cloud Server…</b></li>
        <li><b>API URL</b>, <b>Private Token</b> 칸을 눌러 붙여넣고 저장(✔)해요.</li>
      </ol>`);

  const s8 = step(8, '켜기', `
    <ol>
      <li>SMSGate <b>Home</b> 탭에서 <b>Cloud server</b> 스위치를 <b>켜요</b>.</li>
      <li><b>Start Service</b> 버튼을 눌러요. (버튼이 <b>Stop Service</b>로 바뀌면 켜진 거예요.)</li>
      <li>처음이면 <b>Sign Up</b> 창이 나와요. <b>Sign Up → Continue</b>를 눌러요.</li>
      <li><b>Settings → Cloud Server…</b> 화면에서 <b>Username</b>과 <b>Password</b>를 확인해 메모해요.</li>
    </ol>`);
  return [s1, s2, s3, s4, s5, s6, s7, s8].join('\n');
}

// 막혔을 때 보는 표
export const TROUBLE_TABLE = `
<div class="table-wrap"><table>
  <thead><tr><th>이런 화면이 나오면</th><th>이렇게 해요</th></tr></thead>
  <tbody>
    <tr><td>"보안 정책 / 자동 차단 때문에 설치할 수 없어요"</td><td>설정 → 보안 및 개인정보 보호 → <b>자동 차단 끄기</b> → 다시 설치</td></tr>
    <tr><td>"이 출처에서 앱 설치가 차단되었어요"</td><td><b>설정 열기</b> → "이 출처 허용" 스위치 켜기 → 뒤로 가서 다시 설치</td></tr>
    <tr><td>"Play 프로텍트: 앱이 차단되었어요 / 유해할 수 있어요"</td><td><b>더보기 → 무시하고 설치</b>, 또는 Play 프로텍트 "앱 검사"를 끄고 다시 설치</td></tr>
    <tr><td>"앱이 설치되지 않았어요 / 패키지 충돌"</td><td>이미 깔린 SMSGate를 <b>삭제</b>한 뒤 Obtainium에서 다시 설치 (insecure 버전을 깔았다면 꼭 삭제)</td></tr>
    <tr><td>문자 권한 <b>허용 버튼이 회색</b> / "접근이 차단되었어요"</td><td>앱 정보 → <b>⋮ → 제한된 설정 허용</b> → 권한 → 문자 허용 (4번)</td></tr>
    <tr><td>Obtainium: "릴리스를 찾을 수 없어요"</td><td>주소를 다시 확인해요: <code>https://github.com/capcom6/android-sms-gateway</code></td></tr>
    <tr><td>Obtainium: 파일 목록에 여러 개가 나와요</td><td><b>app-release.apk</b> 만 고르기 (insecure, aab 제외)</td></tr>
    <tr><td>설치는 됐는데 문자를 받지 못해요</td><td>채팅(RCS) 끄기(5번), 앱 <b>Start Service</b> 확인, 설정의 <b>받기 시험</b></td></tr>
  </tbody></table></div>`;

const COPY_JS = `<script>
document.addEventListener('click', function (e) {
  var b = e.target.closest('[data-copy]'); if (!b) return;
  navigator.clipboard.writeText(b.getAttribute('data-copy')).then(function () {
    var t = b.textContent; b.textContent = '복사됐어요 ✓'; setTimeout(function () { b.textContent = t; }, 1800);
  });
});
</script>`;

export function renderPhoneHelp({ pub, apiUrl, token, isAdmin }) {
  return `${pageHeader({ title: '폰 설치 안내', desc: '문자를 보낼 안드로이드 폰에 SMSGate를 설치하고 연결하는 방법이에요. 처음부터 <b>Obtainium</b>으로 설치하면 최신 안드로이드의 "접근 차단"을 피할 수 있어요.' })}
    <div class="col">
      ${info('<b>왜 Obtainium인가요?</b> 최신 안드로이드(13 이상)는 GitHub에서 직접 받은 앱의 <b>문자 권한을 막아요.</b> Obtainium은 앱 설치·업데이트용 도구로 설치해서, 이 막힘을 대부분 피할 수 있어요. 그래도 막히면 아래 "이런 화면이 나오면" 표를 보세요.')}
      ${phoneSetupSteps({ pub, apiUrl, token, showSecrets: isAdmin })}
      <section class="section">
        <div class="shead"><h2>이런 화면이 나오면</h2></div>
        ${TROUBLE_TABLE}
      </section>
      <p class="muted" style="margin-top:20px">${isAdmin ? '여기까지 끝나면 <a href="/admin">설정</a>에서 앱의 Username/Password를 입력해 연결을 마쳐요.' : '여기까지 끝나면 관리자에게 알려 주세요. 관리자가 연결을 마쳐 줘요.'}</p>
    </div>
    ${COPY_JS}`;
}
