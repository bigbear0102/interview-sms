// 연결 설정 화면 ↔ 크롬 확장 연결(브라우저에서 도는 스크립트, v1.8 부터 연락처 가져오기 전용).
//  - 확장이 설치되어 있으면 알아보고(버전·연결 키·최근 결과), 연결 키가 없으면 자동으로 만들어 확장에 넣어 준다.
//  - 그룹웨어 계정 입력은 없앴다(지원 메일은 시스템이 그룹웨어 POP3 로 직접 가져온다).
// String.raw 를 써서 안의 역슬래시가 그대로 전달된다. (이 안에는 백틱과 달러 중괄호를 쓰지 않는다)
export const EXT_BRIDGE_JS = String.raw`
(function () {
  var st = document.getElementById('extstate');
  if (!st) return;
  var last = document.getElementById('extlast');
  var present = false, queued = [], autoTried = false, lastReply = Date.now();
  function cmp(a, b) { var x = a.split('.'), y = b.split('.'); for (var i = 0; i < 3; i++) { var d = (parseInt(x[i], 10) || 0) - (parseInt(y[i], 10) || 0); if (d) return d; } return 0; }
  function post(m) { m.source = 'interview-page'; window.postMessage(m, window.location.origin); }
  function show(s) {
    s = s || {};
    var t = ['확장 프로그램: 연결됨' + (s.version ? ' (v' + s.version + ')' : '')];
    var latest = st.getAttribute('data-latest') || '', old = false;
    if (latest && s.version && cmp(s.version, latest) < 0) {
      t.push('⚠ 새 버전 v' + latest + '이 있어요 — 위 "확장 프로그램 내려받기"로 받아 덮어쓴 뒤 chrome://extensions 에서 새로고침해 주세요.');
      old = true;
    }
    t.push(s.hasKey ? '연결 키 있음' : '연결 키 자동 연결 중…');
    st.textContent = t.join(' · ');
    st.className = 'notice ' + (old ? 'warn' : 'ok');
    if (last) {
      last.hidden = !s.lastStatus;
      last.textContent = s.lastStatus ? ('최근 결과: ' + s.lastStatus) : '';
      last.className = 'notice ' + (s.lastLevel === 'error' || s.lastLevel === 'warn' ? 'warn' : s.lastLevel === 'ok' ? 'ok' : '');
    }
  }
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (e.source !== window || !d || d.source !== 'albamon-ext') return;
    lastReply = Date.now();
    if (d.type === 'ready' || d.type === 'state' || d.type === 'saved') {
      present = true; show(d.state);
      while (queued.length) post(queued.shift());
      // 확장에 연결 키가 없으면 자동으로 만들어서 넣는다(입력할 필요 없음)
      if (d.state && !d.state.hasKey && !autoTried) {
        autoTried = true;
        st.textContent = '확장 프로그램: 연결됨 · 연결 키를 자동으로 만드는 중…';
        fetch('/applicants/inbox/agent-token.json', { method: 'POST', credentials: 'same-origin' })
          .then(function (r) { return r.json(); })
          .then(function (j) { if (j && j.token) post({ type: 'save', agentToken: j.token }); })
          .catch(function () { st.textContent = '연결 키를 자동으로 만들지 못했어요. 아래 "고급 설정"의 "연결 키 직접 만들기"를 눌러 주세요.'; });
      }
    }
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
    if (!present) { st.textContent = '이 PC의 크롬에서 확장 프로그램이 보이지 않아요. 아직 설치 전이면 위의 "확장 프로그램 내려받기"로 설치하고, 설치했다면 이 페이지를 새로고침해 주세요. (휴대폰에서는 보이지 않는 게 정상이에요)'; st.className = 'notice warn'; }
  }, 1800);
})();
`;
