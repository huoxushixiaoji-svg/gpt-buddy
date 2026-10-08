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
    if (freshnessFor(item, now) !== 'fresh') return { percent: null, count: null };
    return {
      percent: item.remainingPercent === null ? null : item.remainingPercent,
      count: item.remainingCount === null ? null : item.remainingCount
    };
  }

  NS.state = {
    DEFAULT_MAX_AGE_MS,
    freshnessFor,
    withFreshness,
    visualState,
    formatTime,
    messageFor,
    safeCurrentValue
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = NS.state;
})(typeof globalThis !== 'undefined' ? globalThis : this);
