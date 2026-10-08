(function initWidget(global) {
  "use strict";

  const NS = (global.GPTBuddy = global.GPTBuddy || {});

  function createElement(documentRef, tag, className, text) {
    const element = documentRef.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function createWidget(options) {
    const doc = global.document;
    const host = createElement(doc, 'div');
    host.id = 'gpt-buddy-host';
    host.setAttribute('data-gpt-buddy-root', '');
    const shadow = host.attachShadow({ mode: options.shadowMode === 'open' ? 'open' : 'closed' });

    const style = createElement(doc, 'style');
    style.textContent = options.styles || '';
    shadow.append(style);

    const frame = createElement(doc, 'section', 'buddy-frame');
    frame.setAttribute('aria-label', 'GPT 小伙伴用量挂件');
    frame.dataset.state = 'neutral';

    const image = createElement(doc, 'img', 'buddy-character');
    image.src = options.imageUrl;
    image.alt = '';
    image.draggable = false;

    const visual = createElement(doc, 'div', 'buddy-visual');

    const bubble = createElement(doc, 'div', 'buddy-bubble');
    bubble.setAttribute('role', 'status');
    bubble.setAttribute('aria-live', 'polite');

    const details = createElement(doc, 'div', 'buddy-details');

    const viewLine = createElement(doc, 'div', 'detail-line detail-view');
    const valueLine = createElement(doc, 'div', 'detail-line detail-value', '暂无准确剩余额度');
    const resetLine = createElement(doc, 'div', 'detail-line');
    const cardLine = createElement(doc, 'div', 'detail-line');
    details.append(viewLine, valueLine, resetLine, cardLine);
    bubble.append(details);

    const characterHit = createElement(doc, 'button', 'character-hit');
    characterHit.type = 'button';
    characterHit.setAttribute('aria-label', '切换 5 小时与周额度，角色弹一下；右键打开菜单');

    const menuButton = createElement(doc, 'button', 'menu-trigger', '⋯');
    menuButton.type = 'button';
    menuButton.setAttribute('aria-label', '打开 GPT 小伙伴菜单');
    menuButton.setAttribute('aria-haspopup', 'menu');
    menuButton.setAttribute('aria-expanded', 'false');

    const menu = createElement(doc, 'div', 'buddy-menu');
    menu.hidden = true;
    menu.setAttribute('role', 'menu');

    const menuScan = createElement(doc, 'button', '', '重新读取当前页面');
    const smaller = createElement(doc, 'button', '', '缩小挂件');
    const larger = createElement(doc, 'button', '', '放大挂件');
    const animation = createElement(doc, 'button', '', '关闭动画');
    const clear = createElement(doc, 'button', '', '清除本地用量数据');
    const hide = createElement(doc, 'button', 'danger', '隐藏挂件');
    for (const button of [menuScan, smaller, larger, animation, clear, hide]) {
      button.type = 'button';
      button.setAttribute('role', 'menuitem');
      menu.append(button);
    }

    visual.append(image, bubble);
    frame.append(visual, characterHit, menuButton, menu);
    shadow.append(frame);
    doc.documentElement.append(host);

    let settings = {
      visible: true,
      scale: 1,
      animationEnabled: true,
      selectedQuotaKind: 'five-hour',
      position: null,
      ...(options.settings || {})
    };
    let items = [];
    let drag = null;
    let moved = false;
    let persistTimer = null;
    let squashTimer = null;

    function selectedItem() {
      const matching = items.filter((item) => item.quotaKind === settings.selectedQuotaKind);
      matching.sort((left, right) => {
        const rank = (item) => item.observationStatus === 'visible' ? 2 : item.observationStatus === 'background' ? 1 : 0;
        return rank(right) - rank(left) || Number(right.capturedAt || 0) - Number(left.capturedAt || 0);
      });
      return matching[0] || null;
    }

    function clampPosition(position) {
      const rect = host.getBoundingClientRect();
      const width = rect.width || 420 * Number(settings.scale || 1);
      const height = rect.height || 420 * Number(settings.scale || 1);
      const maxX = Math.max(8, global.innerWidth - Math.min(width, global.innerWidth - 8));
      const maxY = Math.max(8, global.innerHeight - Math.min(height, global.innerHeight - 8));
      return {
        x: Math.min(Math.max(8, Number(position && position.x) || maxX - 16), maxX),
        y: Math.min(Math.max(8, Number(position && position.y) || maxY - 80), maxY)
      };
    }

    function applyPosition(position, persist) {
      const next = clampPosition(position);
      settings.position = next;
      host.style.left = `${Math.round(next.x)}px`;
      host.style.top = `${Math.round(next.y)}px`;
      if (persist) {
        global.clearTimeout(persistTimer);
        persistTimer = global.setTimeout(() => options.onSettingsChange({ position: next }), 120);
      }
    }

    function renderDetails() {
      const kind = settings.selectedQuotaKind === 'weekly' ? 'weekly' : 'five-hour';
      viewLine.textContent = kind === 'weekly' ? '周额度 · 点击角色切换' : '5 小时额度 · 点击角色切换';
      const item = selectedItem();
      const now = Date.now();
      frame.dataset.state = NS.state.visualState(item, now);
      if (!item) {
        valueLine.textContent = '余额：暂无准确数据';
        resetLine.textContent = '';
        cardLine.textContent = kind === 'weekly' ? '余额重置卡：暂无数据' : '';
      } else {
        const pending = NS.state.freshnessFor(item, now) !== 'fresh' || item.observationStatus === 'history' || item.updatePending;
        const value = Number.isFinite(item.remainingPercent) ? `${item.remainingPercent}%`
          : Number.isFinite(item.remainingCount) ? `${item.remainingCount}${item.unit ? ` ${item.unit}` : ''}`
          : '暂无准确数据';
        valueLine.textContent = `${pending ? '上次余额' : '余额'}：${value}`;
        if (pending) valueLine.append(createElement(doc, 'small', 'pending-badge', '待更新'));
        const validResetText = item.resetText ? NS.parser.parseResetText(`重置：${item.resetText}`) : '';
        resetLine.textContent = validResetText ? `重置：${validResetText}` : '';
        cardLine.textContent = kind === 'weekly'
          ? `余额重置卡：${Number.isSafeInteger(item.resetCardCount) && item.resetCardCount >= 0 ? `${item.resetCardCount} 次` : '暂无数据'}`
          : '';
      }
      resetLine.title = resetLine.textContent;
    }

    function renderSettings() {
      host.hidden = settings.visible === false;
      host.style.setProperty('--buddy-scale', String(Math.min(1.35, Math.max(0.7, Number(settings.scale) || 1))));
      frame.classList.toggle('animations-on', settings.animationEnabled !== false);
      animation.textContent = settings.animationEnabled === false ? '开启动画' : '关闭动画';
      applyPosition(settings.position, false);
    }

    function setItems(nextItems) {
      items = (Array.isArray(nextItems) ? nextItems : []).map((item) => ({
        ...item, quotaKind: item.quotaKind || NS.parser.quotaKindForLabel(item.label)
      })).filter((item) => item.quotaKind === 'five-hour' || item.quotaKind === 'weekly');
      renderDetails();
    }

    function switchQuota() {
      settings.selectedQuotaKind = settings.selectedQuotaKind === 'weekly' ? 'five-hour' : 'weekly';
      renderDetails();
      options.onSettingsChange({ selectedQuotaKind: settings.selectedQuotaKind });
      playSquash();
    }

    function playSquash() {
      if (settings.animationEnabled === false) return;
      global.clearTimeout(squashTimer);
      frame.classList.remove('is-squashing');
      void frame.offsetWidth;
      frame.classList.add('is-squashing');
      squashTimer = global.setTimeout(() => frame.classList.remove('is-squashing'), 520);
    }

    function setMenu(value, anchor) {
      const open = Boolean(value);
      menu.hidden = !open;
      menuButton.setAttribute('aria-expanded', String(open));
      if (open) {
        if (anchor) {
          const hostRect = host.getBoundingClientRect();
          menu.style.left = `${Math.max(0, Math.min(anchor.clientX - hostRect.left, hostRect.width - 170))}px`;
          menu.style.top = `${Math.max(0, Math.min(anchor.clientY - hostRect.top, hostRect.height - 240))}px`;
        } else {
          menu.style.removeProperty('left');
          menu.style.removeProperty('top');
        }
        menu.querySelector('button').focus({ preventScroll: true });
      }
    }

    menuButton.addEventListener('click', () => setMenu(menu.hidden));
    characterHit.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      setMenu(true, event);
    });
    menu.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        setMenu(false);
        characterHit.focus({ preventScroll: true });
      }
    });
    shadow.addEventListener('focusout', () => {
      global.setTimeout(() => {
        if (!shadow.activeElement) setMenu(false);
      }, 0);
    });

    menuScan.addEventListener('click', () => { setMenu(false); options.onRescan(); });
    smaller.addEventListener('click', () => {
      const scale = Math.max(0.7, Math.round((Number(settings.scale) - 0.1) * 10) / 10);
      updateSettings({ scale }); options.onSettingsChange({ scale });
    });
    larger.addEventListener('click', () => {
      const scale = Math.min(1.35, Math.round((Number(settings.scale) + 0.1) * 10) / 10);
      updateSettings({ scale }); options.onSettingsChange({ scale });
    });
    animation.addEventListener('click', () => {
      const animationEnabled = settings.animationEnabled === false;
      updateSettings({ animationEnabled }); options.onSettingsChange({ animationEnabled });
    });
    clear.addEventListener('click', () => { setMenu(false); options.onClear(); });
    hide.addEventListener('click', () => {
      setMenu(false); updateSettings({ visible: false }); options.onSettingsChange({ visible: false });
    });

    characterHit.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      const position = clampPosition(settings.position);
      drag = { id: event.pointerId, startX: event.clientX, startY: event.clientY, x: position.x, y: position.y };
      moved = false;
      characterHit.setPointerCapture(event.pointerId);
    });
    characterHit.addEventListener('pointermove', (event) => {
      if (!drag || drag.id !== event.pointerId) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (Math.hypot(dx, dy) > 6) moved = true;
      if (moved) applyPosition({ x: drag.x + dx, y: drag.y + dy }, false);
    });
    characterHit.addEventListener('pointerup', (event) => {
      if (!drag || drag.id !== event.pointerId) return;
      characterHit.releasePointerCapture(event.pointerId);
      drag = null;
      if (moved) applyPosition(settings.position, true);
      else {
        switchQuota();
      }
    });
    characterHit.addEventListener('pointercancel', () => { drag = null; });
    characterHit.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault(); switchQuota();
      }
    });

    function updateSettings(patch) {
      settings = { ...settings, ...(patch || {}) };
      renderSettings();
      renderDetails();
    }

    function onResize() {
      applyPosition(settings.position, true);
    }
    global.addEventListener('resize', onResize, { passive: true });
    const refreshTimer = global.setInterval(renderDetails, 60 * 1000);

    renderSettings();
    renderDetails();

    return {
      setItems,
      updateSettings,
      destroy() {
        global.clearInterval(refreshTimer);
        global.clearTimeout(persistTimer);
        global.clearTimeout(squashTimer);
        global.removeEventListener('resize', onResize);
        host.remove();
      }
    };
  }

  NS.widget = { createWidget };
})(typeof globalThis !== 'undefined' ? globalThis : this);
