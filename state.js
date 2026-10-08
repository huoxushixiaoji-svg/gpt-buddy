(function initState(global) {
  "use strict";

  const NS = (global.GPTBuddy = global.GPTBuddy || {});
  const DEFAULT_MAX_AGE_MS = 15 * 60 * 1000;

  function freshnessFor(item, now, maxAgeMs) {
    if (!item || item.capturedAt === null || item.capturedAt === undefined || !Number.isFinite(Number(item.capturedAt))) return 'unknown';
    const current = Number(now || Date.now());
    if (item.resetAt !== null && item.resetAt !== undefined && Number.isFinite(Number(item.resetAt)) && current >= Number(item.resetAt)) return 'past-reset';
    if (current - Number(item.capturedAt) > Number(maxAgeMs || DEFAULT_MAX_AGE_MS)) return 'stale';
    return 'fresh';
  }

  function withFreshness(item, now, maxAgeMs) {
    return { ...item, freshness: freshnessFor(item, now, maxAgeMs) };
  }

  function visualState(item, now) {
    const freshness = freshnessFor(item, now);
    if (item && (item.observationStatus === 'history' || item.observationStatus === 'background')) return 'neutral';
    if (freshness !== 'fresh' || !item || item.remainingPercent === null || item.remainingPercent === undefined) return 'neutral';
    const remaining = Number(item.remainingPercent);
    if (!Number.isFinite(remaining)) return 'neutral';
    if (remaining === 0 || item.limitReached === true) return 'resting';
    if (remaining <= 20) return 'tired';
    if (remaining <= 50) return 'idle';
    return 'energetic';
  }

  function formatTime(timestamp, locale) {
    if (!Number.isFinite(Number(timestamp))) return '';
    return new Intl.DateTimeFormat(locale || 'zh-CN', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).format(new Date(Number(timestamp)));
  }

  function messageFor(item, now) {
    if (!item) return '打开用量面板，让我看看。';
    const freshness = freshnessFor(item, now);
    if (freshness === 'past-reset') return '恢复时间已过，等你重新查看页面。';
    if (freshness === 'stale') return '这份读数有点旧啦。';
    if (freshness !== 'fresh') return '暂时没有可靠读数。';
    if (item.observationStatus === 'history') return `上次记录：${historicalValue(item)}。`;
    if (item.remainingPercent !== null && item.remainingPercent !== undefined) {
      const percent = Number(item.remainingPercent);
      if (percent === 0 || item.limitReached) return '页面提示已经到限制啦，我先休息。';
      if (percent <= 20) return `上次查看：还剩 ${percent}%。余量不多啦。`;
      return `上次查看：还剩 ${percent}%。`;
    }
    if (item.remainingCount !== null && item.remainingCount !== undefined) {
      const suffix = item.unit ? ` ${item.unit}` : '';
      return `页面显示还剩 ${item.remainingCount}${suffix}。`;
    }
    if (item.resetText) return `页面提示：${item.resetText}`;
    return '暂无准确剩余额度。';
  }

  function safeCurrentValue(item, now) {
    if (freshnessFor(item, now) !== 'fresh' || item.observationStatus === 'history') return { percent: null, count: null };
    return {
      percent: item.remainingPercent === null ? null : item.remainingPercent,
      count: item.remainingCount === null ? null : item.remainingCount
    };
  }

  function historicalValue(item) {
    if (!item) return '暂无准确剩余额度';
    if (Number.isFinite(item.remainingPercent)) return `剩余 ${item.remainingPercent}%`;
    if (Number.isFinite(item.remainingCount)) return `剩余 ${item.remainingCount}${item.unit ? ` ${item.unit}` : ''}`;
    return item.resetText ? `恢复：${item.resetText}` : '暂无准确剩余额度';
  }

  // This cache belongs to a single document, not an authenticated identity.
  // Once its source disappears, retain an explicitly historical view only.
  function createSnapshotSession() {
    const snapshots = new Map();
    let observed = new Set();
    const keyFor = (item) => JSON.stringify([item.scope, item.bucketId]);
    const fingerprint = (item) => JSON.stringify([
      item.scope, item.bucketId, item.label, item.remainingPercent, item.remainingCount,
      item.unit, item.resetAt, item.resetText, item.resetCardCount, item.quotaKind, item.source, Boolean(item.limitReached)
    ]);
    function view() {
      return Array.from(snapshots, ([key, item]) => ({
        ...item, observationStatus: observed.has(key) ? 'visible' : 'history'
      }));
    }
    return {
      read(items, { manual = false } = {}) {
        const nextObserved = new Set();
        const changed = [];
        for (const item of items || []) {
          const key = keyFor(item);
          nextObserved.add(key);
          const old = snapshots.get(key);
          if (old && old.capturedAt > item.capturedAt) continue;
          // Unrelated mutations must not keep an unchanged snapshot fresh forever.
          if (old && observed.has(key) && !manual && fingerprint(old) === fingerprint(item)) continue;
          snapshots.set(key, { ...item });
          changed.push({ ...item });
        }
        observed = nextObserved;
        return { items: view(), changed };
      },
      leave() { observed.clear(); return view(); },
      clear() { observed.clear(); snapshots.clear(); return []; }
    };
  }

  NS.state = {
    DEFAULT_MAX_AGE_MS,
    freshnessFor,
    withFreshness,
    visualState,
    formatTime,
    messageFor,
    safeCurrentValue,
    historicalValue,
    createSnapshotSession
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = NS.state;
})(typeof globalThis !== 'undefined' ? globalThis : this);
