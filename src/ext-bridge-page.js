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
  var waiting = false, waitTimer = null, old = false, lastReply = Date.now();
  var list = document.getElementById('gwlist'), pendingKey = '', limitEl = document.getElementById('gwlimit');
  if (limitEl) limitEl.addEventListener('change', function () { post({ type: 'save', gwLimit: parseInt(limitEl.value, 10) || 0 }); });
  function keyOf(id) { return String(id || '').split('@')[0].trim().toLowerCase(); }
  // 등록된 그룹웨어 계정 목록(아이디·상태·삭제). 비밀번호는 화면으로 오지 않는다.
  function renderList(a) {
    if (!list) return;
    list.textContent = '';
    (a || []).forEach(function (x) {
      var li = document.createElement('li');
      li.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:8px 0;border-bottom:1px solid #e5e5ea';
      var nm = document.createElement('b'); nm.textContent = x.id;
      var bd = document.createElement('span'); bd.className = 'badge ' + (x.blocked ? 'fail' : 'ok'); bd.textContent = x.blocked ? '비밀번호 확인 필요' : (x.on ? '사용 중' : '꺼짐');
      var ms = document.createElement('small'); ms.className = 'muted'; ms.style.flex = '1 1 200px'; ms.textContent = x.last && x.last.text ? x.last.text : '';
      var dl = document.createElement('button'); dl.type = 'button'; dl.className = 'small secondary'; dl.textContent = '삭제';
      dl.addEventListener('click', function () { if (window.confirm(x.id + ' 계정을 지울까요? (이 PC에 저장된 비밀번호도 지워져요)')) post({ type: 'save', removeAccount: x.id }); });
      li.appendChild(nm); li.appendChild(bd); li.appendChild(ms); li.appendChild(dl);
      list.appendChild(li);
    });
  }
  var prog = document.getElementById('gwprog');
  function cmp(a, b) { var x = a.split('.'), y = b.split('.'); for (var i = 0; i < 3; i++) { var d = (parseInt(x[i], 10) || 0) - (parseInt(y[i], 10) || 0); if (d) return d; } return 0; }
  function busy(on) {
    waiting = on;
    if (btn) { btn.disabled = on; btn.textContent = on ? '확인하는 중…' : '계정 추가·확인'; }
    if (prog) prog.hidden = !on;
    clearTimeout(waitTimer);
    if (on) waitTimer = setTimeout(function () { busy(false); fail('확장 프로그램에서 답이 오지 않았어요. 확장 프로그램을 새로고침(chrome://extensions)했다면 이 페이지도 새로고침(F5)한 뒤 다시 눌러 주세요.'); }, 12000);
  }
  // 입력칸 아래 오류와 같은 문구면 위의 "최근 결과"는 숨긴다(같은 말이 두 번 보이지 않게)
  function dedupe() {
    if (!last || !err) return;
    var lt = (last.textContent || '').replace(/^최근 결과: [^·]*· /, '').trim();
    lt = lt.replace(/^\[[^\]]*\]\s*/, '');
    var et = err.textContent.trim();
    if (!err.hidden && lt && et && (et === lt || lt.indexOf(et) >= 0)) last.hidden = true;
  }
  function fail(msg) {
    if (err) { err.hidden = false; err.textContent = msg; }
    dedupe();
    if (ok) ok.hidden = true;
    pwEl.setAttribute('aria-invalid', 'true'); pwEl.focus();
  }
  if (showPw) showPw.addEventListener('change', function () { pwEl.type = showPw.checked ? 'text' : 'password'; });
  var idEl = document.getElementById('gwid'), pwEl = document.getElementById('gwpw'), ok = document.getElementById('gwok');
  function post(m) { m.source = 'interview-page'; window.postMessage(m, window.location.origin); }
  function show(s) {
    var t = [];
    t.push('확장 프로그램: 연결됨' + (s.version ? ' (v' + s.version + ')' : ''));
    var latest = st.getAttribute('data-latest') || '';
    if (latest && s.version && cmp(s.version, latest) < 0) {
      t.push('⚠ 새 버전 v' + latest + '이 있어요 — 위 "확장 프로그램 내려받기"로 받아 덮어쓴 뒤 chrome://extensions 에서 새로고침해 주세요. (예전 버전은 비밀번호 확인이 안 돼요)');
      old = true;
    } else { old = false; }
    t.push(s.hasKey ? '연결 키 있음' : '연결 키 자동 연결 중…');
    var n = (s.accounts || []).length;
    t.push(n ? ('그룹웨어 계정 ' + n + '개 등록됨 (' + s.accounts.map(function (x) { return x.id; }).join(', ') + ')') : (s.gwId ? ('그룹웨어 계정 저장됨 (' + s.gwId + ')') : '그룹웨어 계정 아직 없음'));
    renderList(s.accounts);
    if (limitEl && typeof s.gwLimit === 'number' && document.activeElement !== limitEl) limitEl.value = String(s.gwLimit);
    if (s.blocked) t.push('⚠ 비밀번호 확인 필요');
    if (last) {
      last.hidden = !s.lastStatus;
      last.textContent = s.lastStatus ? ('최근 결과: ' + s.lastStatus) : '';
      last.className = 'notice ' + (s.lastLevel === 'error' || s.lastLevel === 'warn' ? 'warn' : s.lastLevel === 'ok' ? 'ok' : '');
    }
    st.textContent = t.join(' · ');
    st.className = 'notice ' + (old ? 'warn' : 'ok');
    dedupe();
  }
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (e.source !== window || !d || d.source !== 'albamon-ext') return;
    lastReply = Date.now();
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
      var acct = (s.accounts || []).filter(function (x) { return keyOf(x.id) === pendingKey; })[0];
      if (!acct || acct.blocked) {
        // 비밀번호가 맞지 않음 등: 입력한 값은 그대로 두어 고칠 수 있게 한다
        fail(acct && acct.last && acct.last.text ? acct.last.text : (s.lastStatus ? s.lastStatus.replace(/^[^·]*· /, '') : '그룹웨어 로그인 정보를 확인하지 못했어요.'));
      } else {
        if (err) err.hidden = true;
        pwEl.removeAttribute('aria-invalid');
        pwEl.value = ''; idEl.value = '';
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
    pendingKey = keyOf(idEl.value);
    busy(true);
    post({ type: 'save', account: { id: idEl.value.trim(), pw: pwEl.value } });
  });
  var key = document.getElementById('newkey');
  if (key && key.textContent.trim()) queued.push({ type: 'save', agentToken: key.textContent.trim() });
  post({ type: 'hello' });
  setInterval(function () {
    if (document.hidden) { lastReply = Date.now(); return; }   // 보이지 않는 탭에서는 확인하지 않는다
    post({ type: 'hello' });
    // 확장을 새로고침하면 이 페이지와의 연결이 끊긴다: 한동안 답이 없으면 알려 준다
    if (present && Date.now() - lastReply > 9000) { present = false; st.className = 'notice warn'; st.textContent = '확장 프로그램과의 연결이 끊겼어요. 확장을 새로고침했거나 업데이트했다면 이 페이지를 새로고침(F5)해 주세요.'; }
  }, 3000);
  setTimeout(function () {
    if (!present) { st.textContent = '이 PC의 크롬에서 확장 프로그램이 보이지 않아요. 아직 설치 전이면 위의 "확장 프로그램 내려받기"로 설치하고, 설치했다면 이 페이지를 새로고침해 주세요.'; st.className = 'notice warn'; }
  }, 1800);
})();
`;
