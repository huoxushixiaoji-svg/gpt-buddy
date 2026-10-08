(function initPopup() {
  "use strict";
  const status = document.getElementById('status');
  const connection = document.getElementById('connection');
  const backgroundButton = document.getElementById('background');
  const backgroundStatus = document.getElementById('reader-status');
  const refreshButton = document.getElementById('refresh-background');
  let backgroundUsage = { status: 'off', items: [] };
  let settings = { visible: true, scale: 1, animationEnabled: true, position: null };

  async function send(message) {
    try { return await chrome.runtime.sendMessage(message); }
    catch (error) { return { ok: false, error: String(error && error.message || error) }; }
  }

  function say(text) { status.textContent = text; }

  function renderBackground() {
    const enabled = Boolean(settings.backgroundRefreshEnabled);
    backgroundButton.textContent = enabled ? '关闭后台更新' : '开启后台更新';
    backgroundButton.setAttribute('aria-pressed', String(enabled));
    refreshButton.hidden = !enabled;
    const labels = {
      off: '后台更新已关闭', loading: '正在读取用量页面…', ok: '已读取，每分钟尝试更新',
      'waiting-active': '你正在查看用量页，暂不刷新它', unrecognized: '未识别额度，请检查后台页是否已加载',
      'page-unavailable': '后台页不可用，请检查登录和页面状态', 'tab-closed': '后台页已关闭，更新已停止'
    };
    backgroundStatus.textContent = labels[backgroundUsage.status] || '等待下次更新';
  }

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
      renderBackground();
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
    say(response && response.ok ? '快照已清除，后台更新已停止。' : '清除失败，请稍后重试。');
  });

  backgroundButton.addEventListener('click', async () => {
    backgroundButton.disabled = true;
    await patch({ backgroundRefreshEnabled: !settings.backgroundRefreshEnabled }, '后台更新设置已保存。');
    backgroundButton.disabled = false;
  });
  refreshButton.addEventListener('click', async () => {
    const response = await send({ type: 'REFRESH_BACKGROUND' });
    say(response.ok ? '已请求读取，请查看更新状态。' : '未能发起读取，请稍后重试。');
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.settings) settings = changes.settings.newValue || {};
    if (changes.backgroundUsage) backgroundUsage = changes.backgroundUsage.newValue || { status: 'off' };
    renderBackground();
  });

  send({ type: 'GET_STATE', contextKey: '' }).then((response) => {
    if (response && response.ok) {
      settings = response.settings;
      backgroundUsage = response.backgroundUsage || backgroundUsage;
      renderBackground();
    }
  });
  checkConnection();
})();
