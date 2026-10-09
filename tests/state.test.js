"use strict";

const test = require('node:test');
const assert = require('node:assert/strict');
require('../parser.js');
const state = require('../state.js');
const { mergeSnapshotMaps, settingsForAutomaticReader } = require('../background.js');

function item(patch) {
  return {
    scope: 'chat', bucketId: 'short', label: 'Chat', remainingPercent: 35,
    remainingCount: null, unit: '', resetAt: null, resetText: '', capturedAt: 1_000,
    source: 'test', freshness: 'fresh', ...patch
  };
}

test('超过 15 分钟的快照标记为 stale 且不提供当前百分比', () => {
  const snapshot = item({ capturedAt: 1_000 });
  const now = 1_000 + state.DEFAULT_MAX_AGE_MS + 1;
  assert.equal(state.freshnessFor(snapshot, now), 'stale');
  assert.equal(state.safeCurrentValue(snapshot, now).percent, null);
  assert.equal(state.visualState(snapshot, now), 'neutral');
});

test('超过已知恢复时间后不会自动变为 100%', () => {
  const snapshot = item({ remainingPercent: 4, resetAt: 5_000 });
  assert.equal(state.freshnessFor(snapshot, 5_001), 'past-reset');
  assert.equal(state.safeCurrentValue(snapshot, 5_001).percent, null);
  assert.match(state.messageFor(snapshot, 5_001), /重新查看/);
});

test('只对新近且确定的恢复时间显示倒计时', () => {
  const now = 1_000_000;
  const snapshot = item({ capturedAt: now, resetAt: now + 2 * 3600000 + 23 * 60000 });
  assert.equal(state.resetTimeRemaining(snapshot, now), '2小时23分');
  assert.equal(state.resetTimeRemaining({ ...snapshot, resetAt: null }, now), '');
  assert.equal(state.resetTimeRemaining({ ...snapshot, observationStatus: 'history' }, now), '');
  assert.equal(state.resetTimeRemaining({ ...snapshot, updatePending: true }, now), '');
  assert.equal(state.resetTimeRemaining(snapshot, now + state.DEFAULT_MAX_AGE_MS + 1), '');
  assert.equal(state.resetTimeRemaining(snapshot, snapshot.resetAt), '');
});

test('页面相对时间文字未变时不将恢复时刻反复往后推', () => {
  const session = state.createSnapshotSession();
  const first = item({ capturedAt: 1_000_000, resetAt: 1_000_000 + 285 * 60000,
    resetText: '4 小时 45 分钟后重置', resetTimeSource: 'relative' });
  session.read([first]);
  const later = { ...first, capturedAt: first.capturedAt + 60_000, resetAt: first.resetAt + 60_000 };
  assert.equal(session.read([later]).items[0].resetAt, first.resetAt);
  assert.equal(session.read([later], { manual: true }).items[0].resetAt, first.resetAt);
  session.leave();
  assert.equal(session.read([later]).items[0].resetAt, later.resetAt);
});

test('升级时自动启用后台读取，之后尊重用户关闭选择', () => {
  assert.equal(settingsForAutomaticReader(null).backgroundRefreshEnabled, true);
  const migrated = settingsForAutomaticReader({ visible: false, backgroundRefreshEnabled: false });
  assert.equal(migrated.visible, false);
  assert.equal(migrated.backgroundRefreshEnabled, true);
  assert.equal(migrated.backgroundRefreshConfigured, true);
  const disabled = settingsForAutomaticReader({ ...migrated, backgroundRefreshEnabled: false });
  assert.equal(disabled.backgroundRefreshEnabled, false);
});

test('未知数据采用中性状态', () => {
  assert.equal(state.visualState(null, 1_000), 'neutral');
  assert.match(state.messageFor(null, 1_000), /打开用量面板/);
});

test('旧标签页快照不能覆盖新快照', () => {
  const current = { 'chat::short': item({ capturedAt: 9_000, remainingPercent: 20 }) };
  const merged = mergeSnapshotMaps(current, [item({ capturedAt: 8_000, remainingPercent: 80 })]);
  assert.equal(merged['chat::short'].remainingPercent, 20);
  const updated = mergeSnapshotMaps(merged, [item({ capturedAt: 10_000, remainingPercent: 15 })]);
  assert.equal(updated['chat::short'].remainingPercent, 15);
});

test('离开用量页或空扫描保留历史值及时间；重新采集后才更新', () => {
  const session = state.createSnapshotSession();
  const first = session.read([item()]);
  assert.equal(first.changed.length, 1);
  const unchanged = session.read([item({ capturedAt: 5000 })]);
  assert.equal(unchanged.changed.length, 0);
  assert.equal(unchanged.items[0].capturedAt, 1000);
  session.leave();
  const history = session.read([]).items[0];
  assert.equal(history.remainingPercent, 35);
  assert.equal(history.capturedAt, 1000);
  assert.equal(history.observationStatus, 'history');
  assert.equal(state.visualState(history, 6000), 'neutral');
  assert.equal(session.read([item({ capturedAt: 7000 })]).items[0].capturedAt, 7000);
});

test('清除会话后不复用旧身份；后台未知账号快照不驱动角色状态', () => {
  const session = state.createSnapshotSession();
  session.read([item()]); session.clear();
  assert.deepEqual(session.read([]).items, []);
  assert.equal(state.visualState(item({ remainingPercent: 0, observationStatus: 'background' }), 1000), 'neutral');
});
