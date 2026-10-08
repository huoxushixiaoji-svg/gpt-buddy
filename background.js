"use strict";

const DEFAULT_SETTINGS = Object.freeze({
  visible: true,
  scale: 1,
  animationEnabled: true,
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

if (typeof chrome !== 'undefined' && chrome.runtime && chrome.storage) {
  let writeQueue = Promise.resolve();

  chrome.runtime.onInstalled.addListener(async () => {
    const current = await chrome.storage.local.get('settings');
    if (!current.settings) await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const task = async () => {
      if (!message || typeof message.type !== 'string') return { ok: false, error: 'invalid-message' };

      if (message.type === 'GET_STATE') {
        const data = await chrome.storage.local.get(['settings', 'snapshotsByContext']);
        const contextKey = String(message.contextKey || '');
        return {
          ok: true,
          settings: { ...DEFAULT_SETTINGS, ...(data.settings || {}) },
          snapshots: contextKey && data.snapshotsByContext ? (data.snapshotsByContext[contextKey] || {}) : {}
        };
      }

      if (message.type === 'UPDATE_SETTINGS') {
        const data = await chrome.storage.local.get('settings');
        const patch = message.patch && typeof message.patch === 'object' ? message.patch : {};
        const settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}), ...patch };
        await chrome.storage.local.set({ settings });
        return { ok: true, settings };
      }

      if (message.type === 'UPSERT_SNAPSHOTS') {
        const rawContext = String(message.contextKey || '');
        const tabId = sender && sender.tab ? sender.tab.id : 'unknown';
        const contextKey = rawContext.startsWith('unverified:') ? `tab-${tabId}:${rawContext}` : rawContext;
        if (!contextKey) return { ok: false, error: 'missing-context' };
        const data = await chrome.storage.local.get('snapshotsByContext');
        const all = { ...(data.snapshotsByContext || {}) };
        all[contextKey] = mergeSnapshotMaps(all[contextKey], message.items);
        await chrome.storage.local.set({ snapshotsByContext: all });
        return { ok: true, contextKey, snapshots: all[contextKey] };
      }

      if (message.type === 'CLEAR_SNAPSHOTS') {
        await chrome.storage.local.remove('snapshotsByContext');
        return { ok: true };
      }

      return { ok: false, error: 'unknown-message' };
    };

    writeQueue = writeQueue.then(task, task);
    writeQueue.then(sendResponse, (error) => sendResponse({ ok: false, error: String(error && error.message || error) }));
    return true;
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { DEFAULT_SETTINGS, snapshotKey, mergeSnapshotMaps };
}
