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
    // 화면 안에서 처리하는 양식(data-nolock)은 잠그지 않는다
    if (e.defaultPrevented || f.hasAttribute('data-nolock')) return;
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
// 원가중심점 찾기: 입력하면 목록에서 걸러 보여 주고, 눌러서 고른다. (띄어쓰기로 여러 글자를 함께 찾는다)
(function () {
  var box = null, cur = null, timer = null, seq = 0, active = -1;
  function hide() { if (box) { box.hidden = true; box.innerHTML = ''; } active = -1; }
  function ensure() {
    if (box) return box;
    box = document.createElement('ul');
    box.setAttribute('role', 'listbox');
    box.hidden = true;
    box.style.cssText = 'position:absolute;z-index:50;margin:0;padding:4px 0;list-style:none;background:var(--surface,#fff);color:inherit;border:1px solid var(--line,#ccc);border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.18);max-height:260px;overflow:auto;font-size:14px';
    box.addEventListener('mousedown', function (e) {
      var li = e.target.closest('li[data-v]');
      if (li && cur) { e.preventDefault(); cur.value = li.getAttribute('data-v'); hide(); }
    });
    document.body.appendChild(box);
    return box;
  }
  function place(el) {
    var r = el.getBoundingClientRect(), b = ensure();
    b.style.left = (r.left + window.pageXOffset) + 'px';
    b.style.top = (r.bottom + window.pageYOffset + 2) + 'px';
    b.style.minWidth = Math.max(r.width, 240) + 'px';
  }
  function show(el, items) {
    var b = ensure();
    cur = el; place(el); active = -1;
    if (!items.length) { b.innerHTML = '<li style="padding:8px 12px;color:#888">찾는 이름이 없어요</li>'; b.hidden = false; return; }
    b.innerHTML = '';
    items.forEach(function (v) {
      var li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.setAttribute('data-v', v);
      li.style.cssText = 'padding:8px 12px;cursor:pointer';
      li.textContent = v;
      b.appendChild(li);
    });
    b.hidden = false;
  }
  function search(el) {
    var my = ++seq;
    fetch('/applicants/inbox/cost-centers/search?q=' + encodeURIComponent(el.value), { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (my === seq && document.activeElement === el) show(el, d.items || []); })
      .catch(function () { hide(); });
  }
  document.addEventListener('input', function (e) {
    var el = e.target;
    if (!el.matches || !el.matches('input[data-cc-search]')) return;
    clearTimeout(timer);
    timer = setTimeout(function () { search(el); }, 150);
  });
  document.addEventListener('focusin', function (e) {
    var el = e.target;
    if (el.matches && el.matches('input[data-cc-search]')) { cur = el; search(el); }
  });
  document.addEventListener('focusout', function (e) {
    if (e.target.matches && e.target.matches('input[data-cc-search]')) setTimeout(hide, 120);
  });
  document.addEventListener('keydown', function (e) {
    if (!box || box.hidden || !cur) return;
    var lis = box.querySelectorAll('li[data-v]');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!lis.length) return;
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + lis.length) % lis.length;
      lis.forEach(function (li, i) { li.style.background = i === active ? 'rgba(0,113,227,.15)' : ''; });
      lis[active].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault(); cur.value = lis[active].getAttribute('data-v'); hide();
    } else if (e.key === 'Escape') { hide(); }
  });
})();

// 제안 버튼(data-fill): 눌러서 같은 양식의 원가중심점 칸에 채운다
document.addEventListener('click', function (e) {
  var b = e.target.closest && e.target.closest('button[data-fill]');
  if (!b) return;
  var card = b.closest('section') || document;
  var inp = card.querySelector('input[name=cost_center]');
  if (inp) { inp.value = b.getAttribute('data-fill'); inp.focus(); }
  var job = b.getAttribute('data-fill-job'), ji = card.querySelector('input[name=job]');
  if (job && ji && !ji.value) ji.value = job;   // AI 추천 직무는 비어 있을 때만
});

// 연락처 가져오기를 요청한 직후(주소에 fr=건수 가 붙어 돌아온 화면)에는 확장 프로그램을 바로 깨운다(30초 알람을 기다리지 않도록)
(function () {
  try {
    var u = new URL(location.href);
    var fr = parseInt(u.searchParams.get('fr') || '0', 10);
    var ok = u.searchParams.get('ok');
    if (fr > 0 || ok === 'fetch' || ok === 'fetchall') window.postMessage({ source: 'interview-page', type: 'kick' }, location.origin);
    if (u.searchParams.has('fr')) { u.searchParams.delete('fr'); history.replaceState(null, '', u.pathname + (u.search ? u.search : '') + u.hash); }
  } catch (e) { /* ignore */ }
})();

// 대화 창(data-dialog="아이디" 버튼으로 열고, data-close 버튼이나 바깥 눌러서 닫는다)
document.addEventListener('click', function (e) {
  var o = e.target.closest && e.target.closest('[data-dialog]');
  if (o) { var d = document.getElementById(o.getAttribute('data-dialog')); if (d && d.showModal) { d.showModal(); var f = d.querySelector('input:not([type=hidden]),textarea'); if (f) f.focus(); } return; }
  var c = e.target.closest && e.target.closest('[data-close]');
  if (c) { var dd = c.closest('dialog'); if (dd) dd.close(); return; }
  if (e.target.tagName === 'DIALOG' && e.target.classList.contains('sheet')) e.target.close();
});
`;
