(function initPopup() {
  "use strict";
  const status = document.getElementById('status');
  const connection = document.getElementById('connection');
  let settings = { visible: true, scale: 1, animationEnabled: true, position: null };

  async function send(message) {
    try { return await chrome.runtime.sendMessage(message); }
    catch (error) { return { ok: false, error: String(error && error.message || error) }; }
  }

  function say(text) { status.textContent = text; }

  function sendToCurrentTab(message) {
    return new Promise((resolve) => {
      if (!chrome.tabs || !chrome.tabs.query) {
        resolve({ ok: false, error: 'tabs-api-unavailable' });
        return;
      }
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs && tabs[0];
        if (!tab || tab.id === undefined) {
          resolve({ ok: false, error: 'no-active-tab' });
          return;
        }
        chrome.tabs.sendMessage(tab.id, message, (response) => {
          const error = chrome.runtime.lastError;
          resolve(error ? { ok: false, error: error.message } : (response || { ok: false }));
        });
      });
    });
  }

  async function checkConnection() {
    const response = await sendToCurrentTab({ type: 'GPT_BUDDY_PING' });
    if (response && response.ok) {
      connection.className = 'connected';
      connection.textContent = `已连接当前页面 · v${response.version || ''}`;
    } else {
      connection.className = 'disconnected';
      connection.textContent = '未连接当前页面：请允许站点访问并刷新 ChatGPT。';
    }
  }

  async function patch(next, message) {
    const response = await send({ type: 'UPDATE_SETTINGS', patch: next });
    if (response && response.ok) {
      settings = response.settings;
      say(message);
    } else say('设置保存失败，请稍后重试。');
  }

  document.getElementById('show').addEventListener('click', async () => {
    await patch({ visible: true }, '显示设置已保存。');
    const response = await sendToCurrentTab({ type: 'GPT_BUDDY_SHOW' });
    say(response && response.ok ? '挂件已恢复。' : '请刷新 ChatGPT 页面以载入挂件。');
    checkConnection();
  });
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
  checkConnection();
})();
