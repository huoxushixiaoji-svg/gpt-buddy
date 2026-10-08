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
  const REMAINING_PERCENT = /(?:剩余|还剩|可用|remaining|left)\s*[:：]?\s*(\d{1,3}(?:\.\d+)?)\s*%/i;
  const RESET_TEXT = /(?:重置|恢复|可再次使用|reset(?:s)?|available\s+again)\s*[:：]?\s*([^\n。；;]{1,80})/i;
  const LIMIT_REACHED = /(?:已达到(?:[^\n]{0,16})限制|额度已用完|达到上限|limit\s+reached|you(?:'ve| have)\s+reached)/i;
  const REMAINING_COUNT = /(?:剩余|还剩|可用|remaining|left)\s*[:：]?\s*(\d+)\s*(次|条|messages?|requests?|uses?)/i;

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

  function splitBuckets(block) {
    if (Array.isArray(block.buckets) && block.buckets.length) return block.buckets;
    return [{
      label: block.label || block.heading || '',
      text: block.text,
      scope: block.scope,
      bucketId: block.bucketId
    }];
  }

  function parseUsageBlocks(blocks, options) {
    const now = Number(options && options.now) || Date.now();
    const results = [];

    for (const block of blocks || []) {
      const blockText = normalizeText([block.heading, block.text].filter(Boolean).join('\n'));
      if (!block.testFixture && !USAGE_CONTEXT.test(blockText)) continue;

      for (const bucket of splitBuckets(block)) {
        const text = normalizeText(bucket.text || '');
        const label = normalizeText(bucket.label || block.label || block.heading || '用量项目');
        const remainingMatch = text.match(REMAINING_PERCENT);
        const usedMatch = text.match(USED_PERCENT);
        const countMatch = text.match(REMAINING_COUNT);
        const resetMatch = text.match(RESET_TEXT);
        const limitReached = LIMIT_REACHED.test(text);

        let remainingPercent = null;
        if (remainingMatch) remainingPercent = clampPercent(remainingMatch[1]);
        else if (usedMatch) {
          const used = clampPercent(usedMatch[1]);
          remainingPercent = used === null ? null : 100 - used;
        } else if (limitReached) remainingPercent = 0;

        const remainingCount = countMatch ? Number(countMatch[1]) : null;
        const resetText = resetMatch ? normalizeText(resetMatch[1]) : '';
        if (remainingPercent === null && remainingCount === null && !resetText && !limitReached) continue;

        const scope = inferScope([blockText, text].join('\n'), bucket.scope || block.scope);
        const stableSeed = [scope, bucket.bucketId || '', label, block.source || 'visible-semantic-container'].join('|');
        results.push({
          scope,
          bucketId: bucket.bucketId || slug(stableSeed),
          label,
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

  function blocksFromDocument(root) {
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
    return blocks;
  }

  function scanVisibleUsage(root, options) {
    return parseUsageBlocks(blocksFromDocument(root || global.document), options);
  }

  function mutationTouchesUsageArea(records) {
    for (const record of records || []) {
      const nodes = [...record.addedNodes, ...record.removedNodes];
      for (const node of nodes) {
        if (node.nodeType !== 1) continue;
        if ((node.matches && node.matches(CANDIDATE_SELECTOR)) || (node.querySelector && node.querySelector(CANDIDATE_SELECTOR))) return true;
      }
      if (record.target && record.target.closest && record.target.closest(CANDIDATE_SELECTOR)) return true;
    }
    return false;
  }

  NS.parser = {
    CANDIDATE_SELECTOR,
    normalizeText,
    parseResetAt,
    parseUsageBlocks,
    scanVisibleUsage,
    mutationTouchesUsageArea
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = NS.parser;
})(typeof globalThis !== 'undefined' ? globalThis : this);
