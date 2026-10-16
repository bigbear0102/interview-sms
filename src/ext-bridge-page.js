// 수신함 화면 ↔ 크롬 확장 연결(브라우저에서 도는 스크립트).
//  - 그룹웨어 아이디·비밀번호는 이 화면의 입력칸에서 받아 "확장 프로그램"에만 건네고, 서버로는 보내지 않는다. (양식에 action 이 없고 전송을 막는다)
//  - 확장이 설치되어 있으면 새로 만든 연결 키도 자동으로 확장에 넣어 준다.
// String.raw 를 써서 안의 역슬래시가 그대로 전달된다. (이 안에는 백틱과 달러 중괄호를 쓰지 않는다)
export const EXT_BRIDGE_JS = String.raw`
(function () {
  var st = document.getElementById('extstate');
  var form = document.getElementById('gwform');
  if (!st || !form) return;
  var present = false, queued = [], autoTried = false;
  var last = document.getElementById('extlast');
  var err = document.getElementById('gwerr'), btn = form.querySelector('button[type=submit]'), showPw = document.getElementById('gwshow');
  var waiting = false, waitTimer = null;
  function busy(on) {
    waiting = on;
    if (btn) { btn.disabled = on; btn.textContent = on ? '확인하는 중…' : '내 확장에 저장'; }
    clearTimeout(waitTimer);
    if (on) waitTimer = setTimeout(function () { busy(false); fail('확인이 오래 걸려요. 잠시 뒤 다시 눌러 주세요.'); }, 25000);
  }
  function fail(msg) {
    if (err) { err.hidden = false; err.textContent = msg; }
    if (ok) ok.hidden = true;
    pwEl.setAttribute('aria-invalid', 'true'); pwEl.focus();
  }
  if (showPw) showPw.addEventListener('change', function () { pwEl.type = showPw.checked ? 'text' : 'password'; });
  var idEl = document.getElementById('gwid'), pwEl = document.getElementById('gwpw'), ok = document.getElementById('gwok');
  function post(m) { m.source = 'interview-page'; window.postMessage(m, window.location.origin); }
  function show(s) {
    var t = [];
    t.push('확장 프로그램: 연결됨');
    t.push(s.hasKey ? '연결 키 있음' : '연결 키 자동 연결 중…');
    t.push(s.gwId ? ('그룹웨어 계정 저장됨 (' + s.gwId + (s.hasPw ? ', 비밀번호 저장됨' : ', 비밀번호 없음') + ')') : '그룹웨어 계정 아직 없음');
    if (s.blocked) t.push('⚠ 비밀번호 확인 필요');
    if (last) {
      last.hidden = !s.lastStatus;
      last.textContent = s.lastStatus ? ('최근 결과: ' + s.lastStatus) : '';
      last.className = 'notice ' + (s.lastLevel === 'error' || s.lastLevel === 'warn' ? 'warn' : s.lastLevel === 'ok' ? 'ok' : '');
    }
    st.textContent = t.join(' · ');
    st.className = 'notice ok';
    if (s.gwId && !idEl.value) idEl.value = s.gwId;
  }
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (e.source !== window || !d || d.source !== 'albamon-ext') return;
    if (d.type === 'ready' || d.type === 'state') {
      present = true; show(d.state);
      while (queued.length) post(queued.shift());
      // 확장에 연결 키가 없으면 자동으로 만들어서 넣는다(입력할 필요 없음)
      if (d.state && !d.state.hasKey && !autoTried) {
        autoTried = true;
        st.textContent = '확장 프로그램: 연결됨 · 연결 키를 자동으로 만드는 중…';
        fetch('/applicants/inbox/agent-token.json', { method: 'POST', credentials: 'same-origin' })
          .then(function (r) { return r.json(); })
          .then(function (j) { if (j && j.token) post({ type: 'save', agentToken: j.token }); })
          .catch(function () { st.textContent = '연결 키를 자동으로 만들지 못했어요. 아래 "연결 키 직접 만들기(고급)"를 눌러 주세요.'; });
      }
    } else if (d.type === 'saved') {
      show(d.state);
      if (!waiting) return;   // 연결 키 자동 입력 등 사용자가 누르지 않은 저장은 알리지 않는다
      busy(false);
      var s = d.state || {};
      if (s.blocked || s.lastLevel === 'error') {
        // 비밀번호가 맞지 않음 등: 입력한 값은 그대로 두어 고칠 수 있게 한다
        fail(s.lastStatus ? s.lastStatus.replace(/^[^·]*· /, '') : '그룹웨어 로그인 정보를 확인하지 못했어요.');
      } else {
        if (err) err.hidden = true;
        pwEl.removeAttribute('aria-invalid');
        pwEl.value = '';
        if (ok) { ok.hidden = false; setTimeout(function () { ok.hidden = true; }, 8000); }
      }
    }
  });
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!present) { st.textContent = '이 PC의 크롬에서 확장 프로그램이 보이지 않아요. 설치했다면 이 페이지를 새로고침해 주세요.'; return; }
    if (!idEl.value.trim()) { fail('그룹웨어 메일 주소(또는 아이디)를 입력해 주세요.'); idEl.focus(); return; }
    if (!pwEl.value) { fail('그룹웨어 비밀번호를 입력해 주세요.'); return; }
    if (err) err.hidden = true;
    pwEl.removeAttribute('aria-invalid');
    busy(true);
    post({ type: 'save', gwId: idEl.value.trim(), gwPw: pwEl.value, gwOn: true });
  });
  var key = document.getElementById('newkey');
  if (key && key.textContent.trim()) queued.push({ type: 'save', agentToken: key.textContent.trim() });
  post({ type: 'hello' });
  setInterval(function () { if (present && !document.hidden) post({ type: 'hello' }); }, 3000);
  setTimeout(function () {
    if (!present) { st.textContent = '이 PC의 크롬에서 확장 프로그램이 보이지 않아요. 아직 설치 전이면 위의 "확장 프로그램 내려받기"로 설치하고, 설치했다면 이 페이지를 새로고침해 주세요.'; st.className = 'notice warn'; }
  }, 1800);
})();
`;
