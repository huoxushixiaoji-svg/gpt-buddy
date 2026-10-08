(function initPopup() {
  "use strict";
  const status = document.getElementById('status');
  let settings = { visible: true, scale: 1, animationEnabled: true, position: null };

  async function send(message) {
    try { return await chrome.runtime.sendMessage(message); }
    catch (error) { return { ok: false, error: String(error && error.message || error) }; }
  }

  function say(text) { status.textContent = text; }

  async function patch(next, message) {
    const response = await send({ type: 'UPDATE_SETTINGS', patch: next });
    if (response && response.ok) {
      settings = response.settings;
      say(message);
    } else say('设置保存失败，请稍后重试。');
  }

  document.getElementById('show').addEventListener('click', () => patch({ visible: true }, '挂件已恢复。'));
  document.getElementById('animation').addEventListener('click', () => patch({ animationEnabled: settings.animationEnabled === false }, '动画设置已更新。'));
  document.getElementById('smaller').addEventListener('click', () => patch({ scale: Math.max(0.7, Math.round((Number(settings.scale) - 0.1) * 10) / 10) }, '挂件已缩小。'));
  document.getElementById('larger').addEventListener('click', () => patch({ scale: Math.min(1.35, Math.round((Number(settings.scale) + 0.1) * 10) / 10) }, '挂件已放大。'));
  document.getElementById('clear').addEventListener('click', async () => {
    const response = await send({ type: 'CLEAR_SNAPSHOTS' });
    say(response && response.ok ? '本地用量快照已清除。' : '清除失败，请稍后重试。');
  });

  send({ type: 'GET_STATE', contextKey: '' }).then((response) => {
    if (response && response.ok) settings = response.settings;
  });
})();
