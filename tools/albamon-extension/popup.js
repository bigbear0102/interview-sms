const $ = (id) => document.getElementById(id);
function paint(text, level) {
  const el = $('status');
  el.textContent = text;
  el.style.background = level === 'error' ? '#fde8e8' : level === 'warn' ? '#fff4d6' : level === 'ok' ? '#e6f6ea' : '#f2f2f7';
}
async function show() {
  const s = await chrome.storage.local.get(['serverUrl', 'agentToken', 'dry', 'lastStatus', 'lastLevel']);
  $('server').value = s.serverUrl || 'https://interview.bigbears.me';
  $('key').value = s.agentToken || '';
  $('dry').checked = !!s.dry;
  paint(s.lastStatus || '아직 확인 전이에요.', s.lastLevel);
}
$('save').addEventListener('click', async () => {
  $('status').textContent = '저장하고 확인하는 중…';
  try {
    await chrome.runtime.sendMessage({ type: 'popup-save', patch: { serverUrl: $('server').value.trim().replace(/\/+$/, ''), agentToken: $('key').value.trim(), dry: $('dry').checked } });
  } catch { $('status').textContent = '확장 프로그램을 다시 불러온 뒤 다시 눌러 주세요.'; }
});
chrome.storage.onChanged.addListener((c) => { if (c.lastStatus) chrome.storage.local.get('lastLevel').then((l) => paint(c.lastStatus.newValue, l.lastLevel)); });
show();
