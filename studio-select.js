/* Small, select-only comboboxes. Native selects remain the application state. */
(() => {
  'use strict';

  if (!document.createElement || !window.Map || !Element.prototype.closest ||
      !Element.prototype.after || !Element.prototype.replaceChildren) return;

  const selector = [
    'languageSelect', 'demoSelect', 'levelsSelect', 'warpSelect',
    'colorSelect', 'motionSelect', 'backgroundSelect', 'exportFormatSelect'
  ].map((id) => `select#${id}`).join(',');
  const instances = new Map();
  const demoImages = {
    portrait: './assets/demo-portrait.jpg',
    astronaut: './assets/demo-astronaut.jpg',
    mecha: './assets/demo-mecha.jpg'
  };
  const colorSwatches = ['original', 'mono', 'green', 'amber', 'blue'];
  let popup = null;
  let opened = null;
  let searchText = '';
  let searchTime = 0;

  function accessibleName(native) {
    const labelledBy = native.getAttribute('aria-labelledby');
    if (labelledBy) {
      const name = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ').trim();
      if (name) return name;
    }
    return native.getAttribute('aria-label') || native.name || native.id;
  }

  function isDisabled(native) {
    return native.disabled || native.matches(':disabled');
  }

  function optionsFor(instance) {
    return Array.from(instance.native.options).map((option, index) => ({
      element: option,
      index,
      text: option.label,
      value: option.value,
      disabled: option.disabled || (option.parentElement.tagName === 'OPTGROUP' && option.parentElement.disabled)
    })).filter((option) => !option.element.hidden);
  }

  function addPreview(container, instance, option) {
    if (!option) return;
    if (instance.native.id === 'colorSelect' && colorSwatches[Number(option.value)]) {
      const swatch = document.createElement('span');
      swatch.className = `studio-select-swatch studio-select-swatch--${colorSwatches[Number(option.value)]}`;
      swatch.setAttribute('aria-hidden', 'true');
      container.append(swatch);
    }
    if (instance.native.id === 'demoSelect' && demoImages[option.value]) {
      const thumbnail = document.createElement('img');
      thumbnail.className = 'studio-select-thumbnail';
      thumbnail.src = demoImages[option.value];
      thumbnail.alt = '';
      thumbnail.loading = 'lazy';
      thumbnail.decoding = 'async';
      thumbnail.draggable = false;
      container.append(thumbnail);
    }
  }

  function ensurePopup() {
    if (popup) return;
    popup = document.createElement('div');
    popup.id = 'studio-select-listbox';
    popup.className = 'studio-select-menu';
    popup.setAttribute('role', 'listbox');
    popup.hidden = true;
    document.body.append(popup);

    // Mouse selection must not move DOM focus away from the combobox.
    popup.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse' && event.target.closest('[role="option"]')) event.preventDefault();
    });
    popup.addEventListener('pointermove', (event) => {
      if (!opened || event.pointerType === 'touch') return;
      const row = event.target.closest('[role="option"]');
      if (row && row.getAttribute('aria-disabled') !== 'true') setActive(opened, Number(row.dataset.index), false);
    });
    popup.addEventListener('click', (event) => {
      const row = event.target.closest('[role="option"]');
      if (opened && row) commit(opened, Number(row.dataset.index));
    });
    document.addEventListener('pointerdown', (event) => {
      if (!opened || popup.contains(event.target) || opened.trigger.contains(event.target)) return;
      if (opened.labels.some((label) => label.contains(event.target))) return;
      close();
    });
    document.addEventListener('focusin', (event) => {
      if (opened && !opened.trigger.contains(event.target) && !popup.contains(event.target)) close();
    });
    window.addEventListener('resize', () => close(), { passive: true });
    window.addEventListener('scroll', (event) => {
      const insidePopup = event.target?.nodeType && popup.contains(event.target);
      if (opened && !insidePopup) close();
    }, { capture: true, passive: true });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', () => close(), { passive: true });
      window.visualViewport.addEventListener('scroll', () => close(), { passive: true });
    }
  }

  function syncInstance(instance) {
    const { native, trigger, value } = instance;
    instance.options = optionsFor(instance);
    instance.disabled = isDisabled(native);
    trigger.tabIndex = instance.disabled ? -1 : 0;
    trigger.setAttribute('aria-disabled', String(instance.disabled));
    trigger.setAttribute('aria-label', accessibleName(native));
    const description = native.getAttribute('aria-describedby');
    if (description) trigger.setAttribute('aria-describedby', description);
    else trigger.removeAttribute('aria-describedby');
    const selected = instance.options.find((option) => option.index === native.selectedIndex);
    value.replaceChildren();
    addPreview(value, instance, selected);
    const text = document.createElement('span');
    text.className = 'studio-select-value-text';
    text.textContent = selected?.text || '';
    value.append(text);
    if (opened === instance) {
      if (instance.disabled || !native.isConnected) close();
      else {
        if (!instance.options.some((option) => option.index === instance.activeIndex && !option.disabled)) {
          instance.activeIndex = firstEnabled(instance);
        }
        renderOptions(instance);
        positionPopup(instance);
        revealActive(instance);
      }
    }
  }

  function firstEnabled(instance, last = false) {
    const options = instance.options.filter((option) => !option.disabled);
    return (last ? options[options.length - 1] : options[0])?.index ?? -1;
  }

  function renderOptions(instance) {
    popup.replaceChildren();
    popup.setAttribute('aria-label', accessibleName(instance.native));
    popup.dataset.control = instance.native.id;
    instance.options.forEach((option) => {
      const row = document.createElement('div');
      row.id = `${instance.native.id}-studio-option-${option.index}`;
      row.className = 'studio-select-option';
      row.dataset.index = String(option.index);
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(option.index === instance.native.selectedIndex));
      row.setAttribute('aria-disabled', String(option.disabled));
      addPreview(row, instance, option);
      const label = document.createElement('span');
      label.className = 'studio-select-option-text';
      label.textContent = option.text;
      const check = document.createElement('span');
      check.className = 'studio-select-check';
      check.setAttribute('aria-hidden', 'true');
      row.append(label, check);
      popup.append(row);
    });
    setActive(instance, instance.activeIndex, false);
  }

  function positionPopup(instance) {
    if (opened !== instance) return;
    const rect = instance.trigger.getBoundingClientRect();
    const viewport = window.visualViewport;
    const leftEdge = viewport?.offsetLeft || 0;
    const topEdge = viewport?.offsetTop || 0;
    const viewportWidth = viewport?.width || window.innerWidth;
    const viewportHeight = viewport?.height || window.innerHeight;
    const margin = 10;
    const gap = 7;
    const preferredWidth = instance.native.id === 'languageSelect' ? 152 : 224;
    const width = Math.min(viewportWidth - margin * 2, Math.max(preferredWidth, rect.width));
    popup.style.width = `${Math.max(0, width)}px`;
    popup.style.maxHeight = '320px';
    const wantedHeight = Math.min(320, popup.scrollHeight);
    const roomBelow = Math.max(0, topEdge + viewportHeight - rect.bottom - gap - margin);
    const roomAbove = Math.max(0, rect.top - topEdge - gap - margin);
    const above = wantedHeight > roomBelow && roomAbove > roomBelow;
    popup.style.maxHeight = `${Math.min(320, above ? roomAbove : roomBelow)}px`;
    const height = popup.getBoundingClientRect().height;
    const left = Math.max(leftEdge + margin, Math.min(rect.left, leftEdge + viewportWidth - width - margin));
    const top = above ? rect.top - gap - height : rect.bottom + gap;
    popup.style.left = `${left}px`;
    popup.style.top = `${Math.max(topEdge + margin, Math.min(top, topEdge + viewportHeight - height - margin))}px`;
    popup.dataset.placement = above ? 'above' : 'below';
  }

  function revealActive(instance) {
    const row = popup.querySelector(`[data-index="${instance.activeIndex}"]`);
    if (!row) return;
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    if (top < popup.scrollTop + 5) popup.scrollTop = Math.max(0, top - 5);
    else if (bottom > popup.scrollTop + popup.clientHeight - 5) popup.scrollTop = bottom - popup.clientHeight + 5;
  }

  function setActive(instance, index, reveal = true) {
    instance.activeIndex = index;
    if (index < 0) instance.trigger.removeAttribute('aria-activedescendant');
    else instance.trigger.setAttribute('aria-activedescendant', `${instance.native.id}-studio-option-${index}`);
    popup.querySelectorAll('[role="option"]').forEach((row) => {
      row.classList.toggle('is-active', Number(row.dataset.index) === index);
    });
    if (reveal) revealActive(instance);
  }

  function open(instance, edge) {
    syncInstance(instance);
    if (instance.disabled || !instance.options.length) return;
    close();
    opened = instance;
    searchText = '';
    const selected = instance.options.find((option) => option.index === instance.native.selectedIndex && !option.disabled);
    instance.activeIndex = edge ? firstEnabled(instance, edge === 'last') : (selected?.index ?? firstEnabled(instance));
    popup.hidden = false;
    instance.trigger.setAttribute('aria-expanded', 'true');
    renderOptions(instance);
    positionPopup(instance);
    revealActive(instance);
  }

  function close(restoreFocus = false) {
    if (!opened) return;
    const instance = opened;
    opened = null;
    searchText = '';
    popup.hidden = true;
    instance.trigger.setAttribute('aria-expanded', 'false');
    instance.trigger.removeAttribute('aria-activedescendant');
    if (restoreFocus && !instance.disabled) instance.trigger.focus({ preventScroll: true });
  }

  function toggle(instance) {
    if (opened === instance) close();
    else open(instance);
  }

  function commit(instance, index) {
    const option = instance.options.find((candidate) => candidate.index === index);
    if (!option || option.disabled || isDisabled(instance.native)) return;
    const changed = instance.native.selectedIndex !== index;
    instance.native.selectedIndex = index;
    close(true);
    if (changed) {
      instance.native.dispatchEvent(new Event('input', { bubbles: true }));
      instance.native.dispatchEvent(new Event('change', { bubbles: true }));
    }
    syncInstance(instance);
  }

  function navigate(instance, direction) {
    const enabled = instance.options.filter((option) => !option.disabled);
    if (!enabled.length) return;
    const position = enabled.findIndex((option) => option.index === instance.activeIndex);
    const next = Math.max(0, Math.min(enabled.length - 1, position + direction));
    setActive(instance, enabled[next].index);
  }

  function typeahead(instance, character) {
    const now = Date.now();
    searchText = now - searchTime > 650 ? character : searchText + character;
    searchTime = now;
    const normalized = searchText.toLocaleLowerCase();
    const repeated = normalized.length > 1 && Array.from(normalized).every((letter) => letter === normalized[0]);
    const query = repeated ? normalized[0] : normalized;
    const enabled = instance.options.filter((option) => !option.disabled);
    const current = enabled.findIndex((option) => option.index === instance.activeIndex);
    const offset = query.length === 1 ? 1 : 0;
    for (let step = 0; step < enabled.length; step += 1) {
      const option = enabled[(Math.max(0, current) + offset + step) % enabled.length];
      if (option.text.trim().toLocaleLowerCase().startsWith(query)) {
        setActive(instance, option.index);
        break;
      }
    }
  }

  function keydown(instance, event) {
    if (instance.disabled || event.isComposing || event.ctrlKey || event.metaKey) return;
    const isOpen = opened === instance;
    if (event.key === 'Tab') {
      if (isOpen) close();
      return;
    }
    if (event.key === 'Escape') {
      if (isOpen) {
        event.preventDefault();
        event.stopPropagation();
        close(true);
      }
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (event.repeat) return;
      if (isOpen) commit(instance, instance.activeIndex);
      else open(instance);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!isOpen) open(instance);
      else navigate(instance, event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      if (!isOpen) open(instance, event.key === 'Home' ? 'first' : 'last');
      else setActive(instance, firstEnabled(instance, event.key === 'End'));
    } else if (event.key.length === 1 && !event.altKey) {
      event.preventDefault();
      if (!isOpen) open(instance);
      typeahead(instance, event.key);
    }
  }

  function mount(root = document) {
    if (!document.body) return;
    ensurePopup();
    const natives = Array.from(root.querySelectorAll(selector));
    if (root.matches?.(selector)) natives.unshift(root);
    natives.forEach((native) => {
      if (instances.has(native) || native.multiple || native.size > 1) return;
      const trigger = document.createElement('span');
      trigger.id = `${native.id}-studio-trigger`;
      trigger.className = 'studio-select-trigger';
      trigger.dataset.control = native.id;
      trigger.setAttribute('role', 'combobox');
      trigger.setAttribute('aria-haspopup', 'listbox');
      trigger.setAttribute('aria-controls', popup.id);
      trigger.setAttribute('aria-expanded', 'false');
      trigger.setAttribute('aria-autocomplete', 'none');
      const value = document.createElement('span');
      value.className = 'studio-select-value';
      const chevron = document.createElement('span');
      chevron.className = 'studio-select-chevron';
      chevron.setAttribute('aria-hidden', 'true');
      trigger.append(value, chevron);
      const instance = { native, trigger, value, labels: Array.from(native.labels || []), options: [], activeIndex: -1, disabled: false };
      instances.set(native, instance);
      native.after(trigger);
      native.hidden = true;
      native.tabIndex = -1;
      native.setAttribute('aria-hidden', 'true');
      native.dataset.studioNative = 'true';
      native.parentElement.dataset.studioEnhanced = 'true';
      trigger.addEventListener('click', (event) => {
        event.preventDefault();
        // Opening replaces value children; the label must not handle their
        // now-detached click target as a second, independent activation.
        event.stopPropagation();
        if (isDisabled(native)) return;
        trigger.focus({ preventScroll: true });
        toggle(instance);
      });
      trigger.addEventListener('keydown', (event) => keydown(instance, event));
      instance.labels.forEach((label) => label.addEventListener('click', (event) => {
        if (trigger.contains(event.target) || event.target === native) return;
        event.preventDefault();
        if (isDisabled(native)) return;
        trigger.focus({ preventScroll: true });
        toggle(instance);
      }));
      native.addEventListener('input', () => syncInstance(instance));
      native.addEventListener('change', () => syncInstance(instance));
      if (window.MutationObserver) {
        instance.observer = new MutationObserver(() => syncInstance(instance));
        instance.observer.observe(native, {
          childList: true, subtree: true, characterData: true, attributes: true,
          attributeFilter: ['disabled', 'hidden', 'label', 'value', 'selected', 'aria-label', 'aria-labelledby', 'aria-describedby']
        });
      }
      syncInstance(instance);
    });
  }

  window.StudioSelects = {
    mount,
    sync: () => instances.forEach(syncInstance),
    close: () => close()
  };
})();
