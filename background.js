"use strict";

const DEFAULT_SETTINGS = Object.freeze({
  visible: true,
  scale: 1,
  animationEnabled: true,
  backgroundRefreshEnabled: true,
  backgroundRefreshConfigured: true,
  selectedQuotaKind: 'five-hour',
  position: null
});

function snapshotKey(item) {
  return `${item.scope}::${item.bucketId}`;
}

function mergeSnapshotMaps(existing, incoming) {
  const merged = { ...(existing || {}) };
  for (const item of incoming || []) {
    if (!item || !item.scope || !item.bucketId || !Number.isFinite(Number(item.capturedAt))) continue;
    const key = snapshotKey(item);
    const old = merged[key];
    if (!old || Number(item.capturedAt) >= Number(old.capturedAt)) merged[key] = item;
  }
  return merged;
}

function settingsForAutomaticReader(existing) {
  if (existing?.backgroundRefreshConfigured === true) return { ...DEFAULT_SETTINGS, ...existing };
  return { ...DEFAULT_SETTINGS, ...(existing || {}), backgroundRefreshEnabled: true, backgroundRefreshConfigured: true };
}

if (typeof chrome !== 'undefined' && chrome.runtime && chrome.storage) {
  importScripts('reader.js');
  const reader = GPTBuddyReader.createReader(chrome);
  let writeQueue = Promise.resolve();
  function enqueue(task) {
    const result = writeQueue.then(task, task);
    writeQueue = result.catch(() => {});
    return result;
  }
  chrome.alarms.onAlarm.addListener((alarm) => { enqueue(() => reader.alarm(alarm.name)); });
  chrome.tabs.onRemoved.addListener((id) => { enqueue(() => reader.tabRemoved(id)); });
  chrome.runtime.onStartup.addListener(() => { enqueue(() => reader.restore()); });

  async function ensureAutomaticReader() {
    const current = (await chrome.storage.local.get('settings')).settings;
    const settings = settingsForAutomaticReader(current);
    if (!current || current.backgroundRefreshConfigured !== true) {
      await chrome.storage.local.set({ settings });
      await reader.restore();
    }
    return settings;
  }

  chrome.runtime.onInstalled.addListener(() => { enqueue(async () => {
    await ensureAutomaticReader();
    await reader.restore();
  }); });

  function contextFor(message, sender) {
    return `tab-${sender.tab?.id ?? 'popup'}:${String(message.contextKey || '')}`;
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const task = async () => {
      if (!message || typeof message.type !== 'string') return { ok: false, error: 'invalid-message' };

      if (message.type === 'GET_STATE') {
        const settings = await ensureAutomaticReader();
        const data = await chrome.storage.local.get(['settings', 'snapshotsByContext', 'backgroundUsage']);
        const contextKey = contextFor(message, sender);
        return {
          ok: true,
          settings,
          backgroundUsage: data.backgroundUsage || { status: 'off', items: [] },
          backgroundCapture: await reader.captureFor(sender),
          snapshots: contextKey && data.snapshotsByContext ? (data.snapshotsByContext[contextKey] || {}) : {}
        };
      }

      if (message.type === 'UPDATE_SETTINGS') {
        const data = await chrome.storage.local.get('settings');
        const patch = message.patch && typeof message.patch === 'object' ? message.patch : {};
        const settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}), ...patch,
          ...('backgroundRefreshEnabled' in patch ? { backgroundRefreshConfigured: true } : {}) };
        await chrome.storage.local.set({ settings });
        if ('backgroundRefreshEnabled' in patch) await reader.setEnabled(settings.backgroundRefreshEnabled === true);
        return { ok: true, settings };
      }

      if (message.type === 'UPSERT_SNAPSHOTS') {
        const contextKey = contextFor(message, sender);
        if (!message.contextKey) return { ok: false, error: 'missing-context' };
        const data = await chrome.storage.local.get('snapshotsByContext');
        const all = { ...(data.snapshotsByContext || {}) };
        all[contextKey] = mergeSnapshotMaps(all[contextKey], message.items);
        await chrome.storage.local.set({ snapshotsByContext: all });
        return { ok: true, contextKey, snapshots: all[contextKey] };
      }

      if (message.type === 'CLEAR_SNAPSHOTS') {
        const { settings = {} } = await chrome.storage.local.get('settings');
        await chrome.storage.local.set({ settings: { ...settings, backgroundRefreshEnabled: false, backgroundRefreshConfigured: true } });
        await reader.stop('off', true);
        await chrome.storage.local.remove('snapshotsByContext');
        await chrome.storage.local.set({ clearEpoch: crypto.randomUUID() });
        return { ok: true };
      }

      if (message.type === 'READER_RESULT') return reader.accept(message, sender);
      if (message.type === 'REFRESH_BACKGROUND') { await reader.poll(); return { ok: true }; }

      return { ok: false, error: 'unknown-message' };
    };

    enqueue(task).then(sendResponse, (error) => sendResponse({ ok: false, error: String(error && error.message || error) }));
    return true;
  });
  enqueue(() => reader.restore());
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { DEFAULT_SETTINGS, snapshotKey, mergeSnapshotMaps, settingsForAutomaticReader };
}
