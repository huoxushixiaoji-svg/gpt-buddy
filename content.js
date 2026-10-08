(async function startGPTBuddy(global) {
  "use strict";

  if (global.__GPT_BUDDY_CONTROLLER__) return;
  const NS = global.GPTBuddy;
  if (!NS || !NS.parser || !NS.state || !NS.widget) return;

  const contextKey = `unverified:${crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`}`;
  let destroyed = false;
  let scanTimer = null;
  let lastUrl = global.location.href;
  let observer = null;
  let widget = null;

  const FALLBACK_STYLES = `
    :host{all:initial;position:fixed;z-index:2147483000;width:360px;height:342px;pointer-events:none;font-family:system-ui,sans-serif}
    .buddy-frame{position:relative;width:360px;height:342px;pointer-events:none}.buddy-visual{position:absolute;inset:0;width:360px;height:342px;transform-origin:65% 100%;pointer-events:none}.buddy-character{position:absolute;inset:0;width:360px;height:342px;object-fit:contain}
    .buddy-bubble{position:absolute;left:18px;top:27px;width:185px;height:104px;display:grid;place-items:center;padding:8px 14px;color:#211d25;pointer-events:auto;overflow:hidden}
    .buddy-message{margin:0;font-size:13px;font-weight:700;line-height:1.4}.buddy-details{font-size:9px;max-height:90px;overflow:auto}.buddy-details[hidden],.buddy-message[hidden],.buddy-menu[hidden]{display:none!important}
    .character-hit{position:absolute;right:10px;bottom:0;width:235px;height:235px;border:0;background:transparent;pointer-events:auto}.menu-trigger{position:absolute;right:8px;top:114px;pointer-events:auto}
    .buddy-menu{position:absolute;right:8px;top:145px;width:170px;padding:7px;background:#fff;color:#222;border:1px solid #888;border-radius:10px;pointer-events:auto}.buddy-menu button{display:block;width:100%;min-height:32px}
    .animations-on.is-squashing .buddy-visual{animation:buddy-squash .5s ease}@keyframes buddy-squash{0%,100%{transform:none}35%{transform:translateY(36px) scale(1.1,.72)}65%{transform:translateY(-5px) scale(.97,1.05)}}
  `;

  async function send(message) {
    try { return await chrome.runtime.sendMessage(message); }
    catch (error) { return { ok: false, error: String(error && error.message || error) }; }
  }

  const [styles, initial] = await Promise.all([
    fetch(chrome.runtime.getURL('styles.css'))
      .then((response) => response.ok ? response.text() : Promise.reject(new Error(`styles ${response.status}`)))
      .catch((error) => {
        console.warn('[GPT 小伙伴] 样式资源加载失败，已启用备用样式。', error);
        return FALLBACK_STYLES;
      }),
    send({ type: 'GET_STATE', contextKey })
  ]);
  if (destroyed) return;

  function updateSettings(patch) {
    send({ type: 'UPDATE_SETTINGS', patch });
  }

  function clearSnapshots() {
    send({ type: 'CLEAR_SNAPSHOTS' }).then(() => widget && widget.setItems([]));
  }

  function scan() {
    if (destroyed || !widget) return;
    const items = NS.parser.scanVisibleUsage(document, { now: Date.now() });
    widget.setItems(items);
    if (items.length) send({ type: 'UPSERT_SNAPSHOTS', contextKey, items });
  }

  function scheduleScan(delay) {
    global.clearTimeout(scanTimer);
    scanTimer = global.setTimeout(scan, Number(delay) || 250);
  }

  widget = NS.widget.createWidget({
    styles,
    imageUrl: chrome.runtime.getURL('assets/character-web.png'),
    settings: initial && initial.settings,
    onRescan: scan,
    onSettingsChange: updateSettings,
    onClear: clearSnapshots
  });

  function handleRouteMaybeChanged() {
    if (global.location.href === lastUrl) return;
    lastUrl = global.location.href;
    widget.setItems([]);
    scheduleScan(300);
  }

  observer = new MutationObserver((records) => {
    handleRouteMaybeChanged();
    if (NS.parser.mutationTouchesUsageArea(records)) scheduleScan(350);
  });
  observer.observe(document.body || document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['role', 'aria-hidden', 'aria-modal'] });

  const routeTimer = global.setInterval(handleRouteMaybeChanged, 1000);
  global.addEventListener('popstate', handleRouteMaybeChanged, { passive: true });
  global.addEventListener('hashchange', handleRouteMaybeChanged, { passive: true });

  function onStorageChanged(changes, area) {
    if (area === 'local' && changes.settings && widget) widget.updateSettings(changes.settings.newValue || {});
  }
  chrome.storage.onChanged.addListener(onStorageChanged);

  function onRuntimeMessage(message, sender, sendResponse) {
    if (!message || typeof message.type !== 'string') return false;
    if (message.type === 'GPT_BUDDY_PING') {
      sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
      return false;
    }
    if (message.type === 'GPT_BUDDY_SHOW') {
      widget.updateSettings({ visible: true });
      scan();
      sendResponse({ ok: true });
      return false;
    }
    if (message.type === 'GPT_BUDDY_RESCAN') {
      scan();
      sendResponse({ ok: true });
      return false;
    }
    return false;
  }
  chrome.runtime.onMessage.addListener(onRuntimeMessage);

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    global.clearTimeout(scanTimer);
    global.clearInterval(routeTimer);
    observer && observer.disconnect();
    chrome.storage.onChanged.removeListener(onStorageChanged);
    chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    global.removeEventListener('popstate', handleRouteMaybeChanged);
    global.removeEventListener('hashchange', handleRouteMaybeChanged);
    widget && widget.destroy();
    delete global.__GPT_BUDDY_CONTROLLER__;
  }

  global.__GPT_BUDDY_CONTROLLER__ = { destroy, scan };
  global.addEventListener('pagehide', destroy, { once: true });
  scan();
})(globalThis).catch((error) => {
  console.error('[GPT 小伙伴] 内容脚本启动失败。', error);
});
