(async function startGPTBuddy(global) {
  "use strict";

  if (global.__GPT_BUDDY_CONTROLLER__) return;
  const NS = global.GPTBuddy;
  if (!NS || !NS.parser || !NS.state || !NS.widget) return;
  if (!global.__GPT_BUDDY_RESTORE_LISTENER__) {
    global.__GPT_BUDDY_RESTORE_LISTENER__ = true;
    global.addEventListener('pageshow', (event) => {
      if (event.persisted && !global.__GPT_BUDDY_CONTROLLER__) {
        startGPTBuddy(global).catch((error) => console.error('[GPT 小伙伴] 页面恢复失败。', error));
      }
    });
  }
  // Claim the singleton before waiting on resources/storage.
  global.__GPT_BUDDY_CONTROLLER__ = { starting: true };

  const contextKey = `unverified:${crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`}`;
  let destroyed = false;
  let scanTimer = null;
  let lastUrl = global.location.href;
  let observer = null;
  let widget = null;
  const snapshots = NS.state.createSnapshotSession();
  let localItems = [];
  let backgroundUsage = { status: 'off', items: [] };
  let settings = {};

  const FALLBACK_STYLES = `
    :host{all:initial;position:fixed;z-index:2147483000;width:360px;height:342px;pointer-events:none;font-family:system-ui,sans-serif}
    :host([hidden]){display:none!important}
    .buddy-frame{position:relative;width:360px;height:342px;pointer-events:none}.buddy-visual{position:absolute;inset:0;width:360px;height:342px;transform-origin:65% 100%;pointer-events:none}.buddy-character{position:absolute;inset:0;width:360px;height:342px;object-fit:contain}
    .buddy-bubble{position:absolute;left:18px;top:27px;width:185px;height:104px;display:grid;place-items:center;padding:8px 14px;color:#211d25;pointer-events:auto;overflow:hidden}
    .buddy-message{margin:0;font-size:13px;font-weight:700;line-height:1.4}.buddy-details{font-size:14px;line-height:1.2;max-height:88px;overflow:auto}.detail-value{font-size:17px;font-weight:800}.buddy-details[hidden],.buddy-message[hidden],.buddy-menu[hidden]{display:none!important}
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
  settings = initial?.settings || {};
  backgroundUsage = initial?.backgroundUsage || backgroundUsage;
  const backgroundCapture = initial?.backgroundCapture;

  function updateSettings(patch) {
    send({ type: 'UPDATE_SETTINGS', patch });
  }

  function renderSnapshots() {
    if (!widget) return;
    const visible = localItems.some((item) => item.observationStatus === 'visible');
    const shared = !visible && settings.backgroundRefreshEnabled && backgroundUsage.items?.length;
    widget.setItems(shared ? backgroundUsage.items.map((item) => ({
      ...item, observationStatus: 'background',
      updatePending: backgroundUsage.status !== 'ok'
    })) : localItems);
  }

  function clearSnapshots() {
    send({ type: 'CLEAR_SNAPSHOTS' }).then(() => {
      localItems = snapshots.clear();
      backgroundUsage = { status: 'off', items: [] };
      renderSnapshots();
    });
  }

  function scan(manual = false) {
    if (destroyed || !widget) return;
    // Only the explicitly managed reader tab may read while backgrounded.
    const canRead = !document.hidden || Boolean(backgroundCapture);
    const items = !canRead ? [] : backgroundCapture
      ? NS.parser.parseUsageBlocks(NS.parser.blocksFromUsageOverview(document, location), { now: Date.now(), onlyTrackedQuotas: true })
      : NS.parser.scanVisibleUsage(document, { now: Date.now(), onlyTrackedQuotas: true });
    const result = snapshots.read(items, { manual });
    localItems = result.items;
    renderSnapshots();
    if (backgroundCapture && result.changed.length) {
      send({ type: 'READER_RESULT', captureId: backgroundCapture.captureId, items });
    } else if (!backgroundCapture && result.changed.length) {
      send({ type: 'UPSERT_SNAPSHOTS', contextKey, items: result.changed });
    }
  }

  function scheduleScan(delay) {
    global.clearTimeout(scanTimer);
    scanTimer = global.setTimeout(scan, Number(delay) || 250);
  }

  widget = NS.widget.createWidget({
    styles,
    imageUrl: chrome.runtime.getURL('assets/character-web.png'),
    settings: initial && initial.settings,
    onRescan: () => scan(true),
    onSettingsChange: updateSettings,
    onClear: clearSnapshots
  });

  function handleRouteMaybeChanged() {
    if (global.location.href === lastUrl) return;
    lastUrl = global.location.href;
    localItems = snapshots.leave();
    renderSnapshots();
    scheduleScan(300);
  }

  observer = new MutationObserver((records) => {
    handleRouteMaybeChanged();
    if (NS.parser.mutationTouchesUsageArea(records)) scheduleScan(350);
  });
  observer.observe(document.body || document.documentElement, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['role', 'aria-hidden', 'aria-modal', 'hidden'] });

  const routeTimer = global.setInterval(handleRouteMaybeChanged, 1000);
  global.addEventListener('popstate', handleRouteMaybeChanged, { passive: true });
  global.addEventListener('hashchange', handleRouteMaybeChanged, { passive: true });
  function onVisibilityChanged() {
    if (document.hidden && !backgroundCapture) {
      localItems = snapshots.leave();
      renderSnapshots();
    } else scheduleScan(150);
  }
  document.addEventListener('visibilitychange', onVisibilityChanged);

  function onStorageChanged(changes, area) {
    if (area !== 'local') return;
    if (changes.settings) {
      settings = changes.settings.newValue || {};
      widget?.updateSettings(settings);
    }
    if (changes.backgroundUsage) backgroundUsage = changes.backgroundUsage.newValue || { status: 'off', items: [] };
    if (changes.clearEpoch) localItems = snapshots.clear();
    renderSnapshots();
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
      scan(true);
      sendResponse({ ok: true });
      return false;
    }
    if (message.type === 'GPT_BUDDY_RESCAN') {
      scan(true);
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
    document.removeEventListener('visibilitychange', onVisibilityChanged);
    widget && widget.destroy();
    delete global.__GPT_BUDDY_CONTROLLER__;
  }

  global.__GPT_BUDDY_CONTROLLER__ = { destroy, scan };
  global.addEventListener('pagehide', destroy, { once: true });
  scan();
})(globalThis).catch((error) => {
  delete globalThis.__GPT_BUDDY_CONTROLLER__;
  console.error('[GPT 小伙伴] 内容脚本启动失败。', error);
});
