// 알바몬 이력서 화면 안에서 실행되는 함수. 크롬 확장(tools/albamon-extension/background.js)의 pageRead 와 글자 하나까지 같아야 한다
// (test/agent-lib.test.js 가 확인). 고칠 때는 두 곳을 함께 고친다. 다른 것을 참조하지 않는다(브라우저 안으로 그대로 보내진다).
export async function pageRead(item, dry) {
  const sleepP = (ms) => new Promise((r) => setTimeout(r, ms));
  const text = () => (document.body && document.body.innerText) || '';
  const PHONE_RE = /01[016789][-\s.]?\d{3,4}[-\s.]?\d{4}/g;
  const digits = (s) => String(s || '').replace(/\D/g, '');
  const findPhones = (t) => { const o = []; for (const m of String(t).matchAll(PHONE_RE)) { const d = digits(m[0]); if (/^01[016789]\d{7,8}$/.test(d) && !o.includes(d)) o.push(d); } return o; };
  const pickPhone = (t) => {
    const all = findPhones(t); if (!all.length) return '';
    const lines = String(t).split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (/(연락처|휴대폰|핸드폰|전화번호|휴대전화)/.test(lines[i])) { const n = findPhones(lines.slice(i, i + 3).join(' ')); if (n.length) return n[0]; }
    }
    return all[0];
  };
  const nameMatches = (t, name) => {
    const n = String(name || '').trim(); if (!n) return false;
    if (t.includes(n)) return true;
    if (n.length >= 2) { const m = n[0] + '*'.repeat(Math.max(n.length - 2, 1)) + n[n.length - 1]; return t.includes(m) || t.includes(n[0] + '*' + n.slice(2)); }
    return false;
  };
  const visible = (e) => { const r = e.getBoundingClientRect(); const st = getComputedStyle(e); return r.width > 0 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden'; };
  const DEDUCT = /(차감|이용권|열람권|포인트|결제|구매|사용하시겠|유료|잔여|캐시|상품)/;
  const GONE = /(삭제된 이력서|존재하지 않는|찾을 수 없|열람 기간|열람기간|기간이 만료|비공개)/;
  const pats = [/(연락처|전화번호|휴대폰|핸드폰|휴대전화).{0,6}(보기|확인|열람|조회)/, /(보기|확인|열람|조회).{0,6}(연락처|전화번호|휴대폰|핸드폰)/];
  const findReveal = () => {
    const els = [...document.querySelectorAll('button,a,[role=button],span,div,li,label')];
    const hit = els.filter((e) => {
      const t = (e.innerText || '').replace(/\s+/g, ' ').trim();
      return t && t.length <= 24 && visible(e) && pats.some((re) => re.test(t));
    });
    return hit.find((e) => !hit.some((o) => o !== e && e.contains(o))) || hit[0] || null;
  };
  const labels = () => [...new Set([...document.querySelectorAll('button,[role=button],input[type=button],input[type=submit]')].filter(visible)
    .map((e) => (e.innerText || e.value || '').replace(/\s+/g, ' ').trim()).filter((t) => t && t.length <= 14))].slice(0, 10);
  const dialogs = () => [...document.querySelectorAll('dialog[open],[role=dialog],[role=alertdialog],.modal,.popup,.layer,[class*=modal],[class*=popup],[class*=layer]')].filter(visible);
  const loginNow = () => { const pw = document.querySelector('input[type=password]'); return (pw && visible(pw)) || /user-account\/login|\/login/i.test(location.href); };

  // 1) 화면이 준비될 때까지(최대 15초): 로그인 화면 / 번호가 이미 보임 / 연락처 보기 버튼 / 이력서 없음 안내
  const start = Date.now();
  let phone = '', el = null;
  for (;;) {
    if (loginNow()) return { state: 'login' };
    const t = text();
    phone = pickPhone(t);
    if (phone) break;
    el = findReveal();
    if (el) break;
    if (Date.now() - start > 3000 && GONE.test(t)) return { state: 'gone' };
    if (Date.now() - start > 10000) return { state: 'nobutton', labels: labels() };
    await sleepP(150);
  }
  const before = text();
  const urlOk = location.href.includes(item.apply_no);
  const nameOk = nameMatches(before, item.name);

  // 2) 번호가 이미 보이면 누르지 않는다. 아니면 눌러서 번호가 보일 때까지(최대 12초) 기다린다.
  if (!phone) {
    if (dry) return { state: 'dry' };
    el.click();
    const t0 = Date.now();
    let confirmed = false, retried = false;
    for (;;) {
      await sleepP(150);
      const t = text();
      phone = pickPhone(t);
      if (phone) break;
      const dlg = dialogs();
      const dtext = dlg.map((e) => e.innerText || '').join(' ');
      if (DEDUCT.test(dtext)) return { state: 'deduct' };
      // 이용권과 상관없는 "연락처를 확인하시겠어요?" 같은 확인 창이면 확인을 한 번 눌러 준다
      if (!confirmed && dlg.length && /연락처|전화번호|휴대폰/.test(dtext)) {
        const ok = dlg.flatMap((d) => [...d.querySelectorAll('button,[role=button],a')]).find((b) => visible(b) && /^(확인|예|열람|보기|계속)$/.test((b.innerText || '').trim()));
        if (ok) { ok.click(); confirmed = true; continue; }
      }
      // 4초 동안 아무 변화가 없으면 한 번 더 누른다
      if (!retried && Date.now() - t0 > 3000 && t === before) { el.click(); retried = true; }
      if (Date.now() - t0 > 12000) return { state: 'nophone', labels: labels() };
    }
  }
  if (!urlOk && !nameOk && !nameMatches(text(), item.name)) return { state: 'mismatch' };
  return { state: 'ok', phone };
}
