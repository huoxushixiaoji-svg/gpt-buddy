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

  async function send(message) {
    try { return await chrome.runtime.sendMessage(message); }
    catch (error) { return { ok: false, error: String(error && error.message || error) }; }
  }

  const [styles, initial] = await Promise.all([
    fetch(chrome.runtime.getURL('styles.css')).then((response) => response.text()),
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

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    global.clearTimeout(scanTimer);
    global.clearInterval(routeTimer);
    observer && observer.disconnect();
    chrome.storage.onChanged.removeListener(onStorageChanged);
    global.removeEventListener('popstate', handleRouteMaybeChanged);
    global.removeEventListener('hashchange', handleRouteMaybeChanged);
    widget && widget.destroy();
    delete global.__GPT_BUDDY_CONTROLLER__;
  }

  global.__GPT_BUDDY_CONTROLLER__ = { destroy, scan };
  global.addEventListener('pagehide', destroy, { once: true });
  scan();
})(globalThis);
