const $ = (id) => document.getElementById(id);
async function show() {
  const s = await chrome.storage.local.get(['serverUrl', 'agentToken', 'dry', 'lastStatus']);
  $('server').value = s.serverUrl || 'https://interview.bigbears.me';
  $('key').value = s.agentToken || '';
  $('dry').checked = !!s.dry;
  $('status').textContent = s.lastStatus || '아직 확인 전이에요.';
}
$('save').addEventListener('click', async () => {
  await chrome.storage.local.set({ serverUrl: $('server').value.trim().replace(/\/+$/, ''), agentToken: $('key').value.trim(), dry: $('dry').checked });
  $('status').textContent = '확인하는 중…';
  chrome.runtime.sendMessage({ type: 'run' });
});
chrome.storage.onChanged.addListener((c) => { if (c.lastStatus) $('status').textContent = c.lastStatus.newValue; });
show();
