// 문자 관리 시스템 화면(수신함)과 이 확장을 이어 주는 작은 스크립트.
//  - 화면의 "내 확장에 저장"으로 받은 그룹웨어 아이디·비밀번호·연결 키를 이 PC 크롬의 확장에만 저장한다. (서버로 보내지 않는다)
//  - 화면에는 저장 여부만 알려 주고, 비밀번호는 돌려주지 않는다.
const reply = (type, state) => window.postMessage({ source: 'albamon-ext', type, state }, window.location.origin);
const getState = () => chrome.runtime.sendMessage({ type: 'bridge-state' });

window.addEventListener('message', async (e) => {
  const d = e.data;
  if (e.source !== window || !d || d.source !== 'interview-page') return;
  try {
    if (d.type === 'hello') reply('ready', await getState());
    if (d.type === 'save') {
      const patch = {};
      if (typeof d.agentToken === 'string' && /^ag_[0-9a-f]{48}$/.test(d.agentToken)) patch.agentToken = d.agentToken;
      if (typeof d.gwId === 'string') patch.gwId = d.gwId.slice(0, 60);
      if (typeof d.gwPw === 'string' && d.gwPw) patch.gwPw = d.gwPw.slice(0, 100);
      if (typeof d.gwOn === 'boolean') patch.gwOn = d.gwOn;
      if (d.account && typeof d.account.id === 'string') patch.account = { id: d.account.id.slice(0, 80), pw: typeof d.account.pw === 'string' ? d.account.pw.slice(0, 100) : '' };
      if (typeof d.removeAccount === 'string') patch.removeAccount = d.removeAccount.slice(0, 80);
      if (d.toggleAccount && typeof d.toggleAccount.id === 'string') patch.toggleAccount = { id: d.toggleAccount.id.slice(0, 80), on: !!d.toggleAccount.on };
      reply('saved', await chrome.runtime.sendMessage({ type: 'bridge-save', patch }));
    }
  } catch { /* 확장이 다시 로드되는 중이면 무시 */ }
});
getState().then((s) => reply('ready', s)).catch(() => {});
