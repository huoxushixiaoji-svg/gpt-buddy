'use strict';
// Independent UI/adapter tests. Uses system Chromium; no real ChatGPT account,
// unpacked extension policy override, or private endpoint is involved.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createReader } = require('../reader.js');
const root = path.resolve(__dirname, '..');
const mime = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png' };

(async () => {
  const server = http.createServer(async (req, res) => {
    const target = path.resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
    if (!target.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    try { const data = await fs.readFile(target); res.writeHead(200, { 'Content-Type': mime[path.extname(target)] || 'text/plain' }); res.end(data); }
    catch { res.writeHead(404).end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser;
  const errors = [];
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true,
      args: ['--no-sandbox', '--disable-crash-reporter', '--disable-breakpad'] });
    const overview = await browser.newPage();
    overview.on('pageerror', (err) => errors.push(String(err)));
    await overview.goto(base + '/tests/usage-overview-harness.html');
    await overview.waitForSelector('html[data-ready=true]');
    assert.deepEqual(await overview.evaluate(() => testUsageItems.map((item) => [item.quotaKind, item.remainingPercent, item.resetCardCount])),
      [['five-hour', 68, null], ['weekly', 65, 1]]);
    const originalFiveHourId = await overview.evaluate(() => testUsageItems.find((item) => item.quotaKind === 'five-hour').bucketId);
    const updatedFiveHour = await overview.evaluate(() => {
      document.querySelector('#five-hour-reading').textContent = '5 小时额度 剩余 51%';
      return GPTBuddy.parser.scanVisibleUsage(document, {
        now: Date.now(), location: { hostname: 'chatgpt.com', pathname: '/settings/usage', search: '?tab=overview' }
      }).find((item) => item.quotaKind === 'five-hour');
    });
    assert.equal(updatedFiveHour.bucketId, originalFiveHourId);
    assert.equal(updatedFiveHour.remainingPercent, 51);
    const relativeWindows = await overview.evaluate(() => {
      const cards = document.querySelectorAll('article');
      cards[0].querySelectorAll('div')[1].textContent = '4 小时 45 分钟后重置';
      cards[1].querySelectorAll('div')[1].textContent = '5 天 1 小时后重置';
      const now = 1_000_000;
      return GPTBuddy.parser.scanVisibleUsage(document, {
        now, location: { hostname: 'chatgpt.com', pathname: '/settings/usage', search: '?tab=overview' }
      }).map((item) => [item.quotaKind, item.resetText, item.resetAt - now]);
    });
    assert.deepEqual(relativeWindows, [
      ['five-hour', '4 小时 45 分钟后重置', 285 * 60000],
      ['weekly', '5 天 1 小时后重置', 121 * 3600000]
    ]);
    const resetOnlyWindows = await overview.evaluate(() => {
      document.querySelectorAll('article')[0].querySelectorAll('div')[0].textContent = '5 小时限额';
      document.querySelectorAll('article')[1].querySelectorAll('div')[0].textContent = '每周限额';
      return GPTBuddy.parser.scanVisibleUsage(document, {
        now: 1_000_000, location: { hostname: 'chatgpt.com', pathname: '/settings/usage', search: '?tab=overview' }
      }).map((item) => [item.quotaKind, item.remainingPercent, item.resetText]);
    });
    assert.deepEqual(resetOnlyWindows, [
      ['five-hour', null, '4 小时 45 分钟后重置'],
      ['weekly', null, '5 天 1 小时后重置']
    ], JSON.stringify(resetOnlyWindows));
    const splitReset = await overview.evaluate(() => {
      document.querySelectorAll('article')[0].querySelectorAll('div')[1].innerHTML = '<span>4 小时 </span><span>45 分钟后重置</span>';
      return GPTBuddy.parser.scanVisibleUsage(document, {
        now: 1_000_000, location: { hostname: 'chatgpt.com', pathname: '/settings/usage', search: '?tab=overview' }
      }).find((item) => item.quotaKind === 'five-hour')?.resetText;
    });
    assert.equal(splitReset, '4 小时 45 分钟后重置');
    const zeroResetAllowance = await overview.evaluate(() => {
      document.querySelector('#reset-allowance').textContent = '0';
      return GPTBuddy.parser.scanVisibleUsage(document, {
        now: Date.now(), location: { hostname: 'chatgpt.com', pathname: '/settings/usage', search: '?tab=overview' }
      });
    });
    assert.equal(zeroResetAllowance.length, 2);
    assert.equal(zeroResetAllowance.find((item) => item.quotaKind === 'weekly').resetCardCount, 0);
    const cardWithoutWeeklyBalance = await overview.evaluate(() => {
      document.querySelectorAll('article')[1].remove();
      return GPTBuddy.parser.scanVisibleUsage(document, {
        now: Date.now(), location: { hostname: 'chatgpt.com', pathname: '/settings/usage', search: '?tab=overview' }
      }).find((item) => item.quotaKind === 'weekly');
    });
    assert.equal(cardWithoutWeeklyBalance.remainingPercent, null);
    assert.equal(cardWithoutWeeklyBalance.resetCardCount, 0);
    const flatResetLayout = await overview.evaluate(() => {
      const section = document.querySelector('section[aria-label="使用限额重置"]');
      section.replaceWith(...section.childNodes);
      return GPTBuddy.parser.scanVisibleUsage(document, {
        now: Date.now(), location: { hostname: 'chatgpt.com', pathname: '/settings/usage', search: '?tab=overview' }
      });
    });
    assert.equal(flatResetLayout.find((item) => item.quotaKind === 'weekly').resetCardCount, 0);
    await overview.close();
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    page.on('pageerror', (err) => errors.push(String(err)));
    await page.goto(base + '/tests/content-harness.html');
    await page.waitForSelector('html[data-ready=true]');
    const value = page.locator('#gpt-buddy-host .detail-value');
    assert.match(await value.textContent(), /35%/);
    const captured = await page.evaluate(() => testMessages.find((m) => m.type === 'UPSERT_SNAPSHOTS').items[0].capturedAt);
    await page.evaluate(() => { document.querySelector('[role=alert]').remove(); history.pushState({}, '', '/c/test'); });
    await page.waitForFunction(() => document.querySelector('#gpt-buddy-host').shadowRoot.querySelector('.detail-value').textContent.includes('待更新'));
    assert.match(await value.textContent(), /上次余额：35%/);
    assert.equal(await page.locator('#gpt-buddy-host').count(), 1);
    await page.evaluate(() => __GPT_BUDDY_CONTROLLER__.scan());
    assert.equal(await page.evaluate(() => testMessages.filter((m) => m.type === 'UPSERT_SNAPSHOTS').at(-1).items[0].capturedAt), captured);
    await page.locator('#gpt-buddy-host .character-hit').click();
    assert.equal(await page.evaluate(() => testMessages.filter((m) => m.type === 'REFRESH_BACKGROUND').length), 0);
    await page.locator('#gpt-buddy-host .character-hit').click();

    const snapshot = { scope: 'work-codex', bucketId: 'five-hour', label: '5 hour', quotaKind: 'five-hour', remainingPercent: 62, remainingCount: null,
      resetText: '18:30', resetAt: null, capturedAt: Date.now(), source: 'test-source' };
    await page.evaluate((item) => emitStorageChange({ settings: { newValue: { backgroundRefreshEnabled: true } },
      backgroundUsage: { newValue: { status: 'ok', items: [item] } } }), snapshot);
    assert.match(await value.textContent(), /余额：62%/);
    await page.locator('#gpt-buddy-host .character-hit').click();
    await page.waitForFunction(() => testMessages.some((message) => message.type === 'REFRESH_BACKGROUND'));
    assert.equal(await page.evaluate(() => testMessages.filter((m) => m.type === 'REFRESH_BACKGROUND').length), 1);
    await page.locator('#gpt-buddy-host .character-hit').click();
    assert.match(await value.textContent(), /余额：62%/);
    let bubble = await page.locator('#gpt-buddy-host .buddy-bubble').textContent();
    assert.equal(/采集|来源|test-source|新近快照/.test(bubble), false);
    await page.evaluate((item) => emitStorageChange({ backgroundUsage: { newValue: { status: 'ok', items: [item] } } }), { ...snapshot, capturedAt: Date.now() - 16 * 60_000 });
    assert.match(await value.textContent(), /上次余额：62%.*待更新/);
    await page.evaluate(() => emitStorageChange({ settings: { newValue: { backgroundRefreshEnabled: false } }, backgroundUsage: { newValue: { status: 'off', items: [] } }, clearEpoch: { newValue: 'cleared' } }));
    assert.match(await value.textContent(), /暂无准确数据/);
    await page.route(base + '/tests/no-data.html', async (route) => route.fulfill({ contentType: 'text/html',
      body: (await fs.readFile(path.join(root, 'tests/content-harness.html'), 'utf8')).replace(/<div role="alert"[\s\S]*?<\/div>/, '') }));
    await page.goto(base + '/tests/no-data.html');
    await page.waitForSelector('html[data-ready=true]');
    assert.match(await value.textContent(), /暂无准确数据/);
    // Simulate a page returning from the browser back/forward cache.
    await page.evaluate(() => {
      dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
      dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    await page.waitForSelector('#gpt-buddy-host');
    assert.equal(await page.locator('#gpt-buddy-host').count(), 1);

    // Connect an isolated reader document to the actual reader coordinator and
    // broadcast its storage writes to the chat fixture. Browser APIs are mocked.
    const data = { settings: { backgroundRefreshEnabled: true } };
    const session = {};
    const makeStorage = (values, broadcast) => ({
      async get(key) { return { [key]: structuredClone(values[key]) }; },
      async set(patch) {
        Object.assign(values, structuredClone(patch));
        if (broadcast) await page.evaluate((items) => emitStorageChange(Object.fromEntries(Object.entries(items).map(([key, newValue]) => [key, { newValue }]))), patch);
      },
      async remove(key) { delete values[key]; }
    });
    const fakeAPI = {
      storage: { local: makeStorage(data, true), session: makeStorage(session, false) },
      tabs: { async create(options) { return { id: 1, ...options }; }, async get() { return { id: 1, active: false, url: 'https://chatgpt.com/settings/usage?tab=overview' }; } },
      alarms: { async create() {}, async clear() {} }
    };
    const reader = createReader(fakeAPI, Date.now, () => 'browser-capture');
    await page.evaluate(() => emitStorageChange({ settings: { newValue: { backgroundRefreshEnabled: true } } }));
    await reader.setEnabled(true);
    const sourcePage = await browser.newPage();
    sourcePage.on('pageerror', (err) => errors.push(String(err)));
    const sender = { tab: { id: 1 }, frameId: 0, documentId: 'browser-reader', url: 'https://chatgpt.com/settings/usage?tab=overview' };
    let captureLookups = 0;
    await sourcePage.exposeFunction('sendToWorker', async (message) => {
      if (message.type === 'GET_STATE') return { ok: true, settings: data.settings, backgroundUsage: data.backgroundUsage,
        backgroundCapture: ++captureLookups < 3 ? null : await reader.captureFor(sender) };
      if (message.type === 'READER_RESULT') return reader.accept(message, sender);
      return { ok: true };
    });
    await sourcePage.addInitScript(() => {
      Object.defineProperty(document, 'hidden', { get: () => true });
      window.chrome = { runtime: { getURL: (p) => 'https://chatgpt.com/' + p, sendMessage: (m) => window.sendToWorker(m),
        onMessage: { addListener() {}, removeListener() {} } }, storage: { onChanged: { addListener() {}, removeListener() {} } } };
    });
    await sourcePage.route('https://chatgpt.com/**', async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/settings/usage') {
        await route.fulfill({ contentType: 'text/html', body: '<main><h1>Usage</h1><section><h2>Codex</h2><article><h3>5 hour limit</h3><div id="reading">68% left</div><div>Resets 18:30</div></article><article><h3>Weekly limit</h3><div>35% used</div><div>Resets Friday 10:00</div></article><section><h3>使用限额重置</h3><p>使用一次重置，即可恢复你的 5 小时限额、每周限额，或同时恢复两者</p><div>可用 <span id="reset-allowance-source">2</span> 历史记录</div><div>完全重置（每周 + 5 小时）</div><div>将于 11 月 7 日 GMT+8 05:25 到期</div></section></section></main><script src="/parser.js"></script><script src="/state.js"></script><script src="/widget.js"></script><script src="/content.js"></script>' });
      } else {
        const target = path.join(root, pathname);
        try { await route.fulfill({ body: await fs.readFile(target), contentType: mime[path.extname(target)] || 'text/plain' }); }
        catch { await route.fulfill({ status: 404, body: '' }); }
      }
    });
    await sourcePage.goto(sender.url);
    await page.waitForFunction(() => document.querySelector('#gpt-buddy-host').shadowRoot.querySelector('.detail-value').textContent.includes('68%'));
    assert.ok(captureLookups >= 3);
    assert.equal(data.backgroundUsage.status, 'ok');
    // Updating only a text node must trigger a debounced rescan.
    await sourcePage.evaluate(() => { document.querySelector('#reading').firstChild.nodeValue = '52% left'; });
    await page.waitForFunction(() => document.querySelector('#gpt-buddy-host').shadowRoot.querySelector('.detail-value').textContent.includes('52%'));
    assert.equal(data.backgroundUsage.items[0].remainingPercent, 52);
    assert.match(await page.locator('#gpt-buddy-host .detail-line').nth(2).textContent(), /18:30/);
    await sourcePage.evaluate(() => { document.querySelector('#reset-allowance-source').firstChild.nodeValue = '1'; });
    await page.locator('#gpt-buddy-host .character-hit').click();
    await page.waitForFunction(() => document.querySelector('#gpt-buddy-host').shadowRoot.querySelector('.buddy-bubble').textContent.includes('限额重置次数：1 次'));
    assert.match(await value.textContent(), /65%/);
    await page.locator('#gpt-buddy-host .character-hit').click();
    await sourcePage.evaluate(() => {
      const main = document.querySelector('main'); const copy = main.cloneNode(true);
      main.remove(); copy.querySelector('#reading').textContent = '41% left'; document.body.append(copy);
    });
    await page.waitForFunction(() => document.querySelector('#gpt-buddy-host').shadowRoot.querySelector('.detail-value').textContent.includes('41%'));
    const sourceItems = data.backgroundUsage.items;
    assert.deepEqual(sourceItems.map((item) => item.quotaKind).sort(), ['five-hour', 'weekly']);
    assert.equal(sourceItems.find((item) => item.quotaKind === 'weekly').resetCardCount, 1);

    const popup = await browser.newPage({ viewport: { width: 360, height: 740 } });
    popup.on('pageerror', (err) => errors.push(String(err)));
    await popup.addInitScript(() => {
      let settings = { visible: true, scale: 1, animationEnabled: true, backgroundRefreshEnabled: false };
      const listeners = new Set();
      window.chrome = {
        runtime: { lastError: null, async sendMessage(m) {
          if (m.type === 'GET_STATE') return { ok: true, settings, backgroundUsage: { status: 'off', items: [] } };
          if (m.type === 'UPDATE_SETTINGS') {
            settings = { ...settings, ...m.patch };
            listeners.forEach((cb) => cb({ settings: { newValue: settings }, backgroundUsage: { newValue: { status: settings.backgroundRefreshEnabled ? 'loading' : 'off' } } }, 'local'));
          }
          return { ok: true, settings };
        } },
        storage: { onChanged: { addListener(cb) { listeners.add(cb); } } },
        tabs: { query: (q, cb) => cb([{ id: 99 }]), sendMessage: (id, m, cb) => cb({ ok: true, version: '0.4.4' }) }
      };
    });
    await popup.goto(base + '/popup.html');
    await popup.locator('#background').click();
    assert.equal(await popup.locator('#background').getAttribute('aria-pressed'), 'true');
    assert.equal(await popup.locator('#refresh-background').isVisible(), true);
    assert.match(await popup.locator('#reader-status').textContent(), /正在读取/);
    await popup.locator('#background').click();
    assert.equal(await popup.locator('#background').getAttribute('aria-pressed'), 'false');

    const ui = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    ui.on('pageerror', (err) => errors.push(String(err)));
    await ui.goto(base + '/tests/widget-harness.html');
    await ui.waitForSelector('html[data-ready=true]');
    await ui.evaluate(() => testWidget.updateSettings({ animationEnabled: true }));
    const hit = ui.locator('#gpt-buddy-host .character-hit');
    assert.equal((await ui.locator('#gpt-buddy-host .buddy-bubble').textContent()).includes('点击角色切换'), false);
    assert.match(await ui.locator('#gpt-buddy-host .buddy-bubble').textContent(), /5 小时额度.*68%/);
    assert.equal((await ui.locator('#gpt-buddy-host .buddy-bubble').textContent()).includes('还剩：'), false);
    await hit.click();
    assert.match(await ui.locator('#gpt-buddy-host .buddy-bubble').textContent(), /周额度.*31%.*还剩：.*限额重置次数：2 次/);
    const bubbleLayout = await ui.locator('#gpt-buddy-host .buddy-bubble').evaluate((bubbleElement) => {
      const bubbleRect = bubbleElement.getBoundingClientRect();
      const detailsElement = bubbleElement.querySelector('.buddy-details');
      const detailsRect = detailsElement.getBoundingClientRect();
      return { inside: detailsRect.left >= bubbleRect.left && detailsRect.right <= bubbleRect.right
        && detailsRect.top >= bubbleRect.top && detailsRect.bottom <= bubbleRect.bottom,
      scrollHeight: detailsElement.scrollHeight, clientHeight: detailsElement.clientHeight,
      overflow: getComputedStyle(detailsElement).overflowY };
    });
    assert.equal(bubbleLayout.inside, true);
    assert.equal(bubbleLayout.overflow, 'visible');
    assert.ok(bubbleLayout.scrollHeight - bubbleLayout.clientHeight <= 2, JSON.stringify(bubbleLayout));
    await ui.evaluate(() => {
      const now = Date.now();
      testWidget.setItems([
        { scope: 'chat', bucketId: 'short', label: '5 小时额度', quotaKind: 'five-hour', remainingPercent: 68,
          remainingCount: null, unit: '', resetAt: now + 285 * 60000, resetText: '4 小时 45 分钟后重置',
          resetTimeSource: 'relative', capturedAt: now },
        { scope: 'work-codex', bucketId: 'week', label: '周额度', quotaKind: 'weekly', remainingPercent: 31,
          resetCardCount: 2, remainingCount: null, unit: '', resetAt: now + 121 * 3600000,
          resetText: '5 天 1 小时后重置', resetTimeSource: 'relative', capturedAt: now }
      ]);
    });
    assert.match(await ui.locator('#gpt-buddy-host .buddy-bubble').textContent(), /周额度.*31%.*约还剩：.*限额重置次数：2 次/);
    assert.equal(await ui.locator('#gpt-buddy-host .buddy-bubble').evaluate((bubbleElement) => {
      const details = bubbleElement.querySelector('.buddy-details');
      return getComputedStyle(details).overflowY === 'visible'
        && details.getBoundingClientRect().bottom <= bubbleElement.getBoundingClientRect().bottom;
    }), true);
    await ui.waitForTimeout(160);
    assert.notEqual(await ui.locator('#gpt-buddy-host .buddy-visual').evaluate((el) => getComputedStyle(el).transform), 'none');
    await ui.waitForTimeout(420);
    assert.equal(await ui.locator('#gpt-buddy-host .buddy-visual').evaluate((el) => getComputedStyle(el).transform), 'none');
    await ui.screenshot({ path: '/tmp/gpt-buddy-v0.4.4-weekly.png' });
    const beforeDrag = await ui.locator('#gpt-buddy-host .buddy-bubble').textContent();
    const hitBox = await hit.boundingBox();
    await ui.mouse.move(hitBox.x + hitBox.width / 2, hitBox.y + hitBox.height / 2);
    await ui.mouse.down();
    await ui.mouse.move(hitBox.x + hitBox.width / 2 + 22, hitBox.y + hitBox.height / 2 + 10, { steps: 5 });
    await ui.mouse.up();
    assert.equal(await ui.locator('#gpt-buddy-host .buddy-bubble').textContent(), beforeDrag);
    await hit.focus();
    await ui.keyboard.press('Enter');
    assert.match(await ui.locator('#gpt-buddy-host .buddy-bubble').textContent(), /5 小时额度.*68%/);
    bubble = await ui.locator('#gpt-buddy-host .buddy-bubble').textContent();
    assert.equal(/采集|来源|新近快照|重新读取/.test(bubble), false);
    await ui.screenshot({ path: '/tmp/gpt-buddy-v0.4.4-ui.png' });
    await hit.click({ button: 'right' });
    assert.equal(await ui.locator('#gpt-buddy-host .buddy-menu').isVisible(), true);
    await ui.keyboard.press('Escape');
    await ui.setViewportSize({ width: 640, height: 520 });
    await ui.waitForFunction(() => { const rect = document.querySelector('#gpt-buddy-host').getBoundingClientRect(); return rect.right <= innerWidth && rect.bottom <= innerHeight; });
    const box = await ui.locator('#gpt-buddy-host').boundingBox();
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 640 && box.y + box.height <= 520);
    await ui.evaluate(() => testWidget.updateSettings({ visible: false }));
    assert.equal(await ui.locator('#gpt-buddy-host').isVisible(), false);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
  assert.deepEqual(errors, []);
  console.log('Browser checks passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
