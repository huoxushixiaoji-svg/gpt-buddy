'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function worker(initialSettings) {
  const values = initialSettings ? { settings: structuredClone(initialSettings) } : {};
  const calls = { restore: 0, enabled: [] };
  let installed;
  let messageListener;
  const reader = {
    async restore() { calls.restore += 1; },
    async captureFor() { return null; },
    async setEnabled(enabled) { calls.enabled.push(enabled); }
  };
  const chrome = {
    storage: { local: {
      async get(keys) {
        return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, values[key]]));
      },
      async set(patch) { Object.assign(values, patch); }
    } },
    alarms: { onAlarm: { addListener() {} } },
    tabs: { onRemoved: { addListener() {} } },
    runtime: {
      onStartup: { addListener() {} },
      onInstalled: { addListener(listener) { installed = listener; } },
      onMessage: { addListener(listener) { messageListener = listener; } }
    }
  };
  const context = { chrome, importScripts() { context.GPTBuddyReader = { createReader: () => reader }; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8'), context);
  function send(message) {
    return new Promise((resolve) => messageListener(message, { tab: { id: 1 }, frameId: 0 }, resolve));
  }
  return { values, calls, installed, send };
}

test('升级时自动启动读取，用户关闭后不会在下一次页面启动时重启', async () => {
  const app = worker({ visible: false, backgroundRefreshEnabled: false });
  app.installed();
  const first = await app.send({ type: 'GET_STATE', contextKey: 'test' });
  assert.equal(first.settings.backgroundRefreshEnabled, true);
  assert.equal(first.settings.visible, false);
  assert.ok(app.calls.restore >= 1);
  const disabled = await app.send({ type: 'UPDATE_SETTINGS', patch: { backgroundRefreshEnabled: false } });
  assert.equal(disabled.settings.backgroundRefreshEnabled, false);
  assert.deepEqual(app.calls.enabled, [false]);
  const again = await app.send({ type: 'GET_STATE', contextKey: 'test' });
  assert.equal(again.settings.backgroundRefreshEnabled, false);
});
