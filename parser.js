(function initParser(global) {
  "use strict";

  const NS = (global.GPTBuddy = global.GPTBuddy || {});
  const EXCLUDED_SELECTOR = [
    '[data-message-author-role]',
    'article[data-testid*="conversation"]',
    '[data-testid*="message"]',
    'pre',
    'code',
    'blockquote',
    'template',
    '[aria-hidden="true"]',
    '[hidden]',
    '[inert]'
  ].join(',');

  const CANDIDATE_SELECTOR = '[role="dialog"], [aria-modal="true"], [role="alert"]';
  const USAGE_CONTEXT = /(?:用量|使用限额|额度|限制|usage|rate\s*limit|limit)/i;
  const CHAT_SCOPE = /(?:普通\s*Chat|聊天|消息|Chat(?:GPT)?)/i;
  const WORK_SCOPE = /(?:Work\s*\/\s*Codex|Codex|工作)/i;
  const USED_PERCENT = /(?:已使用|已用|used)\s*[:：]?\s*(\d{1,3}(?:\.\d+)?)\s*%/i;
  const USED_PERCENT_SUFFIX = /(\d{1,3}(?:\.\d+)?)\s*%\s*(?:已使用|已用|used)/i;
  const REMAINING_PERCENT = /(?:剩余|还剩|可用|remaining|left)\s*[:：]?\s*(\d{1,3}(?:\.\d+)?)\s*%/i;
  const REMAINING_PERCENT_SUFFIX = /(\d{1,3}(?:\.\d+)?)\s*%\s*(?:剩余|可用|remaining|left)/i;
  const RESET_TEXT = /(?:重置(?!卡)|恢复|可再次使用|reset(?:s)?(?!\s+cards?)|available\s+again)\s*[:：]?\s*([^\n。；;]{1,80})/i;
  const RESET_CARD_LABEL = /(?:余额重置卡|(?:balance\s+)?reset\s+cards?)/i;
  const RESET_CARD_COUNT = /(?:余额重置卡(?:次数|数量|剩余)?|(?:balance\s+)?reset\s+cards?)\s*[:：]?\s*(?:剩余\s*)?(\d{1,4})(?![\d.%])\s*(?:张|次|cards?)?/i;
  const LIMIT_REACHED = /(?:已达到(?:[^\n]{0,16})限制|额度已用完|达到上限|limit\s+reached|you(?:'ve| have)\s+reached)/i;
  const REMAINING_COUNT = /(?:剩余|还剩|可用|remaining|left)\s*[:：]?\s*(\d+)\s*(次|条|messages?|requests?|uses?)/i;
  const REMAINING_COUNT_SUFFIX = /(\d+)\s*(次|条|messages?|requests?|uses?)\s*(?:剩余|可用|remaining|left)/i;
  const VALUE_SIGNAL = /(?:\d{1,3}(?:\.\d+)?\s*%|(?:剩余|还剩|可用|remaining|left|已使用|已用|used)\s*[:：]?\s*\d|已达到(?:[^\n]{0,16})限制|limit\s+reached)/i;

  function normalizeText(text) {
    return String(text || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function clampPercent(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 && number <= 100 ? number : null;
  }

  function slug(value) {
    const normalized = normalizeText(value).toLowerCase();
    let hash = 2166136261;
    for (let index = 0; index < normalized.length; index += 1) {
      hash ^= normalized.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function inferScope(text, explicitScope) {
    if (explicitScope) return normalizeText(explicitScope);
    if (WORK_SCOPE.test(text)) return 'work-codex';
    if (CHAT_SCOPE.test(text)) return 'chat';
    return 'unspecified';
  }

  function parseResetAt(rawText, now) {
    if (!rawText) return null;
    const text = normalizeText(rawText);
    // Only accept an absolute date/time with a timezone offset or Z. Locale-only
    // times remain resetText because guessing the date or timezone is unsafe.
    const absolute = text.match(/\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2}))\b/);
    if (!absolute) return null;
    const parsed = Date.parse(absolute[1]);
    return Number.isFinite(parsed) && parsed > Number(now || Date.now()) - 366 * 86400000 ? parsed : null;
  }

  function quotaKindForLabel(label) {
    const value = normalizeText(label);
    if (/(?:5[\s-]*(?:h(?:our)?s?|小时|小時)|五\s*(?:小时|小時))/i.test(value)) return 'five-hour';
    if (/(?:week(?:ly)?|周|週|7\s*day)/i.test(value)) return 'weekly';
    return null;
  }

  function quotaKindFromLocalText(text) {
    const value = normalizeText(text);
    const firstValue = value.search(VALUE_SIGNAL);
    const prefix = value.slice(0, firstValue < 0 ? 120 : firstValue).slice(0, 120);
    if (RESET_TEXT.test(prefix) || !/(?:额度|限额|用量|limit|usage)/i.test(prefix)) return null;
    return quotaKindForLabel(prefix);
  }

  function quotaLabelBeforeValue(text) {
    const value = normalizeText(text);
    const firstValue = value.search(VALUE_SIGNAL);
    const label = normalizeText((firstValue < 0 ? value : value.slice(0, firstValue)).replace(/[：:\s]+$/, ''));
    return quotaKindForLabel(label) ? label : '';
  }

  function parseResetText(text) {
    const match = normalizeText(text).match(RESET_TEXT);
    if (!match) return '';
    const candidate = normalizeText(match[1].split(RESET_CARD_LABEL)[0]);
    if (!candidate || /(?:%|剩余|还剩|已用|remaining|left|used)/i.test(candidate)) return '';
    const absolute = candidate.match(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})\b/i);
    if (absolute) return absolute[0];
    const dateOrTime = candidate.match(/^(.*?(?:\b\d{1,2}:\d{2}(?::\d{2})?\b|\b\d{4}-\d{2}-\d{2}\b))/i);
    if (dateOrTime) return normalizeText(dateOrTime[1]);
    const relative = candidate.match(/^(.*?(?:\b\d+\s*(?:minutes?|hours?|days?)\b|\d+\s*(?:分钟|小时|小時|天)(?:后|後)?))/i);
    return relative ? normalizeText(relative[1]) : '';
  }

  function parseResetCardCount(text) {
    const match = normalizeText(text).match(RESET_CARD_COUNT);
    return match ? Number(match[1]) : null;
  }

  function splitBuckets(block) {
    if (Array.isArray(block.buckets) && block.buckets.length) return block.buckets;
    return [{
      label: block.label || block.heading || '',
      text: block.text,
      scope: block.scope,
      bucketId: block.bucketId,
      resetCardCount: block.resetCardCount
    }];
  }

  function parseUsageBlocks(blocks, options) {
    const now = Number(options && options.now) || Date.now();
    const results = [];

    for (const block of blocks || []) {
      const blockText = normalizeText([block.heading, block.text].filter(Boolean).join('\n'));
      if (!block.testFixture && !block.routeVerified && !USAGE_CONTEXT.test(blockText)) continue;

      for (const bucket of splitBuckets(block)) {
        const text = normalizeText(bucket.text || '');
        const quotaText = text.replace(RESET_CARD_COUNT, '');
        const label = normalizeText(bucket.label || block.label || block.heading || '用量项目');
        const quotaKind = bucket.quotaKind || block.quotaKind || quotaKindForLabel(label)
          || quotaKindFromLocalText(text);
        if (options && options.onlyTrackedQuotas && !quotaKind) continue;
        const remainingMatch = quotaText.match(REMAINING_PERCENT) || quotaText.match(REMAINING_PERCENT_SUFFIX);
        const usedMatch = quotaText.match(USED_PERCENT) || quotaText.match(USED_PERCENT_SUFFIX);
        const countMatch = quotaText.match(REMAINING_COUNT) || quotaText.match(REMAINING_COUNT_SUFFIX);
        const limitReached = LIMIT_REACHED.test(quotaText);

        let remainingPercent = null;
        if (remainingMatch) remainingPercent = clampPercent(remainingMatch[1]);
        else if (usedMatch) {
          const used = clampPercent(usedMatch[1]);
          remainingPercent = used === null ? null : 100 - used;
        } else if (limitReached) remainingPercent = 0;

        const remainingCount = countMatch ? Number(countMatch[1]) : null;
        const resetText = parseResetText(text);
        const resetCardCount = quotaKind === 'weekly'
          ? (Number.isSafeInteger(bucket.resetCardCount) ? bucket.resetCardCount : parseResetCardCount(text)) : null;
        if (remainingPercent === null && remainingCount === null && !resetText && !limitReached && resetCardCount === null) continue;

        const scope = inferScope([blockText, text].join('\n'), bucket.scope || block.scope);
        const stableSeed = [scope, quotaKind || '', label, block.source || 'visible-semantic-container'].join('|');
        results.push({
          scope,
          bucketId: bucket.bucketId || slug(stableSeed),
          label,
          quotaKind,
          resetCardCount,
          remainingPercent,
          remainingCount,
          unit: countMatch ? normalizeText(countMatch[2]) : '',
          resetAt: parseResetAt(resetText, now),
          resetText,
          capturedAt: now,
          source: normalizeText(block.source || '当前可见的用量提示'),
          freshness: 'fresh',
          limitReached
        });
      }
    }
    return dedupe(results);
  }

  function dedupe(items) {
    const byKey = new Map();
    for (const item of items) {
      const key = `${item.scope}::${item.bucketId}`;
      const old = byKey.get(key);
      if (!old || item.capturedAt >= old.capturedAt) byKey.set(key, item);
    }
    return Array.from(byKey.values());
  }

  function isVisible(element) {
    if (!element || !element.isConnected) return false;
    if (element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
    const style = global.getComputedStyle ? global.getComputedStyle(element) : null;
    if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) return false;
    const rect = element.getBoundingClientRect ? element.getBoundingClientRect() : { width: 1, height: 1 };
    return rect.width > 0 && rect.height > 0;
  }

  function isExcluded(element) {
    return Boolean(element.closest && element.closest(EXCLUDED_SELECTOR));
  }

  function headingFor(container) {
    const labelledBy = container.getAttribute('aria-labelledby');
    if (labelledBy) {
      const labelled = container.ownerDocument.getElementById(labelledBy);
      if (labelled && isVisible(labelled)) return normalizeText(labelled.textContent);
    }
    const direct = container.querySelector(':scope > h1, :scope > h2, :scope > h3, :scope > header, [role="heading"]');
    return normalizeText((direct && direct.textContent) || container.getAttribute('aria-label') || '');
  }

  function elementText(element) {
    const documentRef = element.ownerDocument;
    const nodeFilter = (documentRef.defaultView && documentRef.defaultView.NodeFilter) || global.NodeFilter;
    if (!documentRef.createTreeWalker || !nodeFilter) return normalizeText(element.innerText || '');
    const walker = documentRef.createTreeWalker(element, nodeFilter.SHOW_TEXT);
    const parts = [];
    let node = walker.nextNode();
    while (node) {
      const parent = node.parentElement;
      if (parent && !parent.closest(EXCLUDED_SELECTOR) && isVisible(parent)) parts.push(node.nodeValue || '');
      node = walker.nextNode();
    }
    return normalizeText(parts.join(' '));
  }

  function isUsageOverviewLocation(locationLike) {
    if (!locationLike) return false;
    const hostname = String(locationLike.hostname || '').toLowerCase();
    const pathname = String(locationLike.pathname || '').replace(/\/$/, '');
    if (hostname !== 'chatgpt.com' || pathname !== '/settings/usage') return false;
    const parameters = new URLSearchParams(String(locationLike.search || ''));
    const tab = parameters.get('tab');
    return !tab || tab === 'overview';
  }

  function signalCount(text) {
    const quotaText = text.replace(RESET_CARD_COUNT, '');
    const percents = quotaText.match(/\d{1,3}(?:\.\d+)?\s*%/g) || [];
    const counts = quotaText.match(/\d+\s*(?:次|条|messages?|requests?|uses?)/gi) || [];
    return percents.length + counts.length;
  }

  function resetSignalCount(text) {
    return (text.replace(RESET_CARD_COUNT, '').match(/(?:重置|恢复|可再次使用|reset(?:s)?|available\s+again)/gi) || []).length;
  }

  function usageBucketContainer(signalElement, main) {
    let current = signalElement;
    let chosen = signalElement;
    for (let depth = 0; depth < 7; depth += 1) {
      current = current && current.parentElement;
      if (!current || current === main || isExcluded(current) || !isVisible(current)) break;
      const text = elementText(current);
      const headingCount = current.querySelectorAll ? current.querySelectorAll('h1, h2, h3, h4, [role="heading"]').length : 0;
      if (!text || text.length > 700 || signalCount(text) > 1 || resetSignalCount(text) > 1 || headingCount > 1) break;
      chosen = current;
    }
    return chosen;
  }

  function visibleTextNodes(container) {
    const documentRef = container.ownerDocument;
    const nodeFilter = (documentRef.defaultView && documentRef.defaultView.NodeFilter) || global.NodeFilter;
    if (!documentRef.createTreeWalker || !nodeFilter) return [];
    const walker = documentRef.createTreeWalker(container, nodeFilter.SHOW_TEXT);
    const nodes = [];
    let node = walker.nextNode();
    while (node) {
      const parent = node.parentElement;
      const text = normalizeText(node.nodeValue);
      if (text && parent && !parent.closest(EXCLUDED_SELECTOR) && isVisible(parent)) nodes.push(node);
      node = walker.nextNode();
    }
    return nodes;
  }

  function usageBucketLabel(container, signalElement) {
    const heading = headingFor(container);
    if (quotaKindForLabel(heading) && !VALUE_SIGNAL.test(heading) && !RESET_TEXT.test(heading)) return heading;
    const nodes = visibleTextNodes(container);
    const signalIndex = nodes.findIndex((node) => node === signalElement || node.parentElement === signalElement || signalElement.contains(node));
    const end = signalIndex >= 0 ? signalIndex + 1 : nodes.length;
    for (let index = end - 1; index >= 0; index -= 1) {
      const text = normalizeText(nodes[index].nodeValue);
      const quotaLabel = quotaLabelBeforeValue(text);
      if (text.length <= 120 && quotaLabel && !RESET_TEXT.test(text)) return quotaLabel;
    }
    if (heading && !VALUE_SIGNAL.test(heading) && !RESET_TEXT.test(heading)) return heading;
    for (let index = end - 1; index >= 0; index -= 1) {
      const text = normalizeText(nodes[index].nodeValue);
      if (text.length <= 80 && !VALUE_SIGNAL.test(text) && !RESET_TEXT.test(text)) return text;
    }
    return '用量项目';
  }

  function usageScopeForElement(element, main, fallbackText) {
    let current = element;
    while (current && current !== main) {
      const heading = current.querySelector && current.querySelector(':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > [role="heading"]');
      const text = normalizeText(heading && heading.textContent);
      if (WORK_SCOPE.test(text)) return 'work-codex';
      if (CHAT_SCOPE.test(text)) return 'chat';
      current = current.parentElement;
    }
    return inferScope(fallbackText);
  }

  function blocksFromUsageOverview(root, locationLike) {
    if (!isUsageOverviewLocation(locationLike) || !root.querySelector) return [];
    const main = root.querySelector('main, [role="main"]');
    if (!main || !isVisible(main) || isExcluded(main)) return [];

    const allNodes = visibleTextNodes(main);
    let resetCardCount = null;
    for (const node of allNodes) {
      if (!RESET_CARD_LABEL.test(normalizeText(node.nodeValue))) continue;
      let current = node.parentElement;
      for (let depth = 0; current && current !== main && depth < 4; depth += 1, current = current.parentElement) {
        const text = elementText(current);
        if (text.length > 120) break;
        const count = parseResetCardCount(text);
        if (count !== null) { resetCardCount = count; break; }
      }
      if (resetCardCount !== null) break;
    }
    const valueNodes = allNodes.filter((node) => VALUE_SIGNAL.test(normalizeText(node.nodeValue)));
    const resetNodes = allNodes.filter((node) => !RESET_CARD_LABEL.test(normalizeText(node.nodeValue)) && parseResetText(node.nodeValue));
    const containers = [];

    for (const node of valueNodes) {
      const container = usageBucketContainer(node.parentElement, main);
      if (!containers.some((existing) => existing === container)) containers.push(container);
    }
    for (const node of resetNodes) {
      if (containers.some((existing) => existing.contains(node))) continue;
      const container = usageBucketContainer(node.parentElement, main);
      if (!containers.some((existing) => existing === container || existing.contains(container) || container.contains(existing))) containers.push(container);
    }

    const blocks = containers.map((container, index) => {
      const text = elementText(container);
      const signalNode = visibleTextNodes(container).find((node) => VALUE_SIGNAL.test(normalizeText(node.nodeValue))) || container;
      const label = usageBucketLabel(container, signalNode);
      const scope = usageScopeForElement(container, main, `${label}\n${text}`);
      return {
        heading: label,
        label,
        text,
        scope,
        bucketId: slug(`${scope}|${label}|${index}`),
        source: 'ChatGPT 用量页（overview）',
        routeVerified: true
      };
    });
    const weeklyBlocks = blocks.filter((block) => quotaKindForLabel(block.label) === 'weekly');
    if (resetCardCount !== null && weeklyBlocks.length === 1) weeklyBlocks[0].resetCardCount = resetCardCount;
    if (resetCardCount !== null && weeklyBlocks.length === 0) {
      blocks.push({
        heading: '周额度', label: '周额度', text: '', resetCardCount,
        bucketId: 'weekly-reset-card', scope: 'unspecified',
        source: 'ChatGPT 用量页（overview）', routeVerified: true
      });
    }
    return blocks;
  }

  function blocksFromDocument(root, options) {
    const blocks = [];
    const candidates = root.querySelectorAll ? root.querySelectorAll(CANDIDATE_SELECTOR) : [];
    for (const container of candidates) {
      if (!isVisible(container) || isExcluded(container)) continue;
      const heading = headingFor(container);
      const text = elementText(container);
      if (!USAGE_CONTEXT.test(`${heading}\n${text}`)) continue;

      const namedChildren = Array.from(container.querySelectorAll(':scope [role="listitem"], :scope > section, :scope > article, :scope > ul > li'))
        .filter((child) => isVisible(child) && !isExcluded(child));
      const buckets = namedChildren.length > 1
        ? namedChildren.map((child) => ({
            label: headingFor(child) || normalizeText(child.getAttribute('aria-label')) || '用量项目',
            text: elementText(child),
            scope: normalizeText(child.getAttribute('data-scope')),
            bucketId: normalizeText(child.getAttribute('data-bucket-id'))
          }))
        : null;

      blocks.push({
        heading,
        text,
        buckets,
        source: heading ? `可见面板：${heading}` : '当前可见的限制提示'
      });
    }
    const locationLike = (options && options.location) || global.location;
    return blocks.concat(blocksFromUsageOverview(root, locationLike));
  }

  function scanVisibleUsage(root, options) {
    return parseUsageBlocks(blocksFromDocument(root || global.document, options), options);
  }

  function mutationTouchesUsageArea(records, locationLike) {
    const onUsageOverview = isUsageOverviewLocation(locationLike || global.location);
    for (const record of records || []) {
      const nodes = [...(record.addedNodes || []), ...(record.removedNodes || [])];
      for (const node of nodes) {
        if (node.nodeType !== 1) continue;
        if ((node.matches && node.matches(CANDIDATE_SELECTOR)) || (node.querySelector && node.querySelector(CANDIDATE_SELECTOR))) return true;
        if (onUsageOverview && ((node.matches && node.matches('main, [role="main"]'))
          || (node.querySelector && node.querySelector('main, [role="main"]')))) return true;
      }
      const target = record.target?.nodeType === 3 ? record.target.parentElement : record.target;
      if (target?.closest && target.closest(CANDIDATE_SELECTOR)) return true;
      if (onUsageOverview && target?.closest && target.closest('main, [role="main"]')) return true;
    }
    return false;
  }

  NS.parser = {
    CANDIDATE_SELECTOR,
    normalizeText,
    isUsageOverviewLocation,
    parseResetAt,
    quotaKindForLabel,
    quotaKindFromLocalText,
    parseResetText,
    parseResetCardCount,
    parseUsageBlocks,
    blocksFromUsageOverview,
    scanVisibleUsage,
    mutationTouchesUsageArea
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = NS.parser;
})(typeof globalThis !== 'undefined' ? globalThis : this);
