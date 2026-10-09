'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createReader, POLL_ALARM, DEADLINE_ALARM, sanitizeItems } = require('../reader.js');

const URL_USAGE = 'https://chatgpt.com/settings/usage?tab=overview';
const ITEM = { scope: 'work-codex', bucketId: 'weekly', label: 'Weekly', remainingPercent: 35, remainingCount: null, resetAt: null, resetText: '18:30' };

function storageArea() {
  const values = {};
  return {
    values,
    async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, structuredClone(values[key])])); },
    async set(items) { Object.assign(values, structuredClone(items)); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key]; }
  };
}

function setup() {
  let current = 1_000_000;
  let serial = 0;
  let nextTab = 1;
  const tabs = new Map();
  const alarms = new Map();
  const effects = [];
  const api = {
    storage: { local: storageArea(), session: storageArea() },
    tabs: {
      async create(options) { const tab = { id: nextTab++, ...options }; tabs.set(tab.id, tab); effects.push(['create', tab.id, options.active]); return tab; },
      async get(id) { if (!tabs.has(id)) throw new Error('missing-tab'); return { ...tabs.get(id) }; },
      async update(id, patch) { Object.assign(tabs.get(id), patch); effects.push(['update', id, patch]); return { ...tabs.get(id) }; },
      async reload(id) { effects.push(['reload', id]); },
      async remove(id) { effects.push(['remove', id]); tabs.delete(id); }
    },
    alarms: {
      async create(name, options) { alarms.set(name, options); },
      async clear(name) { return alarms.delete(name); },
      async get(name) { return alarms.get(name); }
    }
  };
  api.storage.local.values.settings = { backgroundRefreshEnabled: true };
  const newReader = () => createReader(api, () => current, () => `capture-${++serial}`);
  const sender = (doc = 'doc-1') => ({ tab: { id: api.storage.session.values.usageReaderRuntime.tabId }, frameId: 0, url: URL_USAGE, documentId: doc });
  return { api, tabs, alarms, effects, newReader, sender, advance(ms) { current += ms; } };
}

test('开启只创建一个非活动后台页，处理中不会重复创建或刷新', async () => {
  const f = setup(); const reader = f.newReader();
  await reader.setEnabled(true); await reader.poll();
  assert.deepEqual(f.effects, [['create', 1, false]]);
  assert.equal(f.tabs.get(1).pinned, true);
  assert.equal(f.alarms.get(POLL_ALARM).periodInMinutes, 0.5);
});

test('升级前已有的后台页在下一轮缩成固定标签', async () => {
  const f = setup(); const reader = f.newReader();
  await reader.setEnabled(true);
  const first = await reader.captureFor(f.sender());
  await reader.accept({ ...first, items: [ITEM] }, f.sender());
  f.tabs.get(1).pinned = false;
  f.api.storage.session.values.usageReaderRuntime.pinnedAttempted = false;
  f.advance(60_000); await reader.poll();
  assert.equal(f.tabs.get(1).pinned, true);
  assert.equal(f.effects.filter(([type]) => type === 'update').length, 1);
});

test('旧版一分钟闹钟在恢复时更新为三十秒', async () => {
  const f = setup(); const reader = f.newReader();
  f.alarms.set(POLL_ALARM, { periodInMinutes: 1 });
  await reader.restore();
  assert.equal(f.alarms.get(POLL_ALARM).periodInMinutes, 0.5);
});

test('休眠后实例从 session 恢复；旧文档和旧请求不能覆盖新结果', async () => {
  const f = setup(); let reader = f.newReader();
  await reader.setEnabled(true);
  const first = await reader.captureFor(f.sender());
  await reader.accept({ ...first, items: [ITEM] }, f.sender());
  const time = f.api.storage.local.values.backgroundUsage.lastSuccessAt;
  reader = f.newReader();
  await reader.restore();
  assert.equal(f.effects.filter(([type]) => type === 'create').length, 1);
  f.advance(60_000); await reader.alarm(POLL_ALARM);
  assert.equal((await reader.accept({ ...first, items: [{ ...ITEM, remainingPercent: 90 }] }, f.sender())).ok, false);
  assert.equal(await reader.captureFor(f.sender()), null);
  const second = await reader.captureFor(f.sender('doc-2'));
  await reader.accept({ ...second, items: [{ ...ITEM, remainingPercent: 20 }] }, f.sender('doc-2'));
  assert.equal(f.api.storage.local.values.backgroundUsage.items[0].remainingPercent, 20);
  assert.ok(f.api.storage.local.values.backgroundUsage.lastSuccessAt > time);
});

test('无法读取和登录跳转保留原数据与采集时间，不伪造满额', async () => {
  const f = setup(); const reader = f.newReader();
  await reader.setEnabled(true);
  const capture = await reader.captureFor(f.sender());
  await reader.accept({ ...capture, items: [ITEM] }, f.sender());
  const previous = structuredClone(f.api.storage.local.values.backgroundUsage.items);
  f.advance(60_000); await reader.poll();
  f.advance(45_000); await reader.alarm(DEADLINE_ALARM);
  assert.equal(f.api.storage.local.values.backgroundUsage.status, 'unrecognized');
  assert.deepEqual(f.api.storage.local.values.backgroundUsage.items, previous);
  await reader.poll();
  f.tabs.get(1).url = 'https://chatgpt.com/auth/login';
  await reader.alarm(DEADLINE_ALARM);
  assert.equal(f.api.storage.local.values.backgroundUsage.status, 'page-unavailable');
  assert.deepEqual(f.api.storage.local.values.backgroundUsage.items, previous);
  await reader.poll(); await reader.poll();
  assert.equal(f.effects.filter(([type]) => type === 'create').length, 1);
  f.tabs.get(1).url = undefined; // An auth host outside permitted URLs.
  await reader.poll();
  assert.equal(f.effects.filter(([type]) => type === 'create').length, 1);
});

test('用户正在看后台页时不刷新，导航离开后也不夺回该标签页', async () => {
  const f = setup(); const reader = f.newReader();
  await reader.setEnabled(true);
  const capture = await reader.captureFor(f.sender());
  await reader.accept({ ...capture, items: [ITEM] }, f.sender());
  f.tabs.get(1).active = true;
  await reader.poll();
  assert.equal(f.api.storage.local.values.backgroundUsage.status, 'waiting-active');
  assert.equal(f.effects.filter(([type]) => type === 'reload').length, 0);
  f.tabs.get(1).url = 'https://chatgpt.com/';
  await reader.poll();
  assert.deepEqual(f.effects, [['create', 1, false], ['create', 2, false]]);
});

test('关闭后台页即停止更新；关闭开关后不接收迟到结果', async () => {
  const f = setup(); const reader = f.newReader();
  await reader.setEnabled(true);
  const sender = f.sender(); const capture = await reader.captureFor(sender);
  f.tabs.delete(1); await reader.tabRemoved(1);
  assert.equal(f.api.storage.local.values.settings.backgroundRefreshEnabled, false);
  assert.equal(f.alarms.size, 0);
  assert.equal((await reader.accept({ ...capture, items: [ITEM] }, sender)).ok, false);
  await reader.poll();
  assert.equal(f.effects.length, 1);
});

test('每轮只保存该页完整快照，不混合前一工作区的窗口', async () => {
  const f = setup(); const reader = f.newReader();
  await reader.setEnabled(true);
  const first = await reader.captureFor(f.sender());
  await reader.accept({ ...first, items: [ITEM, { ...ITEM, bucketId: 'short' }] }, f.sender());
  f.advance(60_000); await reader.poll();
  const second = await reader.captureFor(f.sender('doc-2'));
  await reader.accept({ ...second, items: [{ ...ITEM, scope: 'chat', bucketId: 'chat' }] }, f.sender('doc-2'));
  assert.equal(f.api.storage.local.values.backgroundUsage.items.length, 1);
  assert.equal(f.api.storage.local.values.backgroundUsage.items[0].scope, 'chat');
});

test('新浏览器会话不使用过期 tab ID；清除结果不可被迟到读取复活', async () => {
  const f = setup(); const reader = f.newReader();
  await reader.setEnabled(true);
  const sender = f.sender(); const capture = await reader.captureFor(sender);
  await reader.accept({ ...capture, items: [ITEM] }, sender);
  await f.api.storage.session.remove('usageReaderRuntime');
  await f.newReader().restore();
  assert.equal(f.api.storage.session.values.usageReaderRuntime.tabId, 2);
  f.api.storage.local.values.settings.backgroundRefreshEnabled = false;
  await reader.stop('off', true);
  await reader.accept({ ...capture, items: [ITEM] }, sender);
  assert.deepEqual(f.api.storage.local.values.backgroundUsage.items, []);
});

test('空值不会转成零，负数、超限、未知字段不进入快照', () => {
  const [item] = sanitizeItems([{ ...ITEM, remainingPercent: 300, remainingCount: -1, token: 'not-copied' }], 100);
  assert.equal(item.remainingPercent, null); assert.equal(item.remainingCount, null);
  assert.equal(item.resetAt, null); assert.equal('token' in item, false);
  assert.equal(item.capturedAt, 100);
});
