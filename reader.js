(function initBackgroundReader(global) {
  'use strict';

  const URL_USAGE = 'https://chatgpt.com/settings/usage?tab=overview';
  const POLL_ALARM = 'gpt-buddy-usage-poll';
  const DEADLINE_ALARM = 'gpt-buddy-usage-deadline';
  const TIMEOUT_MS = 45_000;

  function isUsageURL(value) {
    try {
      const url = new URL(value);
      return url.origin === 'https://chatgpt.com' && url.pathname.replace(/\/$/, '') === '/settings/usage'
        && (!url.searchParams.get('tab') || url.searchParams.get('tab') === 'overview');
    } catch { return false; }
  }

  function sanitizeItems(input, now) {
    if (!Array.isArray(input)) return [];
    return input.slice(0, 30).filter((item) => item && typeof item.scope === 'string'
      && typeof item.bucketId === 'string' && typeof item.label === 'string').map((item) => ({
      scope: item.scope.slice(0, 100), bucketId: item.bucketId.slice(0, 100), label: item.label.slice(0, 100),
      remainingPercent: typeof item.remainingPercent === 'number' && Number.isFinite(item.remainingPercent)
        && item.remainingPercent >= 0 && item.remainingPercent <= 100 ? item.remainingPercent : null,
      remainingCount: Number.isSafeInteger(item.remainingCount) && item.remainingCount >= 0 ? item.remainingCount : null,
      unit: typeof item.unit === 'string' ? item.unit.slice(0, 30) : '',
      resetAt: typeof item.resetAt === 'number' && Number.isFinite(item.resetAt) ? item.resetAt : null,
      resetText: typeof item.resetText === 'string' ? item.resetText.slice(0, 120) : '',
      capturedAt: now,
      source: 'ChatGPT 用量页（扩展后台标签页）',
      freshness: 'fresh',
      limitReached: item.limitReached === true
    })).filter((item) => item.remainingPercent !== null || item.remainingCount !== null || item.resetText || item.limitReached);
  }

  // All entry points run through background.js's shared write queue. Session
  // storage survives service worker suspension but never reuses a browser's old tab IDs.
  function createReader(api, now = Date.now, id = () => crypto.randomUUID()) {
    const runtime = async () => (await api.storage.session.get('usageReaderRuntime')).usageReaderRuntime || {};
    const enabled = async () => Boolean((await api.storage.local.get('settings')).settings?.backgroundRefreshEnabled);
    const saveRuntime = (value) => api.storage.session.set({ usageReaderRuntime: value });
    async function publish(patch) {
      const old = (await api.storage.local.get('backgroundUsage')).backgroundUsage || { items: [] };
      await api.storage.local.set({ backgroundUsage: { ...old, ...patch } });
    }
    async function ownedTab(state) {
      if (!Number.isInteger(state.tabId)) return null;
      try { return await api.tabs.get(state.tabId); } catch { return null; }
    }
    async function stop(status = 'off', erase = false) {
      const state = await runtime();
      await api.alarms.clear(POLL_ALARM);
      await api.alarms.clear(DEADLINE_ALARM);
      await api.storage.session.remove('usageReaderRuntime');
      await publish({ status, ...(erase ? { items: [], lastSuccessAt: null } : {}) });
      const tab = await ownedTab(state);
      // Only the extension-created, still on-topic, inactive tab may be closed.
      if (tab && !tab.active && isUsageURL(tab.url) && (!tab.pendingUrl || isUsageURL(tab.pendingUrl))) {
        try { await api.tabs.remove(tab.id); } catch { /* Already closed. */ }
      }
    }
    async function poll() {
      if (!await enabled()) return;
      const old = await runtime();
      if (old.pending && old.deadline > now()) return;
      let tab = await ownedTab(old);
      // A login redirect, unreadable URL (outside host permission), or stalled
      // navigation is not evidence that the user repurposed the tab. Pause
      // instead of spawning one more login/error tab every minute.
      if (tab && (!tab.url || !tab.url.startsWith('https://chatgpt.com/')
        || /^https:\/\/chatgpt\.com\/(?:auth|login|signup)(?:[/?#]|$)/.test(tab.url))) {
        await publish({ status: 'page-unavailable' });
        return;
      }
      // Relinquish a tab the user has navigated elsewhere. Never navigate it back.
      if (tab && (!isUsageURL(tab.url) || (tab.pendingUrl && !isUsageURL(tab.pendingUrl)))) tab = null;
      if (tab?.active) {
        await publish({ status: 'waiting-active' });
        return;
      }
      const next = {
        tabId: tab?.id ?? null, captureId: id(), previousDocumentId: tab ? old.documentId : null,
        documentId: null, pending: true, deadline: now() + TIMEOUT_MS
      };
      await saveRuntime(next);
      await publish({ status: 'loading', lastAttemptAt: now() });
      await api.alarms.create(DEADLINE_ALARM, { when: next.deadline });
      try {
        if (tab) await api.tabs.reload(tab.id);
        else {
          const created = await api.tabs.create({ url: URL_USAGE, active: false });
          next.tabId = created.id;
          await saveRuntime(next);
        }
      } catch {
        await saveRuntime({ ...next, pending: false });
        await publish({ status: 'page-unavailable' });
        await api.alarms.clear(DEADLINE_ALARM);
      }
    }
    async function setEnabled(value) {
      if (!value) return stop();
      await api.alarms.create(POLL_ALARM, { periodInMinutes: 1 });
      await poll();
    }
    async function captureFor(sender) {
      if (!await enabled() || sender.frameId !== 0 || !isUsageURL(sender.url) || !sender.documentId) return null;
      const state = await runtime();
      if (sender.tab?.id !== state.tabId || !state.captureId) return null;
      if (state.documentId && sender.documentId !== state.documentId) return null;
      if (!state.documentId && (sender.documentId === state.previousDocumentId || !state.pending)) return null;
      if (!state.documentId) await saveRuntime({ ...state, documentId: sender.documentId });
      return { captureId: state.captureId };
    }
    async function accept(message, sender) {
      if (!await enabled()) return { ok: false };
      const state = await runtime();
      if (sender.frameId !== 0 || sender.tab?.id !== state.tabId || sender.documentId !== state.documentId
        || message.captureId !== state.captureId || !isUsageURL(sender.url)) return { ok: false };
      const items = sanitizeItems(message.items, now());
      if (!items.length) return { ok: true, waiting: true };
      const tab = await ownedTab(state);
      if (!tab || !isUsageURL(tab.url) || (tab.pendingUrl && !isUsageURL(tab.pendingUrl))) return { ok: false };
      await saveRuntime({ ...state, pending: false });
      await api.alarms.clear(DEADLINE_ALARM);
      // Replace the complete set per capture; do not merge windows from another
      // workspace/account/page into it. The UI keeps this as a separate source.
      await publish({ status: 'ok', items, lastSuccessAt: now() });
      return { ok: true };
    }
    async function alarm(name) {
      if (name === POLL_ALARM) return poll();
      if (name !== DEADLINE_ALARM || !await enabled()) return;
      const state = await runtime();
      if (!state.pending) return;
      const tab = await ownedTab(state);
      await saveRuntime({ ...state, pending: false });
      await publish({ status: tab && isUsageURL(tab.url) ? 'unrecognized' : 'page-unavailable' });
    }
    async function tabRemoved(tabId) {
      const state = await runtime();
      if (state.tabId !== tabId) return;
      const { settings = {} } = await api.storage.local.get('settings');
      await api.storage.local.set({ settings: { ...settings, backgroundRefreshEnabled: false } });
      await stop('tab-closed');
    }
    async function restore() {
      if (!await enabled()) return;
      if (!await api.alarms.get(POLL_ALARM)) await api.alarms.create(POLL_ALARM, { periodInMinutes: 1 });
      const state = await runtime();
      if (state.pending && state.deadline <= now()) await alarm(DEADLINE_ALARM);
      if (state.pending && state.deadline > now()) await api.alarms.create(DEADLINE_ALARM, { when: state.deadline });
      if (!Number.isInteger(state.tabId)) await poll();
    }
    return { poll, stop, setEnabled, captureFor, accept, alarm, tabRemoved, restore };
  }

  global.GPTBuddyReader = { createReader, sanitizeItems, isUsageURL, POLL_ALARM, DEADLINE_ALARM };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.GPTBuddyReader;
})(globalThis);
