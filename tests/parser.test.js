"use strict";

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const parser = require('../parser.js');

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
}

test('剩余 35% 保持为 35%', () => {
  const [item] = parser.parseUsageBlocks(fixture('remaining-35.json').blocks, { now: 1000 });
  assert.equal(item.remainingPercent, 35);
  assert.equal(item.remainingCount, null);
});

test('已用 35% 换算为剩余 65%', () => {
  const [item] = parser.parseUsageBlocks(fixture('used-35.json').blocks, { now: 1000 });
  assert.equal(item.remainingPercent, 65);
});

test('只有恢复时间时不虚构百分比', () => {
  const [item] = parser.parseUsageBlocks(fixture('reset-only.json').blocks, { now: 1000 });
  assert.equal(item.remainingPercent, null);
  assert.equal(item.resetText, '18:30');
  assert.equal(item.resetAt, null);
});

test('多个额度窗口分别保留', () => {
  const items = parser.parseUsageBlocks(fixture('multiple-windows.json').blocks, { now: 1000 });
  assert.deepEqual(items.map((item) => [item.bucketId, item.remainingPercent]), [['short', 72], ['week', 28]]);
});

test('overview 页面的“68% left”与“35% used”顺序可解析', () => {
  const items = parser.parseUsageBlocks(fixture('overview-suffix-order.json').blocks, { now: 1000 });
  assert.deepEqual(items.map((item) => [item.bucketId, item.remainingPercent]), [['five-hour', 68], ['weekly', 65]]);
});

test('仅保留 5 小时和周额度；重置卡不计入余额，错误重置文字被舍弃', () => {
  const items = parser.parseUsageBlocks(fixture('tracked-overview.json').blocks, { now: 1000, onlyTrackedQuotas: true });
  assert.deepEqual(items.map((item) => [item.quotaKind, item.remainingPercent]), [['five-hour', 35], ['weekly', 65]]);
  assert.equal(items[0].resetText, '');
  assert.equal(items[1].resetText, '18:30');
  assert.equal(items[1].resetCardCount, 2);
  assert.equal(items[0].resetCardCount, null);
});

test('只出现重置卡次数时保留卡次数但不冒充周额度余额', () => {
  const items = parser.parseUsageBlocks([{
    routeVerified: true, label: '周额度', text: '余额重置卡 剩余 3 次', source: '测试'
  }], { now: 1000, onlyTrackedQuotas: true });
  assert.equal(items.length, 1);
  assert.equal(items[0].remainingPercent, null);
  assert.equal(items[0].remainingCount, null);
  assert.equal(items[0].resetCardCount, 3);
});

test('明确零张卡被保留；带时区的重置时间能产生时间戳', () => {
  const [item] = parser.parseUsageBlocks([{
    routeVerified: true, label: 'Weekly limit', text: 'Reset cards: 0 Resets 2026-10-09T18:30:00Z'
  }], { now: Date.parse('2026-10-08T00:00:00Z'), onlyTrackedQuotas: true });
  assert.equal(item.remainingPercent, null);
  assert.equal(item.resetCardCount, 0);
  assert.equal(item.resetText, '2026-10-09T18:30:00Z');
  assert.equal(item.resetAt, Date.parse('2026-10-09T18:30:00Z'));
});

test('overview 适配只在指定 ChatGPT 用量路由启用', () => {
  assert.equal(parser.isUsageOverviewLocation({ hostname: 'chatgpt.com', pathname: '/settings/usage', search: '?tab=overview' }), true);
  assert.equal(parser.isUsageOverviewLocation({ hostname: 'chatgpt.com', pathname: '/c/example', search: '' }), false);
  assert.equal(parser.isUsageOverviewLocation({ hostname: 'example.com', pathname: '/settings/usage', search: '?tab=overview' }), false);
});

test('页面无候选用量区域时返回空结果', () => {
  assert.deepEqual(parser.parseUsageBlocks([], { now: 1000 }), []);
});

test('聊天消息内即使嵌入限制字样也被容器层排除', () => {
  const fakeCandidate = {
    isConnected: true,
    hidden: false,
    getAttribute: () => null,
    getBoundingClientRect: () => ({ width: 300, height: 100 }),
    closest: (selector) => selector.includes('[data-message-author-role]') ? {} : null
  };
  const fakeRoot = { querySelectorAll: () => [fakeCandidate] };
  assert.deepEqual(parser.scanVisibleUsage(fakeRoot, { now: 1000 }), []);
});
