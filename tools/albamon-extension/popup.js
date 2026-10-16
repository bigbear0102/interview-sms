const $ = (id) => document.getElementById(id);
async function show() {
  const s = await chrome.storage.local.get(['serverUrl', 'agentToken', 'dry', 'lastStatus', 'gwId', 'gwPw', 'gwOn']);
  $('server').value = s.serverUrl || 'https://interview.bigbears.me';
  $('key').value = s.agentToken || '';
  $('dry').checked = !!s.dry;
  $('gwid').value = s.gwId || '';
  $('gwpw').value = s.gwPw || '';
  $('gwon').checked = s.gwOn !== false && !!s.gwId;
  $('status').textContent = s.lastStatus || '아직 확인 전이에요.';
}
$('save').addEventListener('click', async () => {
  await chrome.storage.local.set({ serverUrl: $('server').value.trim().replace(/\/+$/, ''), agentToken: $('key').value.trim(), dry: $('dry').checked, gwId: $('gwid').value.trim(), gwPw: $('gwpw').value, gwOn: $('gwon').checked });
  $('status').textContent = '확인하는 중…';
  await chrome.storage.local.set({ lastStatus: '확인하는 중…' });
  try { await chrome.runtime.sendMessage({ type: 'run' }); } catch { $('status').textContent = '확장 프로그램을 다시 불러온 뒤 다시 눌러 주세요.'; }
});
chrome.storage.onChanged.addListener((c) => { if (c.lastStatus) $('status').textContent = c.lastStatus.newValue; });
show();
