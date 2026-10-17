// 문자 관리 시스템 화면과 이 확장을 이어 주는 작은 스크립트.
//  - 화면이 만든 연결 키를 이 PC 크롬의 확장에만 저장하고, 확장 상태(버전·연결 키 있음·최근 결과)를 화면에 알려 준다.
//  - 화면에서 "연락처 가져오기"를 누르면 확장을 바로 깨운다(30초 알람을 기다리지 않게).
const reply = (type, state) => window.postMessage({ source: 'albamon-ext', type, state }, window.location.origin);
const getState = () => chrome.runtime.sendMessage({ type: 'bridge-state' });

window.addEventListener('message', async (e) => {
  const d = e.data;
  if (e.source !== window || !d || d.source !== 'interview-page') return;
  try {
    if (d.type === 'hello') reply('ready', await getState());
    if (d.type === 'kick') chrome.runtime.sendMessage({ type: 'kick' });
    if (d.type === 'save' && typeof d.agentToken === 'string' && /^ag_[0-9a-f]{48}$/.test(d.agentToken)) {
      reply('saved', await chrome.runtime.sendMessage({ type: 'bridge-save', patch: { agentToken: d.agentToken } }));
    }
  } catch { /* 확장이 다시 로드되는 중이면 무시 */ }
});
getState().then((s) => reply('ready', s)).catch(() => {});
