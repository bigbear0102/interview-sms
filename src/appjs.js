// 모든 로그인 후 화면에 들어가는 공통 스크립트
//  1) 확인이 필요한 양식(data-confirm)은 브라우저 기본 창 대신 화면 안 대화상자로 묻는다
//  2) 제출하면 버튼을 잠그고 "처리 중…"을 보여 줘서 두 번 눌러도 한 번만 보낸다
//  3) 저장 완료 안내는 잠시 뒤 사라지고, 결과용 주소 조각은 주소에서 지운다
//  4) 더보기(모바일 하단 메뉴) 열고 닫기
// String.raw 를 써서 안의 역슬래시가 그대로 브라우저로 전달된다. (이 안에는 백틱과 달러 중괄호를 쓰지 않는다)
export const APP_JS = String.raw`
(function () {
  var dlg = null, pending = null;
  var DANGER = /삭제|지울|해제|되돌릴|되돌리기|멈출|취소할/;

  function ensure() {
    if (dlg) return dlg;
    dlg = document.createElement('dialog');
    dlg.className = 'cdlg';
    dlg.setAttribute('aria-labelledby', 'cdlg-msg');
    dlg.innerHTML = '<form method="dialog"><p id="cdlg-msg"></p><div class="cdlg-actions">' +
      '<button value="no" class="btn secondary">취소</button><button value="yes" class="btn" id="cdlg-yes">확인</button></div></form>';
    document.body.appendChild(dlg);
    dlg.addEventListener('close', function () {
      var ok = dlg.returnValue === 'yes', cb = pending;
      pending = null;
      if (ok && cb) cb();
    });
    dlg.addEventListener('click', function (e) { if (e.target === dlg) dlg.close('no'); });
    return dlg;
  }

  window.askConfirm = function (msg, cb) {
    var probe = document.createElement('dialog');
    if (typeof probe.showModal !== 'function') { if (window.confirm(msg)) cb(); return; }
    var d = ensure();
    d.querySelector('#cdlg-msg').textContent = msg;
    var yes = d.querySelector('#cdlg-yes');
    yes.className = 'btn' + (DANGER.test(msg) ? ' danger' : '');
    pending = cb;
    d.returnValue = '';
    d.showModal();
    d.querySelector('button[value=no]').focus();
  };

  // 제출 가로채기: 확인 → 처리 중 표시
  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (!f || !f.getAttribute || f.getAttribute('method') === 'dialog') return;
    var m = f.getAttribute('data-confirm');
    if (m && !f.__ok) {
      e.preventDefault();
      var sub = e.submitter || null;
      window.askConfirm(m, function () {
        f.__ok = true;
        try { if (f.requestSubmit) f.requestSubmit(sub || undefined); else f.submit(); }
        finally { setTimeout(function () { f.__ok = false; }, 0); }
      });
      return;
    }
    if (f.__busy) { e.preventDefault(); return; }
    f.__busy = true;
    var s = e.submitter || null;
    setTimeout(function () {
      var list = Array.prototype.slice.call(f.querySelectorAll('button:not([type=button])'));
      if (f.id) list = list.concat(Array.prototype.slice.call(document.querySelectorAll('button[form="' + f.id + '"]')));
      list.forEach(function (b) { b.disabled = true; });
      f.setAttribute('aria-busy', 'true');
      if (s && s.tagName === 'BUTTON' && !s.querySelector('svg')) s.textContent = '처리 중…';
    }, 0);
  }, true);

  // 뒤로 가기로 돌아왔을 때 잠긴 버튼이 남지 않도록 새로 읽는다
  window.addEventListener('pageshow', function (e) { if (e.persisted) location.reload(); });

  // 저장 완료 안내는 잠시 뒤 사라진다(누를 수 있는 것이 들어 있으면 그대로 둔다)
  document.querySelectorAll('.notice.ok').forEach(function (n) {
    if (n.querySelector('a,form,button')) return;
    var gone = function () { n.style.transition = 'opacity .3s'; n.style.opacity = '0'; setTimeout(function () { n.remove(); }, 320); };
    setTimeout(gone, 8000);
    n.addEventListener('click', gone);
  });

  // 결과용 주소 조각은 주소에서 지운다
  try {
    var u = new URL(location.href), ch = false;
    ['ok', 'err', 'n', 'k'].forEach(function (k) { if (u.searchParams.has(k)) { u.searchParams.delete(k); ch = true; } });
    if (ch) history.replaceState(null, '', u.pathname + u.search + u.hash);
  } catch (err) { /* 무시 */ }

  // 더보기(모바일 하단 메뉴)
  var b = document.querySelector('.tabmore'), s = document.getElementById('moresheet');
  if (b && s) {
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = s.hidden;
      s.hidden = !open;
      b.setAttribute('aria-expanded', String(open));
    });
    document.addEventListener('click', function (e) {
      if (!s.hidden && !s.contains(e.target)) { s.hidden = true; b.setAttribute('aria-expanded', 'false'); }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !s.hidden) { s.hidden = true; b.setAttribute('aria-expanded', 'false'); b.focus(); }
    });
  }
})();
`;
