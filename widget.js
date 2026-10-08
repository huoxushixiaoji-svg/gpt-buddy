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

    const bubble = createElement(doc, 'div', 'buddy-bubble');
    bubble.setAttribute('role', 'status');
    bubble.setAttribute('aria-live', 'polite');

    const message = createElement(doc, 'p', 'buddy-message', '打开用量面板，让我看看。');
    const details = createElement(doc, 'div', 'buddy-details');
    details.hidden = true;

    const selectorLabel = createElement(doc, 'label', 'sr-only', '选择额度项目');
    const selector = createElement(doc, 'select', 'buddy-select');
    selector.id = 'gpt-buddy-usage-select';
    selectorLabel.htmlFor = selector.id;

    const valueLine = createElement(doc, 'div', 'detail-line detail-value', '暂无准确剩余额度');
    const resetLine = createElement(doc, 'div', 'detail-line');
    const capturedLine = createElement(doc, 'div', 'detail-line detail-muted');
    const sourceLine = createElement(doc, 'div', 'detail-line detail-muted');

    const scanButton = createElement(doc, 'button', 'bubble-button', '重新读取');
    scanButton.type = 'button';
    scanButton.setAttribute('aria-label', '重新读取当前页面中可见的用量区域');
    scanButton.addEventListener('click', () => options.onRescan());

    details.append(selectorLabel, selector, valueLine, resetLine, capturedLine, sourceLine, scanButton);
    bubble.append(message, details);

    const characterHit = createElement(doc, 'button', 'character-hit');
    characterHit.type = 'button';
    characterHit.setAttribute('aria-label', '展开或收起 GPT 小伙伴详情；右键打开菜单');

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

    frame.append(image, bubble, characterHit, menuButton, menu);
    shadow.append(frame);
    doc.documentElement.append(host);

    let settings = {
      visible: true,
      scale: 1,
      animationEnabled: true,
      position: null,
      ...(options.settings || {})
    };
    let items = [];
    let selectedKey = '';
    let expanded = false;
    let drag = null;
    let moved = false;
    let persistTimer = null;

    function itemKey(item) {
      return `${item.scope}::${item.bucketId}`;
    }

    function selectedItem() {
      return items.find((item) => itemKey(item) === selectedKey) || items[0] || null;
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
      selector.replaceChildren();
      for (const item of items) {
        const option = createElement(doc, 'option', '', item.label || '用量项目');
        option.value = itemKey(item);
        selector.append(option);
      }
      if (selectedItem()) {
        selectedKey = itemKey(selectedItem());
        selector.value = selectedKey;
      }
      selector.hidden = items.length < 2;

      const item = selectedItem();
      const now = Date.now();
      frame.dataset.state = NS.state.visualState(item, now);
      message.textContent = NS.state.messageFor(item, now);
      const safeValue = NS.state.safeCurrentValue(item, now);

      if (!item) {
        valueLine.textContent = '暂无准确剩余额度';
        resetLine.textContent = '';
        capturedLine.textContent = '尚未采集';
        sourceLine.textContent = '';
      } else {
        valueLine.textContent = safeValue.percent !== null
          ? `剩余 ${safeValue.percent}%`
          : safeValue.count !== null
            ? `剩余 ${safeValue.count}${item.unit ? ` ${item.unit}` : ''}`
            : '暂无准确剩余额度';
        resetLine.textContent = item.resetText ? `恢复：${item.resetText}` : '恢复时间：未知';
        const freshnessLabels = { fresh: '新近快照', stale: '过期快照', 'past-reset': '已超过恢复时间', unknown: '未知' };
        capturedLine.textContent = `采集：${NS.state.formatTime(item.capturedAt) || '未知'} · ${freshnessLabels[NS.state.freshnessFor(item, now)] || '未知'}`;
        sourceLine.textContent = `来源：${item.source || '未知'}`;
      }
    }

    function renderSettings() {
      host.hidden = settings.visible === false;
      host.style.setProperty('--buddy-scale', String(Math.min(1.35, Math.max(0.7, Number(settings.scale) || 1))));
      frame.classList.toggle('animations-on', settings.animationEnabled !== false);
      animation.textContent = settings.animationEnabled === false ? '开启动画' : '关闭动画';
      applyPosition(settings.position, false);
    }

    function setItems(nextItems) {
      const oldKey = selectedKey;
      items = Array.isArray(nextItems) ? nextItems.slice() : [];
      selectedKey = items.some((item) => itemKey(item) === oldKey) ? oldKey : (items[0] ? itemKey(items[0]) : '');
      renderDetails();
    }

    function setExpanded(value) {
      expanded = Boolean(value);
      details.hidden = !expanded;
      message.hidden = expanded;
      bubble.classList.toggle('is-expanded', expanded);
      characterHit.setAttribute('aria-expanded', String(expanded));
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

    selector.addEventListener('change', () => {
      selectedKey = selector.value;
      renderDetails();
    });
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
      else setExpanded(!expanded);
    });
    characterHit.addEventListener('pointercancel', () => { drag = null; });
    characterHit.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault(); setExpanded(!expanded);
      }
    });

    function updateSettings(patch) {
      settings = { ...settings, ...(patch || {}) };
      renderSettings();
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
        global.removeEventListener('resize', onResize);
        host.remove();
      }
    };
  }

  NS.widget = { createWidget };
})(typeof globalThis !== 'undefined' ? globalThis : this);
