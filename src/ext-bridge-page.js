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
  var idEl = document.getElementById('gwid'), pwEl = document.getElementById('gwpw'), ok = document.getElementById('gwok');
  function post(m) { m.source = 'interview-page'; window.postMessage(m, window.location.origin); }
  function show(s) {
    var t = [];
    t.push('확장 프로그램: 연결됨');
    t.push(s.hasKey ? '연결 키 있음' : '연결 키 자동 연결 중…');
    t.push(s.gwId ? ('그룹웨어 계정 저장됨 (' + s.gwId + (s.hasPw ? ', 비밀번호 저장됨' : ', 비밀번호 없음') + ')') : '그룹웨어 계정 아직 없음');
    if (s.lastStatus) t.push('최근: ' + s.lastStatus);
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
      if (ok) { ok.hidden = false; setTimeout(function () { ok.hidden = true; }, 6000); }
    }
  });
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!present) { st.textContent = '이 PC의 크롬에서 확장 프로그램이 보이지 않아요. 설치했다면 이 페이지를 새로고침해 주세요.'; return; }
    post({ type: 'save', gwId: idEl.value.trim(), gwPw: pwEl.value, gwOn: true });
    pwEl.value = '';
  });
  var key = document.getElementById('newkey');
  if (key && key.textContent.trim()) queued.push({ type: 'save', agentToken: key.textContent.trim() });
  post({ type: 'hello' });
  setTimeout(function () {
    if (!present) { st.textContent = '이 PC의 크롬에서 확장 프로그램이 보이지 않아요. 아직 설치 전이면 위의 "확장 프로그램 내려받기"로 설치하고, 설치했다면 이 페이지를 새로고침해 주세요.'; st.className = 'notice warn'; }
  }, 1800);
})();
`;
