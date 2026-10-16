// 소개 페이지(로그인 전 첫 화면): 스크롤로 읽는 장표형 소개 페이지.
// 공개 페이지이므로 실제 이름·번호·수치·내부 구성(서버/폰 종류 등)은 쓰지 않는다. 화면 예시는 모두 가상 데이터다.

const CSS = `
:root{color-scheme:light dark;--bg:#f5f5f7;--surface:#fff;--ink:#1d1d1f;--muted:#6e6e73;--line:#e0e0e0;--blue:#0066cc;--blue-bg:#e8f1fb;
  --green:#1d8a3a;--green-bg:#eaf6ee;--red:#d70015;--red-bg:#fdecee;--amber:#9a5b00;--amber-bg:#fff4dc;--purple:#6b4fbb;--purple-bg:#f0ecfb}
@media (prefers-color-scheme:dark){:root{--bg:#000;--surface:#1c1c1e;--ink:#f5f5f7;--muted:#a1a1a6;--line:#3a3a3c;--blue:#2997ff;--blue-bg:#0c2a45;
  --green:#30d158;--green-bg:#102a18;--red:#ff453a;--red-bg:#3a1618;--amber:#ffb340;--amber-bg:#332508;--purple:#b39dff;--purple-bg:#241d3d}}
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-snap-type:y proximity}
body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.65 "Pretendard Variable",Pretendard,-apple-system,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;letter-spacing:-.01em;-webkit-font-smoothing:antialiased;word-break:keep-all;overflow-wrap:break-word}
.mock .body{overflow-x:auto}.mock th,.mock td{white-space:nowrap}
a{color:var(--blue)}
.top{position:fixed;inset:0 0 auto 0;z-index:10;display:flex;align-items:center;gap:12px;padding:10px max(16px,calc((100vw - 1120px)/2));background:color-mix(in srgb,var(--bg) 82%,transparent);backdrop-filter:blur(14px);border-bottom:1px solid var(--line)}
.top .brand{font-weight:700;margin-right:auto;display:flex;align-items:center;gap:8px;color:var(--ink);text-decoration:none}
.top .dot{width:26px;height:26px;border-radius:8px;background:var(--blue);display:inline-block}
.btn{appearance:none;border:0;border-radius:980px;padding:9px 18px;font:inherit;font-weight:600;cursor:pointer;text-decoration:none;display:inline-block;background:var(--blue);color:#fff}
.btn.ghost{background:transparent;color:var(--blue);border:1px solid var(--blue)}
.slide{min-height:100vh;scroll-snap-align:start;display:flex;align-items:center;padding:88px max(20px,calc((100vw - 1120px)/2)) 56px;border-bottom:1px solid var(--line)}
.slide .in{width:100%}
.kicker{color:var(--blue);font-weight:700;font-size:15px;margin:0 0 8px}
h1{font-size:clamp(34px,6vw,64px);line-height:1.15;margin:0 0 16px;letter-spacing:-.03em}
h2{font-size:clamp(26px,4vw,42px);line-height:1.25;margin:0 0 12px;letter-spacing:-.025em}
.lead{font-size:clamp(18px,2.2vw,24px);color:var(--muted);margin:0 0 28px;max-width:44ch}
.grid{display:grid;gap:20px;align-items:center}
.g2{grid-template-columns:1fr 1fr}.g3{grid-template-columns:repeat(3,1fr)}.g4{grid-template-columns:repeat(4,1fr)}
@media (max-width:820px){.g2,.g3,.g4{grid-template-columns:1fr}.slide{align-items:flex-start}}
.card{background:var(--surface);border:1px solid var(--line);border-radius:18px;padding:22px}
.card h3{margin:0 0 6px;font-size:20px}.card p{margin:0;color:var(--muted)}
.num{font-size:15px;font-weight:700;color:#fff;background:var(--blue);width:30px;height:30px;border-radius:50%;display:inline-grid;place-items:center;margin-bottom:10px}
.list{list-style:none;margin:0;padding:0;display:grid;gap:12px}
.list li{display:flex;gap:12px;align-items:flex-start;font-size:19px}
.list .x{color:var(--red);font-weight:800}.list .o{color:var(--green);font-weight:800}
/* 화면 예시(가상 데이터) */
.mock{background:var(--surface);border:1px solid var(--line);border-radius:18px;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,.08)}
.mock .bar{display:flex;gap:6px;padding:10px 14px;border-bottom:1px solid var(--line);background:var(--bg)}
.mock .bar i{width:10px;height:10px;border-radius:50%;background:var(--line);display:inline-block}
.mock .body{padding:16px}
.mock table{width:100%;border-collapse:collapse;font-size:15px}
.mock th,.mock td{padding:8px 10px;text-align:left;border-bottom:1px solid var(--line)}
.mock td.n,.mock th.n{text-align:right;font-variant-numeric:tabular-nums}
.tag{display:inline-block;border-radius:980px;padding:2px 10px;font-size:13px;font-weight:700}
.tag.y{background:var(--green-bg);color:var(--green)}.tag.n{background:var(--red-bg);color:var(--red)}.tag.q{background:var(--purple-bg);color:var(--purple)}.tag.w{background:var(--amber-bg);color:var(--amber)}
.bubble{max-width:82%;padding:10px 14px;border-radius:18px;margin:8px 0;font-size:15px;white-space:pre-line}
.bubble.out{background:var(--blue);color:#fff;margin-left:auto;border-bottom-right-radius:4px}
.bubble.in{background:var(--bg);border:1px solid var(--line);border-bottom-left-radius:4px}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px}
.stats div{background:var(--bg);border-radius:12px;padding:10px;text-align:center}.stats b{display:block;font-size:24px}.stats span{font-size:13px;color:var(--muted)}
.bar2{display:flex;height:12px;border-radius:99px;overflow:hidden;margin:8px 0}
.flow{display:flex;gap:10px;flex-wrap:wrap;align-items:stretch}
.flow .card{flex:1 1 180px}
.note{font-size:14px;color:var(--muted);margin-top:14px}
.pill{display:inline-block;background:var(--blue-bg);color:var(--blue);border-radius:980px;padding:4px 12px;font-size:14px;font-weight:700;margin:0 6px 6px 0}
.pg{position:fixed;right:16px;bottom:14px;z-index:10;background:var(--surface);border:1px solid var(--line);border-radius:980px;padding:4px 12px;font-size:13px;color:var(--muted)}
.band{display:inline-block;margin:10px 0 8px;padding:4px 14px;border-radius:980px;font-size:14px;font-weight:700;background:var(--blue);color:#fff}
.band.alt{background:var(--purple)}
.wf{display:flex;flex-wrap:wrap;gap:0}
.wf .st{flex:1 1 150px;position:relative;background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:16px 16px 14px;margin:0 22px 14px 0}
.wf .st:last-child{margin-right:0}
.wf .st:not(:last-child)::after{content:"→";position:absolute;right:-20px;top:50%;transform:translateY(-50%);color:var(--muted);font-size:20px}
.wf .st .num{margin-bottom:8px}.wf .st h3{margin:0 0 4px;font-size:18px}.wf .st p{margin:0;color:var(--muted);font-size:15px;line-height:1.5}
.wf.b .st .num{background:var(--purple)}
@media (max-width:820px){.wf .st{flex-basis:100%;margin-right:0}.wf .st:not(:last-child)::after{content:"↓";right:auto;left:50%;top:auto;bottom:-22px;transform:translateX(-50%)}}
.chips{margin:8px 0 2px}.chips .pill{margin:0 6px 6px 0}
.mini{background:var(--bg);border:1px solid var(--line);border-radius:14px;padding:12px 14px;margin:0 0 10px}
.mini b{display:block}.mini small{color:var(--muted);font-size:13px}
@media print{.wf .st{break-inside:avoid}}
@media print{.top,.pg{display:none}.slide{min-height:auto;height:100vh;page-break-after:always;break-after:page;padding:24px}html{scroll-snap-type:none}}
`;

const mockWindow = (inner) => `<div class="mock"><div class="bar"><i></i><i></i><i></i></div><div class="body">${inner}</div></div>`;

const SLIDES = [
  // 1 표지
  `<p class="kicker">문자 관리 시스템 · 지원자 관리</p>
   <h1>지원이 들어오는 순간부터<br>면접 이후까지, 한 흐름으로.</h1>
   <p class="lead">지원자 확인부터 면접 연락, 결과 기록까지. 담당자가 손으로 옮기고 확인하던 일을 시스템이 이어서 챙깁니다.</p>
   <p><span class="pill">지원 자동 수집</span><span class="pill">연락처 자동 확인</span><span class="pill">원가중심점 정리</span><span class="pill">면접 안내 문자</span><span class="pill">답장·결과 자동 집계</span></p>`,

  // 2 전체 흐름
  `<p class="kicker">전체 흐름</p>
   <h2>지원부터 결과까지, 한 줄로 이어져요.</h2>
   <span class="band">지원자 관리</span>
   <div class="wf">
     <div class="st"><span class="num">1</span><h3>지원 접수</h3><p>채용 사이트의 지원 알림이 자동으로 모여요.</p></div>
     <div class="st"><span class="num">2</span><h3>연락처 확인</h3><p>이력서에서 연락처를 자동으로 읽어 와요.</p></div>
     <div class="st"><span class="num">3</span><h3>분류</h3><p>어느 사업장 지원인지 한 번에 정해요.</p></div>
     <div class="st"><span class="num">4</span><h3>등록</h3><p>지원자 목록에 넣고, 같은 사람·블랙리스트를 바로 확인해요.</p></div>
   </div>
   <span class="band alt">문자 · 면접 안내</span>
   <div class="wf b">
     <div class="st"><span class="num">5</span><h3>면접 안내</h3><p>문자를 한 번에 보내요. 예약도 돼요.</p></div>
     <div class="st"><span class="num">6</span><h3>답장·리마인드</h3><p>참석/불참을 자동으로 모으고, 당일 아침 다시 알려 줘요.</p></div>
     <div class="st"><span class="num">7</span><h3>결과·이력</h3><p>출석·노쇼·합격·입사를 기록해 이력으로 남겨요.</p></div>
   </div>
   <p class="note">면접 결과(노쇼)는 다시 지원자 관리로 돌아와, 반복되는 지원자를 블랙리스트 후보로 알려 줘요. 등록은 사람이 확인하고 해요.</p>`,

  // 3 지금은(지원 접수)
  `<p class="kicker">지금은 이렇게 해요 · 지원 접수</p>
   <h2>지원 한 건을 옮기는 데도 손이 많이 가요.</h2>
   <div class="grid g2">
     <ul class="list">
       <li><span class="x">✕</span><span>지원 알림 메일을 <b>하나씩 열어</b> 이름과 공고를 확인</span></li>
       <li><span class="x">✕</span><span>연락처는 메일에 없어서 <b>이력서를 따로 열어야</b> 보임</span></li>
       <li><span class="x">✕</span><span>어느 사업장 지원인지 <b>사람마다 직접 구분</b>해서 엑셀에 기록</span></li>
       <li><span class="x">✕</span><span>같은 사람이 또 지원했는지, <b>블랙리스트인지</b> 찾기 어려움</span></li>
       <li><span class="x">✕</span><span>담당자마다 메일함·엑셀이 달라서 <b>기록이 흩어짐</b></span></li>
     </ul>
     <div class="card"><h3>담당자 입장에서는</h3><p>면접 연락을 하기 전에 <b>"누가 지원했는지 정리하는 일"</b>부터 시간을 많이 씁니다. 지원이 많은 날은 더 그렇습니다.</p></div>
   </div>`,

  // 4 1 지원 접수
  `<div class="grid g2"><div>
     <p class="kicker">1. 지원 접수</p><h2>지원 알림이 알아서 모여요.</h2>
     <ul class="list"><li><span class="o">✓</span><span>채용 사이트의 알림 메일을 자동으로 읽어 <b>이름·공고·경력</b>을 정리</span></li>
       <li><span class="o">✓</span><span>같은 지원은 <b>한 번만</b> 들어와요(중복 제외)</span></li>
       <li><span class="o">✓</span><span>가져올 양을 <b>전부 / 최근 N통</b>으로 정할 수 있어요</span></li>
       <li><span class="o">✓</span><span>담당자마다 <b>자기 지원만</b> 보여요</span></li></ul></div>
     ${mockWindow(`<div class="stats"><div><b>12</b><span>대기 중</span></div><div><b>4</b><span>연락처 필요</span></div><div><b>7</b><span>분류 필요</span></div><div><b>5</b><span>등록 가능</span></div></div>
       <table><thead><tr><th>지원자</th><th>공고</th><th>연락처</th><th>분류</th></tr></thead><tbody>
       <tr><td>홍길동</td><td>현장 직원 모집</td><td><span class="tag y">있음</span></td><td><span class="tag w">필요</span></td></tr>
       <tr><td>김영희</td><td>물류 상하차</td><td><span class="tag w">가져오는 중</span></td><td><span class="tag y">완료</span></td></tr>
       <tr><td>이철수</td><td>현장 직원 모집</td><td><span class="tag y">있음</span></td><td><span class="tag w">필요</span></td></tr></tbody></table>
       <p class="note">※ 화면 예시는 가상 데이터입니다.</p>`)}</div>`,

  // 5 2~3 연락처·분류
  `<div class="grid g2">${mockWindow(`<div class="mini"><b>[A사] 현장 직원 모집 (단기)</b><small>이 공고로 지원한 대기 12명</small>
         <div class="chips"><span class="pill">A사(현장HR)</span><span class="pill">A사(파견)</span></div>
         <small>제안 버튼을 누르면 같은 공고 12명에게 한 번에 적용돼요</small></div>
       <div class="mini"><b>적용 완료</b><small>12명 분류 · 연락처 가져오기를 이어서 요청했어요</small>
         <div class="chips"><span class="tag y">A사(현장HR) · 주차관리</span></div></div>`)}
     <div><p class="kicker">2~3. 연락처 확인 · 분류</p><h2>연락처는 자동으로, 분류는 제안으로.</h2>
     <ul class="list"><li><span class="o">✓</span><span>공고 제목을 보고 <b>비슷한 사업장을 제안</b>해요. 버튼 한 번이면 같은 공고 전체에 적용</span></li>
       <li><span class="o">✓</span><span>분류가 끝나면 <b>연락처 확인도 자동으로 이어져요</b>(담당자 PC에서)</span></li>
       <li><span class="o">✓</span><span>한 번 정한 공고는 앞으로 같은 공고도 <b>자동으로 분류</b></span></li>
       <li><span class="o">✓</span><span>확인하지 못한 건은 <b>이유</b>를 함께 보여 줘요</span></li></ul></div></div>`,

  // 6 4 등록
  `<div class="grid g2"><div>
     <p class="kicker">4. 등록</p><h2>등록하고, 바로 확인해요.</h2>
     <ul class="list"><li><span class="o">✓</span><span>연락처가 확인된 지원자는 <b>버튼 한 번</b>으로 등록</span></li>
       <li><span class="o">✓</span><span>같은 번호는 <b>한 사람으로</b> 묶여요(중복 방지)</span></li>
       <li><span class="o">✓</span><span>번호를 입력하면 <b>블랙리스트인지 바로</b> 알려 줘요</span></li>
       <li><span class="o">✓</span><span>사유와 변경 기록이 남고, 해제는 <b>사람이 직접</b>(자동 만료 없음)</span></li>
       <li><span class="o">✓</span><span>엑셀로 <b>한꺼번에 올리고 내려받기</b>도 돼요</span></li></ul></div>
     ${mockWindow(`<table><thead><tr><th>이름</th><th>원가중심점 · 직무</th><th>상태</th></tr></thead><tbody>
       <tr><td>홍길동<br><small>010-1234-5678</small></td><td>A사(현장HR)<br><small>주차관리</small></td><td><span class="tag y">일반</span></td></tr>
       <tr><td>김영희<br><small>010-2345-6789</small></td><td>B사(물류)<br><small>상하차</small></td><td><span class="tag y">일반</span></td></tr>
       <tr><td>이철수<br><small>010-3456-7890</small></td><td>A사(현장HR)<br><small>생산</small></td><td><span class="tag n">블랙리스트</span></td></tr></tbody></table>
       <p class="note">※ 화면 예시는 가상 데이터입니다.</p>`)}</div>`,

  // 7 지금은(면접 연락)
    `<p class="kicker">지금은 이렇게 해요 · 면접 연락</p>
   <h2>면접 한 건에 연락이 여러 번 필요해요.</h2>
   <div class="grid g2">
     <ul class="list">
       <li><span class="x">✕</span><span>면접 전에 한 사람씩 <b>미리 연락</b>해서 일정 안내</span></li>
       <li><span class="x">✕</span><span>"오실 수 있나요?" <b>참석 여부를 전화·메시지로 확인</b></span></li>
       <li><span class="x">✕</span><span>면접 당일 <b>다시 연락(리마인드)</b></span></li>
       <li><span class="x">✕</span><span>답을 <b>엑셀에 직접 옮겨 적고</b> 사업장별로 취합</span></li>
       <li><span class="x">✕</span><span>누가 연락했는지, 누가 안 왔는지 <b>기록이 흩어짐</b></span></li>
     </ul>
     <div class="card"><h3>담당자 입장에서는</h3><p>면접 자체보다 <b>연락하고 확인하는 일</b>에 시간이 더 들고, 빠뜨리면 노쇼로 이어집니다. 이 부분을 줄이는 것이 이 시스템의 목적입니다.</p></div>
   </div>`,

  // 8 면접 연락 4단계
    `<p class="kicker">면접 연락은 이렇게 바뀝니다</p>
   <h2>네 단계면 충분해요.</h2>
   <div class="flow">
     <div class="card"><span class="num">1</span><h3>명단 올리기</h3><p>엑셀(CSV)을 올리거나, 한 명만 직접 입력해요.</p></div>
     <div class="card"><span class="num">2</span><h3>한 번에 보내기</h3><p>지금 보내거나 원하는 시간에 예약해요.</p></div>
     <div class="card"><span class="num">3</span><h3>답장 자동 정리</h3><p>"참석/불참"을 알아서 분류해서 사업장별로 모아요.</p></div>
     <div class="card"><span class="num">4</span><h3>당일 아침 자동 안내</h3><p>참석하겠다는 분께 면접 당일 아침 8시에 다시 알려 줘요.</p></div>
   </div>
   <p class="note">사람이 하던 "연락 → 확인 → 재연락 → 취합"을 시스템이 이어서 처리합니다.</p>`,

  // 9 명단 올리기
    `<div class="grid g2"><div>
     <p class="kicker">1. 명단 올리기</p><h2>엑셀 그대로 올리면 돼요.</h2>
     <ul class="list"><li><span class="o">✓</span><span>사업장·이름·전화번호·면접일시만 있으면 끝</span></li>
       <li><span class="o">✓</span><span>번호 오류·중복은 <b>올리는 즉시 걸러서</b> 알려 줘요</span></li>
       <li><span class="o">✓</span><span>한 명에게만 보낼 때는 입력칸 4개면 충분</span></li></ul></div>
     ${mockWindow(`<table><thead><tr><th>사업장</th><th>이름</th><th>전화번호</th><th>면접일시</th></tr></thead><tbody>
       <tr><td>아마노코리아(현장HR)</td><td>홍길동</td><td>010-1234-5678</td><td>10/20 14:00</td></tr>
       <tr><td>아마노코리아(현장HR)</td><td>김영희</td><td>010-2345-6789</td><td>10/20 14:30</td></tr>
       <tr><td>아마노코리아(현장HR)</td><td>이철수</td><td>010-3456-7890</td><td>10/21 10:00</td></tr></tbody></table>
       <p class="note">※ 화면 예시는 가상 데이터입니다.</p>`)}
   </div>`,

  // 10 보내기
    `<div class="grid g2">${mockWindow(`<div class="bubble out">안녕하세요, 홍길동님.\n면접 일정을 안내드립니다.\n\n일시: 10/20 14:00\n\n참석 가능하시면 "참석", 어려우시면 "불참"이라고 답장해 주세요.</div>
       <div class="bubble in">참석합니다</div>`)}
     <div><p class="kicker">2. 한 번에 보내기</p><h2>문구는 자동으로 채워져요.</h2>
     <ul class="list"><li><span class="o">✓</span><span>{이름}, {면접일시}가 <b>사람마다 알맞게</b> 들어가요</span></li>
       <li><span class="o">✓</span><span>보내기 전에 <b>미리보기</b>로 확인</span></li>
       <li><span class="o">✓</span><span><b>예약 발송</b>: 올려만 두면 정해진 시간에 나가요</span></li>
       <li><span class="o">✓</span><span>실패하면 <b>자동으로 다시 시도</b></span></li></ul></div></div>`,

  // 11 답장 자동 정리
    `<div class="grid g2"><div><p class="kicker">3. 답장 자동 정리</p><h2>"참석/불참"을 알아서 분류해요.</h2>
     <ul class="list"><li><span class="o">✓</span><span>"네 갈게요", "어렵습니다" 같은 <b>자연스러운 답</b>도 이해해요</span></li>
       <li><span class="o">✓</span><span>애매한 답·질문은 <b>"확인 필요"</b>로 따로 모아 담당자가 판단</span></li>
       <li><span class="o">✓</span><span>직접 고쳐야 하면 버튼 한 번으로 정정</span></li></ul></div>
     ${mockWindow(`<table><tbody>
       <tr><td>홍길동</td><td>"참석합니다"</td><td><span class="tag y">참석</span></td></tr>
       <tr><td>김영희</td><td>"다른 일정이 있어서 어렵습니다"</td><td><span class="tag n">불참</span></td></tr>
       <tr><td>이철수</td><td>"주차 가능한가요?"</td><td><span class="tag q">확인 필요</span></td></tr>
       <tr><td>박민수</td><td>(답 없음)</td><td><span class="tag w">미회신</span></td></tr></tbody></table>`)}</div>`,

  // 12 한눈에 보기
    `<p class="kicker">한눈에 보기</p><h2>사업장·날짜별로 모여요.</h2>
   <div class="grid g2"><ul class="list">
       <li><span class="o">✓</span><span>어느 사업장에 <b>며칠에 몇 명</b> 보냈는지</span></li>
       <li><span class="o">✓</span><span><b>참석 / 불참 / 확인 필요 / 미회신</b>이 몇 명인지</span></li>
       <li><span class="o">✓</span><span>엑셀로 내려받아 <b>바로 보고용</b>으로 사용</span></li></ul>
     ${mockWindow(`<div class="stats"><div><b>42</b><span>보냄</span></div><div><b>27</b><span>참석</span></div><div><b>6</b><span>불참</span></div><div><b>9</b><span>미회신</span></div></div>
       <table><thead><tr><th>보낸 날</th><th>사업장</th><th class="n">보냄</th><th class="n">참석</th><th class="n">불참</th><th class="n">미회신</th></tr></thead><tbody>
       <tr><td>10/15</td><td>아마노코리아(현장HR)</td><td class="n">20</td><td class="n">14</td><td class="n">2</td><td class="n">4</td></tr>
       <tr><td>10/16</td><td>아마노코리아(현장HR)</td><td class="n">22</td><td class="n">13</td><td class="n">4</td><td class="n">5</td></tr></tbody></table>
       <p class="note">※ 가상 데이터</p>`)}</div>`,

  // 13 자동 리마인드
    `<p class="kicker">4. 자동 리마인드</p><h2>"다시 알려 주기"는 시스템이 해요.</h2>
   <div class="flow">
     <div class="card"><h3>면접 안내 발송</h3><p>참석 여부를 답장으로 받아요.</p></div>
     <div class="card"><h3>"참석"이라고 답한 분</h3><p>이 분들만 대상이에요. 불참·미회신은 제외.</p></div>
     <div class="card"><h3>면접 당일 오전 8시 자동 발송</h3><p>참석 답장을 한 분께 <b>한 번만</b> 보내요.</p></div>
     <div class="card"><h3>불참 답장이 오면</h3><p>자동 집계에 바로 반영돼요.</p></div>
   </div>
   <p class="note">담당자가 일정을 보며 하나씩 연락하던 "당일 확인 전화"를 대체하는 것이 목표입니다. 켜고 끄는 것은 면접 안내마다 선택할 수 있어요.</p>`,

  // 14 결과·이력
    `<div class="grid g2"><div><p class="kicker">결과 기록과 이력</p><h2>면접 이후까지 이어서 기록해요.</h2>
     <ul class="list"><li><span class="o">✓</span><span><b>출석 · 노쇼 · 합격 · 입사</b>를 사람별로 선택해 기록</span></li>
       <li><span class="o">✓</span><span>같은 사람의 <b>이전 면접 이력</b>이 이어져서 보여요</span></li>
       <li><span class="o">✓</span><span>노쇼가 반복되는 지원자는 <b>한눈에 표시</b></span></li>
       <li><span class="o">✓</span><span>연결을 켜면 면접 명단이 <b>지원자로 자동 등록</b>되고, 노쇼가 쌓인 사람은 <b>블랙리스트 후보로 제안</b>(등록은 사람이 확인)</span></li></ul></div>
     ${mockWindow(`<table><thead><tr><th>이름</th><th class="n">안내</th><th class="n">출석</th><th class="n">노쇼</th><th></th></tr></thead><tbody>
       <tr><td>홍길동</td><td class="n">3</td><td class="n">1</td><td class="n">2</td><td><span class="tag n">노쇼 반복</span></td></tr>
       <tr><td>김영희</td><td class="n">2</td><td class="n">2</td><td class="n">0</td><td></td></tr></tbody></table>
       <p class="note">※ 개인정보 보관 기간이 지난 기록은 자동으로 지워져요.</p>`)}</div>`,

  // 15 회사 시스템 장점
    `<p class="kicker">회사 시스템으로서의 장점</p><h2>우리 회사 방식에 맞게, 우리가 관리해요.</h2>
   <div class="grid g4">
     <div class="card"><h3>부서별 권한</h3><p>가입할 때 고른 부서의 자료만 볼 수 있어요. 전체 관리자만 모든 부서를 봐요.</p></div>
     <div class="card"><h3>사내 직원만 가입</h3><p>회사 이메일로만 가입할 수 있고, 이메일 인증을 거쳐요. 관리자가 승인·중지·삭제할 수 있어요.</p></div>
     <div class="card"><h3>개인정보 자동 파기</h3><p>정해 둔 보관 기간(기본 90일)이 지나면 이름과 전화번호가 자동으로 지워져요.</p></div>
     <div class="card"><h3>기록이 남아요</h3><p>누가 언제 무엇을 했는지 기록하고, 엑셀 내보내기도 남겨요.</p></div>
     <div class="card"><h3>계정 정보 안전</h3><p>메일 계정의 비밀번호는 <b>시스템 서버에 저장하지 않고</b>, 담당자 본인의 PC에만 둬요.</p></div>
     <div class="card"><h3>우리 업무에 맞춤</h3><p>사업장 단위 집계, 원가중심점 정리, 문구, 리마인드를 회사 업무 방식에 맞춰 바꿀 수 있어요.</p></div>
     <div class="card"><h3>회사 번호로 발송</h3><p>담당자 개인 번호가 아니라 <b>지정한 회사 폰</b>으로 발송해서, 답장도 한곳에 모여요.</p></div>
   </div>`,

  // 16 편리함·안정성
    `<p class="kicker">편리함과 안정성</p><h2>처음 써도 헷갈리지 않고, 멈추면 알려 줘요.</h2>
   <div class="grid g2">
     <div class="card"><h3>쉬운 화면</h3><ul class="list" style="gap:8px">
       <li><span class="o">✓</span><span>단계별 안내, 쉬운 말 문구</span></li>
       <li><span class="o">✓</span><span>PC·모바일 모두 사용 가능</span></li>
       <li><span class="o">✓</span><span>보내기 전 미리보기·확인 창</span></li></ul></div>
     <div class="card"><h3>믿고 맡길 수 있게</h3><ul class="list" style="gap:8px">
       <li><span class="o">✓</span><span>발송 폰 상태를 계속 점검, 이상하면 <b>관리자에게 메일</b></span></li>
       <li><span class="o">✓</span><span>실패한 문자는 자동 재시도</span></li>
       <li><span class="o">✓</span><span>데이터 백업·복구 절차 마련</span></li></ul></div>
   </div>`,

  // 17 도입 계획
    `<p class="kicker">도입 계획</p><h2>작게 시작해서, 숫자로 확인해요.</h2>
   <div class="flow">
     <div class="card"><span class="num">1</span><h3>시범 운영</h3><p>한 부서·한 사업장에서 실제 면접 안내에 적용해요.</p></div>
     <div class="card"><span class="num">2</span><h3>효과 측정</h3><p>담당자의 <b>지원 확인·연락처 확보·연락·재연락 건수와 소요 시간</b>, 노쇼율을 전·후로 비교해요.</p></div>
     <div class="card"><span class="num">3</span><h3>보완</h3><p>현업 의견을 받아 문구, 화면, 리마인드 시점을 다듬어요.</p></div>
     <div class="card"><span class="num">4</span><h3>확대</h3><p>효과가 확인되면 다른 부서·사업장으로 넓혀요.</p></div>
   </div>
   <p class="note">※ 효과 수치는 시범 운영 후 측정해서 보고드립니다. 현재 화면 예시는 모두 가상 데이터입니다.</p>`
];

export function renderLanding({ loggedIn = false } = {}) {
  const total = SLIDES.length;
  const cta = loggedIn
    ? '<a class="btn" href="/">대시보드로 가기</a>'
    : '<a class="btn" href="/login">로그인</a>';
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>문자 관리 시스템</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%230066cc'/%3E%3Cg transform='translate(6 6) scale(.833)' fill='none' stroke='white' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M22 2L11 13'/%3E%3Cpath d='M22 2l-7 20-4-9-9-4z'/%3E%3C/g%3E%3C/svg%3E"><link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css">
<style>${CSS}</style></head><body>
<header class="top"><a class="brand" href="#s1"><svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7" fill="#0066cc"/><g transform="translate(6 6) scale(.833)" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4z"/></g></svg>문자 관리</a>
  ${cta}</header>
<main>
${SLIDES.map((s, i) => `<section class="slide" id="s${i + 1}" aria-label="${i + 1}/${total}"><div class="in">${s}</div></section>`).join('\n')}
</main>
<div class="pg" id="pg" aria-live="polite">1 / ${total}</div>
<script>
(function () {
  var slides = Array.prototype.slice.call(document.querySelectorAll('.slide'));
  var pg = document.getElementById('pg');
  var io = new IntersectionObserver(function (es) {
    es.forEach(function (e) { if (e.isIntersecting) pg.textContent = (slides.indexOf(e.target) + 1) + ' / ' + slides.length; });
  }, { threshold: 0.55 });
  slides.forEach(function (s) { io.observe(s); });
})();
</script></body></html>`;
}

