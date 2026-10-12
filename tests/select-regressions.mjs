import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createEditorHarness } from './editor-harness.mjs';

let completed = 0;
const failures = [];
async function test(name, run) {
  try {
    await run();
    completed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    error.message = `${name}: ${error.message}`;
    failures.push(error);
    console.error(`  ✗ ${error.message}`);
  }
}

const publicLanguageKey = 'ascii-portrait-public-language-v1';
const legacyLanguageKey = 'ascii-portrait-language-v1';

await test('a fresh public editor starts in English', async () => {
  const { api, context, elements } = await createEditorHarness();
  assert.equal(api.getInitialLanguage(), 'en');
  assert.equal(context.document.documentElement.lang, 'en');
  assert.equal(elements.get('languageSelect').value, 'en');
  assert.equal(context.localStorage.getItem(publicLanguageKey), null,
    'The initial default must not pretend that the user chose a preference.');
});

await test('a legacy Chinese preference does not change the public English default', async () => {
  const { api, context, elements } = await createEditorHarness();
  context.localStorage.setItem(legacyLanguageKey, 'zh');
  assert.equal(api.getInitialLanguage(), 'en');
  api.applyLanguage(api.getInitialLanguage(), { persist: false });
  assert.equal(context.document.documentElement.lang, 'en');
  assert.equal(elements.get('languageSelect').value, 'en');
  assert.equal(context.localStorage.getItem(legacyLanguageKey), 'zh',
    'A separate application preference must not be destroyed.');
});

await test('only an explicit public preference restores Chinese', async () => {
  const { api, context, elements } = await createEditorHarness();
  context.localStorage.setItem(legacyLanguageKey, 'en');
  context.localStorage.setItem(publicLanguageKey, 'zh');
  assert.equal(api.getInitialLanguage(), 'zh');
  api.applyLanguage(api.getInitialLanguage(), { persist: false });
  assert.equal(context.document.documentElement.lang, 'zh-CN');
  assert.equal(elements.get('languageSelect').value, 'zh');
});

await test('public English and unknown preferences resolve to English', async () => {
  const { api, context } = await createEditorHarness();
  context.localStorage.setItem(legacyLanguageKey, 'zh');
  for (const value of ['en', 'invalid', '', 'ZH']) {
    context.localStorage.setItem(publicLanguageKey, value);
    assert.equal(api.getInitialLanguage(), 'en', `Unexpected language for ${JSON.stringify(value)}.`);
  }
});

await test('an explicit public language selection persists only to its own key', async () => {
  const { api, context, elements } = await createEditorHarness();
  context.localStorage.setItem(legacyLanguageKey, 'legacy-value');
  elements.get('languageSelect').value = 'zh';
  await elements.get('languageSelect').dispatch('change');
  assert.equal(context.localStorage.getItem(publicLanguageKey), 'zh');
  assert.equal(api.getInitialLanguage(), 'zh');
  elements.get('languageSelect').value = 'en';
  await elements.get('languageSelect').dispatch('change');
  assert.equal(context.localStorage.getItem(publicLanguageKey), 'en');
  assert.equal(context.localStorage.getItem(legacyLanguageKey), 'legacy-value');
});

await test('blocked preference storage leaves the editor usable in English', async () => {
  const { api, context } = await createEditorHarness();
  context.localStorage.getItem = () => { throw new Error('Storage blocked'); };
  context.localStorage.setItem = () => { throw new Error('Storage blocked'); };
  assert.equal(api.getInitialLanguage(), 'en');
  assert.doesNotThrow(() => api.applyLanguage('zh'));
  assert.equal(context.document.documentElement.lang, 'zh-CN');
});

await test('embed language overrides the public preference without changing it', async () => {
  for (const [query, expected] of [['zh-CN', 'zh'], ['en', 'en']]) {
    const { api, context } = await createEditorHarness({ search: `?embed=1&lang=${query}` });
    context.localStorage.setItem(publicLanguageKey, expected === 'zh' ? 'en' : 'zh');
    const before = context.localStorage.getItem(publicLanguageKey);
    assert.equal(api.getInitialLanguage(), expected);
    api.applyLanguage(expected);
    assert.equal(context.localStorage.getItem(publicLanguageKey), before);
  }
});

await test('non-embed language query does not override the explicit public choice', async () => {
  const { api, context } = await createEditorHarness({ search: '?lang=zh' });
  assert.equal(api.getInitialLanguage(), 'en');
  context.localStorage.setItem(publicLanguageKey, 'zh');
  assert.equal(api.getInitialLanguage(), 'zh');
});

const selectSource = await readFile(new URL('../studio-select.js', import.meta.url), 'utf8');

// This small DOM models select values, focus and event bubbling, not browser
// layout or screen-reader behavior. Responsive presentation remains a visual
// browser check. Explicit mutation delivery exercises the library observer
// callback without pretending to reproduce the browser's mutation scheduler.
function createSelectHarness(definitions = [{ id: 'levelsSelect', options: [
  { value: '0', text: '19 levels' }, { value: '1', text: '27 levels' }
] }]) {
  let document;
  const observers = [];
  class FakeEvent {
    constructor(type, options = {}) {
      this.type = type;
      this.bubbles = false;
      this.cancelable = true;
      this.defaultPrevented = false;
      this.propagationStopped = false;
      Object.assign(this, options);
    }
    preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
    stopPropagation() { this.propagationStopped = true; }
    composedPath() { return [...(this._path || [])]; }
  }
  class Element {
    constructor(tagName) {
      this.tagName = tagName.toUpperCase();
      this.nodeType = tagName === '#document' ? 9 : 1;
      this.id = '';
      this.name = '';
      this.children = [];
      this.parentElement = null;
      this.dataset = {};
      this.attributes = new Map();
      this.listeners = new Map();
      this.style = {};
      this.hidden = false;
      this.disabled = false;
      this.multiple = false;
      this.size = 0;
      this.labels = [];
      this.tabIndex = 0;
      this.scrollTop = 0;
      this._text = '';
      this._value = '';
      this._selectedIndex = -1;
      const classes = new Set();
      this.classList = {
        add: (...values) => values.forEach((value) => classes.add(value)),
        remove: (...values) => values.forEach((value) => classes.delete(value)),
        contains: (value) => classes.has(value),
        toggle: (value, enabled = !classes.has(value)) => {
          if (enabled) classes.add(value); else classes.delete(value);
          return enabled;
        }
      };
      Object.defineProperty(this, 'className', {
        get: () => [...classes].join(' '),
        set: (value) => { classes.clear(); value.split(/\s+/).filter(Boolean).forEach((name) => classes.add(name)); }
      });
    }
    get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
    set textContent(value) { this.replaceChildren(); this._text = String(value); }
    get label() { return this.attributes.get('label') ?? this.textContent; }
    set label(value) { this.attributes.set('label', String(value)); }
    get options() { return this.querySelectorAll('option'); }
    get selectedIndex() { return this._selectedIndex; }
    set selectedIndex(value) { this._selectedIndex = Number(value); }
    get value() { return this.tagName === 'SELECT' ? this.options[this.selectedIndex]?.value || '' : this._value; }
    set value(value) {
      if (this.tagName === 'SELECT') this.selectedIndex = this.options.findIndex((option) => option.value === String(value));
      else this._value = String(value);
    }
    get isConnected() { return document.contains(this); }
    get offsetTop() { return (this.parentElement?.children.indexOf(this) || 0) * 42; }
    get offsetHeight() { return 42; }
    get scrollHeight() { return this.children.length * 42 + 10; }
    get clientHeight() { return Math.min(this.scrollHeight, Number.parseFloat(this.style.maxHeight) || 320); }
    setAttribute(name, value) {
      const text = String(value);
      this.attributes.set(name, text);
      if (name === 'id') this.id = text;
      if (name === 'class') this.className = text;
      if (name.startsWith('data-')) {
        this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = text;
      }
    }
    getAttribute(name) {
      if (name === 'id') return this.id || null;
      if (name.startsWith('data-')) {
        return this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] ?? null;
      }
      return this.attributes.get(name) ?? null;
    }
    removeAttribute(name) { this.attributes.delete(name); }
    append(...children) {
      for (const child of children) {
        child.remove();
        child.parentElement = this;
        this.children.push(child);
      }
      if (this.tagName === 'SELECT' && this.selectedIndex < 0 && this.options.length) this.selectedIndex = 0;
    }
    after(child) {
      assert.ok(this.parentElement, 'Cannot insert a sibling without a parent.');
      child.remove();
      child.parentElement = this.parentElement;
      this.parentElement.children.splice(this.parentElement.children.indexOf(this) + 1, 0, child);
    }
    remove() {
      if (this.parentElement) {
        this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1);
        this.parentElement = null;
      }
    }
    replaceChildren(...children) {
      this.children.forEach((child) => { child.parentElement = null; });
      this.children = [];
      this._text = '';
      this.append(...children);
    }
    contains(element) { return element === this || this.children.some((child) => child.contains(element)); }
    matches(selector) {
      return selector.split(',').some((part) => {
        const query = part.trim();
        if (query === ':disabled') return this.disabled || Boolean(this.parentElement?.closest('fieldset')?.disabled);
        const attribute = query.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
        if (attribute) return this.getAttribute(attribute[1]) !== null &&
          (attribute[2] === undefined || this.getAttribute(attribute[1]) === attribute[2]);
        if (query.startsWith('.')) return this.classList.contains(query.slice(1));
        const simple = query.match(/^([a-z]+)?(?:#([\w-]+))?$/i);
        assert.ok(simple, `Unsupported fake DOM selector: ${query}`);
        return (!simple[1] || this.tagName === simple[1].toUpperCase()) && (!simple[2] || this.id === simple[2]);
      });
    }
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
    querySelectorAll(selector) {
      return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) || [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }
    dispatchEvent(event) {
      if (!event.target) event.target = this;
      // Browser event paths are fixed before dispatch, even if a listener
      // replaces or detaches the clicked node while the event is bubbling.
      const path = [];
      let current = this;
      while (current) {
        path.push(current);
        current = current.parentElement;
      }
      event._path = path;
      for (const current of path) {
        event.currentTarget = current;
        for (const listener of current.listeners.get(event.type) || []) listener.call(current, event);
        if (!event.bubbles || event.propagationStopped) break;
      }
      return !event.defaultPrevented;
    }
    focus() {
      document.activeElement = this;
      this.dispatchEvent(new FakeEvent('focusin', { bubbles: true }));
    }
    getBoundingClientRect() {
      const isPopup = this.id === 'studio-select-listbox';
      const left = Number.parseFloat(this.style.left) || 40;
      const top = Number.parseFloat(this.style.top) || 80;
      const width = Number.parseFloat(this.style.width) || 200;
      const height = isPopup ? this.clientHeight : 36;
      return { left, top, right: left + width, bottom: top + height, width, height };
    }
  }
  document = new Element('#document');
  document.body = new Element('body');
  document.append(document.body);
  document.activeElement = document.body;
  document.createElement = (tagName) => new Element(tagName);
  document.getElementById = (id) => document.querySelector(`#${id}`);
  const natives = new Map();
  const labels = new Map();
  function makeOption({ value, text, disabled = false, hidden = false, label }) {
    const option = new Element('option');
    option.value = value;
    option.textContent = text;
    option.disabled = disabled;
    option.hidden = hidden;
    if (label !== undefined) option.label = label;
    return option;
  }
  for (const definition of definitions) {
    const label = new Element('label');
    const native = new Element('select');
    native.id = definition.id;
    native.disabled = definition.disabled || false;
    native.setAttribute('aria-label', definition.label || definition.id);
    native.labels = [label];
    native.append(...definition.options.map(makeOption));
    if (definition.value !== undefined) native.value = definition.value;
    label.append(native);
    document.body.append(label);
    natives.set(native.id, native);
    labels.set(native.id, label);
  }
  const windowEvents = new Element('window');
  const context = vm.createContext({
    document, Element, Event: FakeEvent, Map, console, innerWidth: 1280, innerHeight: 800,
    addEventListener: (...args) => windowEvents.addEventListener(...args),
    MutationObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe(target) { this.target = target; }
    }
  });
  context.window = context;
  vm.runInContext(selectSource, context, { filename: 'studio-select.js', timeout: 5000 });
  assert.ok(context.StudioSelects, 'The dropdown module did not expose its public API.');
  context.StudioSelects.mount();
  const fire = (element, type, options = {}) => {
    const event = new FakeEvent(type, { bubbles: true, ...options });
    element.dispatchEvent(event);
    return event;
  };
  return {
    api: context.StudioSelects, context, document, natives, labels, makeOption,
    trigger: (id = definitions[0].id) => document.getElementById(`${id}-studio-trigger`),
    popup: () => document.getElementById('studio-select-listbox'),
    rows: () => document.querySelectorAll('[role="option"]'),
    row: (index) => document.querySelector(`[data-index="${index}"]`),
    click: (element) => fire(element, 'click'),
    key: (element, key, options = {}) => fire(element, 'keydown', { key, ...options }),
    fire,
    fireWindow(type, options = {}) { return fire(windowEvents, type, { target: context.window, ...options }); },
    notifyMutation(target) { observers.filter((observer) => observer.target.contains(target)).forEach((observer) => observer.callback([])); }
  };
}

await test('dropdown mounting is idempotent and preserves the native selection as its source of truth', () => {
  const h = createSelectHarness();
  const native = h.natives.get('levelsSelect');
  assert.equal(native.value, '0');
  assert.equal(native.hidden, true);
  assert.equal(native.tabIndex, -1);
  assert.equal(native.getAttribute('aria-hidden'), 'true');
  assert.equal(h.trigger().getAttribute('role'), 'combobox');
  assert.equal(h.trigger().getAttribute('aria-expanded'), 'false');
  assert.equal(h.trigger().getAttribute('aria-controls'), h.popup().id);
  assert.equal(h.trigger().querySelector('.studio-select-value-text').textContent, '19 levels');
  h.api.mount();
  h.api.mount(native);
  assert.equal(h.document.querySelectorAll('[role="combobox"]').length, 1);
  assert.equal(h.document.querySelectorAll('[role="listbox"]').length, 1);
});

for (const { name, definition, targetSelector } of [
  {
    name: 'value text', targetSelector: '.studio-select-value-text',
    definition: { id: 'levelsSelect', value: '1', options: [
      { value: '0', text: '19 levels' }, { value: '1', text: '27 levels' }
    ] }
  },
  {
    name: 'color swatch', targetSelector: '.studio-select-swatch',
    definition: { id: 'colorSelect', value: '2', options: [
      { value: '0', text: 'Original' }, { value: '2', text: 'Signal green' }
    ] }
  },
  {
    name: 'demo thumbnail', targetSelector: '.studio-select-thumbnail',
    definition: { id: 'demoSelect', value: 'astronaut', options: [
      { value: 'portrait', text: 'Human portrait' }, { value: 'astronaut', text: 'Astronaut' }
    ] }
  }
]) await test(`clicking the ${name} toggles once even when rendering detaches the click target`, () => {
  const h = createSelectHarness([definition]);
  const native = h.natives.get(definition.id);
  const trigger = h.trigger();
  const label = h.labels.get(definition.id);
  const clickedChild = trigger.querySelector(targetSelector);
  const events = [];
  let triggerClicks = 0;
  let labelClicks = 0;
  trigger.addEventListener('click', () => triggerClicks++);
  label.addEventListener('click', () => labelClicks++);
  for (const type of ['input', 'change']) {
    h.document.body.addEventListener(type, (event) => {
      if (event.target === native) events.push(type);
    });
  }

  const click = h.click(clickedChild);
  assert.equal(h.popup().hidden, false, 'The containing label must not immediately close the opened popup.');
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  assert.equal(triggerClicks, 1);
  assert.equal(labelClicks, 0, 'The trigger handles its own click without activating the label again.');
  assert.equal(clickedChild.isConnected, false, 'Opening must exercise the actual replaceChildren path.');
  assert.equal(click.target, clickedChild);
  assert.ok(click.composedPath().includes(trigger), 'Detaching the target must not alter the original event path.');
  assert.ok(click.composedPath().includes(label));
  assert.ok(click.composedPath().includes(h.document));
  assert.equal(click.defaultPrevented, true);
  assert.equal(native.value, definition.value);
  assert.equal(h.row(1).getAttribute('aria-selected'), 'true');
  assert.deepEqual(events, [], 'Opening a dropdown must preserve the selected value without emitting changes.');

  h.click(trigger.querySelector(targetSelector));
  assert.equal(h.popup().hidden, true, 'A second click must close once, not reopen through the label.');
  assert.equal(triggerClicks, 2);
  assert.equal(labelClicks, 0);
  assert.equal(native.value, definition.value);

  h.click(trigger.querySelector(targetSelector));
  h.click(h.row(0).querySelector('.studio-select-option-text'));
  assert.equal(native.value, definition.options[0].value);
  assert.deepEqual(events, ['input', 'change'], 'Native selection events must still bubble to application listeners.');
  assert.equal(h.popup().hidden, true);

  native.disabled = true;
  h.api.sync();
  h.click(trigger.querySelector(targetSelector));
  assert.equal(h.popup().hidden, true, 'Child clicks must not bypass disabled controls.');
  assert.deepEqual(events, ['input', 'change']);
});

await test('committing a new dropdown option emits exactly one input and one change', () => {
  const h = createSelectHarness();
  const native = h.natives.get('levelsSelect');
  const events = [];
  native.addEventListener('input', () => events.push('input'));
  native.addEventListener('change', () => events.push('change'));
  h.click(h.trigger());
  assert.equal(h.popup().hidden, false);
  h.click(h.row(1).querySelector('.studio-select-option-text'));
  assert.equal(native.value, '1');
  assert.deepEqual(events, ['input', 'change']);
  assert.equal(h.popup().hidden, true);
  assert.equal(h.document.activeElement, h.trigger());
  assert.equal(h.trigger().querySelector('.studio-select-value-text').textContent, '27 levels');
  h.click(h.trigger());
  h.click(h.row(1));
  assert.deepEqual(events, ['input', 'change'], 'Reselecting the current value must not cause duplicate work.');
});

await test('arrow keys only move the active option until Enter commits', () => {
  const h = createSelectHarness();
  const native = h.natives.get('levelsSelect');
  let changes = 0;
  native.addEventListener('change', () => changes++);
  h.key(h.trigger(), 'ArrowDown');
  assert.equal(native.value, '0');
  assert.equal(h.trigger().getAttribute('aria-activedescendant'), h.row(0).id);
  const arrow = h.key(h.trigger(), 'ArrowDown');
  assert.equal(arrow.defaultPrevented, true);
  assert.equal(h.trigger().getAttribute('aria-activedescendant'), h.row(1).id);
  assert.equal(h.row(1).getAttribute('aria-selected'), 'false', 'Highlighting is not selecting.');
  assert.equal(native.value, '0');
  assert.equal(changes, 0);
  h.key(h.trigger(), 'ArrowUp');
  assert.equal(h.trigger().getAttribute('aria-activedescendant'), h.row(0).id);
  h.key(h.trigger(), 'ArrowDown');
  h.key(h.trigger(), 'Enter');
  assert.equal(native.value, '1');
  assert.equal(changes, 1);
  assert.equal(h.trigger().getAttribute('aria-expanded'), 'false');
});

for (const action of ['Escape', 'Tab', 'outside']) await test(`${action} dismisses a pending option without committing`, () => {
  const h = createSelectHarness();
  const native = h.natives.get('levelsSelect');
  let changes = 0;
  native.addEventListener('change', () => changes++);
  h.click(h.trigger());
  h.key(h.trigger(), 'ArrowDown');
  const event = action === 'outside'
    ? h.fire(h.document.body, 'pointerdown', { pointerType: 'mouse' })
    : h.key(h.trigger(), action);
  assert.equal(h.popup().hidden, true);
  assert.equal(h.trigger().getAttribute('aria-expanded'), 'false');
  assert.equal(h.trigger().getAttribute('aria-activedescendant'), null);
  assert.equal(native.value, '0');
  assert.equal(changes, 0);
  if (action === 'Tab') assert.equal(event.defaultPrevented, false, 'Tab must still move browser focus.');
  if (action === 'Escape') assert.equal(h.document.activeElement, h.trigger());
});

await test('disabled and hidden options cannot be selected by pointer or keyboard', () => {
  const h = createSelectHarness([{ id: 'warpSelect', options: [
    { value: '0', text: 'Off' },
    { value: '1', text: 'Subtle', disabled: true },
    { value: '2', text: 'Defined', hidden: true },
    { value: '3', text: 'Extreme' }
  ] }]);
  const native = h.natives.get('warpSelect');
  let changes = 0;
  native.addEventListener('change', () => changes++);
  h.click(h.trigger());
  assert.equal(h.rows().length, 3);
  assert.equal(h.row(1).getAttribute('aria-disabled'), 'true');
  h.click(h.row(1));
  assert.equal(native.value, '0');
  assert.equal(changes, 0);
  h.key(h.trigger(), 'ArrowDown');
  assert.equal(h.trigger().getAttribute('aria-activedescendant'), h.row(3).id);
  h.key(h.trigger(), 'Enter');
  assert.equal(native.value, '3');
  assert.equal(changes, 1);
});

await test('disabled controls cannot open and becoming disabled dismisses an open popup', () => {
  const h = createSelectHarness([{ id: 'motionSelect', disabled: true, options: [
    { value: '0', text: 'Organic code' }, { value: '1', text: 'Particle glint' }
  ] }]);
  const native = h.natives.get('motionSelect');
  assert.equal(h.trigger().getAttribute('aria-disabled'), 'true');
  assert.equal(h.trigger().tabIndex, -1);
  h.click(h.trigger());
  h.key(h.trigger(), 'Enter');
  assert.equal(h.popup().hidden, true);
  native.disabled = false;
  h.notifyMutation(native);
  assert.equal(h.trigger().tabIndex, 0);
  h.click(h.trigger());
  assert.equal(h.popup().hidden, false);
  native.disabled = true;
  h.notifyMutation(native);
  assert.equal(h.popup().hidden, true);
  assert.equal(h.trigger().getAttribute('aria-disabled'), 'true');
  assert.equal(native.value, '0');
});

await test('translated names and option labels synchronize without changing the native value', () => {
  const h = createSelectHarness([{ id: 'backgroundSelect', label: 'Choose background mode', options: [
    { value: '0', text: 'Character field' }, { value: '1', text: 'Pure black' }
  ] }]);
  const native = h.natives.get('backgroundSelect');
  let changes = 0;
  native.addEventListener('change', () => changes++);
  h.click(h.trigger());
  native.setAttribute('aria-label', '选择背景模式');
  native.options[0].textContent = '字符背景';
  native.options[1].textContent = '纯黑';
  h.api.sync();
  assert.equal(h.trigger().getAttribute('aria-label'), '选择背景模式');
  assert.equal(h.popup().getAttribute('aria-label'), '选择背景模式');
  assert.equal(h.trigger().querySelector('.studio-select-value-text').textContent, '字符背景');
  assert.deepEqual(h.rows().map((row) => row.querySelector('.studio-select-option-text').textContent), ['字符背景', '纯黑']);
  assert.equal(native.value, '0');
  assert.equal(changes, 0);
});

await test('opening a second control closes the first and reuses exactly one popup', () => {
  const h = createSelectHarness([
    { id: 'levelsSelect', options: [{ value: '0', text: '19 levels' }, { value: '1', text: '27 levels' }] },
    { id: 'languageSelect', options: [{ value: 'en', text: 'English' }, { value: 'zh', text: '中文' }] }
  ]);
  h.click(h.trigger('levelsSelect'));
  h.key(h.trigger('levelsSelect'), 'ArrowDown');
  h.click(h.trigger('languageSelect'));
  assert.equal(h.trigger('levelsSelect').getAttribute('aria-expanded'), 'false');
  assert.equal(h.trigger('levelsSelect').getAttribute('aria-activedescendant'), null);
  assert.equal(h.trigger('languageSelect').getAttribute('aria-expanded'), 'true');
  assert.equal(h.natives.get('levelsSelect').value, '0');
  assert.equal(h.popup().dataset.control, 'languageSelect');
  assert.equal(h.document.querySelectorAll('[role="listbox"]').length, 1);
  h.api.close();
  assert.equal(h.popup().hidden, true);
});

await test('dynamic demo options appear with their previews and commit through the native select', () => {
  const h = createSelectHarness([{ id: 'demoSelect', label: 'Choose a demo image', options: [
    { value: '', text: 'Choose a subject' }
  ] }]);
  const native = h.natives.get('demoSelect');
  h.click(h.trigger());
  native.append(...[
    { value: 'portrait', text: 'Human portrait' },
    { value: 'astronaut', text: 'Astronaut' },
    { value: 'mecha', text: 'Mecha' }
  ].map(h.makeOption));
  h.notifyMutation(native);
  assert.equal(h.rows().length, 4);
  assert.equal(h.row(1).querySelector('img').src, './assets/demo-portrait.jpg');
  assert.equal(h.row(2).querySelector('img').src, './assets/demo-astronaut.jpg');
  assert.equal(h.row(3).querySelector('img').src, './assets/demo-mecha.jpg');
  let changes = 0;
  native.addEventListener('change', () => changes++);
  h.click(h.row(3));
  assert.equal(native.value, 'mecha');
  assert.equal(changes, 1);
  assert.equal(h.trigger().querySelector('.studio-select-value-text').textContent, 'Mecha');
  assert.equal(h.trigger().querySelector('img').src, './assets/demo-mecha.jpg');
});

await test('programmatic source changes synchronize the trigger without emitting a user change', () => {
  const h = createSelectHarness();
  const native = h.natives.get('levelsSelect');
  let changes = 0;
  native.addEventListener('change', () => changes++);
  native.value = '1';
  h.api.sync();
  assert.equal(h.trigger().querySelector('.studio-select-value-text').textContent, '27 levels');
  assert.equal(changes, 0);
});

await test('Home and End skip disabled boundaries and Space commits only the active option', () => {
  const h = createSelectHarness([{ id: 'motionSelect', value: '1', options: [
    { value: '0', text: 'Unavailable first', disabled: true },
    { value: '1', text: 'Organic code' },
    { value: '2', text: 'Particle glint' },
    { value: '3', text: 'Unavailable last', disabled: true }
  ] }]);
  const native = h.natives.get('motionSelect');
  let changes = 0;
  native.addEventListener('change', () => changes++);
  h.key(h.trigger(), 'End');
  assert.equal(h.trigger().getAttribute('aria-activedescendant'), h.row(2).id);
  assert.equal(native.value, '1');
  h.key(h.trigger(), ' ');
  assert.equal(native.value, '2');
  h.key(h.trigger(), 'Home');
  assert.equal(h.trigger().getAttribute('aria-activedescendant'), h.row(1).id);
  assert.equal(native.value, '2');
  h.key(h.trigger(), 'Enter');
  assert.equal(native.value, '1');
  assert.equal(changes, 2);
});

await test('typeahead highlights matching text without committing or accepting composition input', () => {
  const h = createSelectHarness([{ id: 'demoSelect', options: [
    { value: 'portrait', text: 'Human portrait' },
    { value: 'astronaut', text: 'Astronaut' },
    { value: 'mecha', text: 'Mecha' }
  ] }]);
  const native = h.natives.get('demoSelect');
  h.key(h.trigger(), 'a');
  h.key(h.trigger(), 's');
  assert.equal(h.trigger().getAttribute('aria-activedescendant'), h.row(1).id);
  assert.equal(native.value, 'portrait');
  h.key(h.trigger(), 'Enter', { isComposing: true });
  assert.equal(h.popup().hidden, false);
  assert.equal(native.value, 'portrait');
  h.key(h.trigger(), 'Enter');
  assert.equal(native.value, 'astronaut');
});

await test('disabled optgroups and fieldsets remain disabled in the enhanced control', () => {
  const h = createSelectHarness();
  const native = h.natives.get('levelsSelect');
  const group = h.document.createElement('optgroup');
  group.disabled = true;
  group.append(h.makeOption({ value: '2', text: 'Unavailable grouped value' }));
  native.append(group);
  h.api.sync();
  h.click(h.trigger());
  assert.equal(h.row(2).getAttribute('aria-disabled'), 'true');
  h.key(h.trigger(), 'End');
  assert.equal(h.trigger().getAttribute('aria-activedescendant'), h.row(1).id);
  h.click(h.row(2));
  assert.equal(native.value, '0');
  const fieldset = h.document.createElement('fieldset');
  fieldset.disabled = true;
  fieldset.append(h.labels.get('levelsSelect'));
  h.document.body.append(fieldset);
  h.api.sync();
  assert.equal(h.popup().hidden, true);
  assert.equal(h.trigger().getAttribute('aria-disabled'), 'true');
  h.click(h.trigger());
  assert.equal(h.popup().hidden, true);
});

await test('scroll inside the popup is safe while window scroll and resize dismiss it', () => {
  const h = createSelectHarness();
  h.click(h.trigger());
  h.fireWindow('scroll', { target: h.popup() });
  assert.equal(h.popup().hidden, false);
  assert.doesNotThrow(() => h.fireWindow('scroll'));
  assert.equal(h.popup().hidden, true);
  h.click(h.trigger());
  h.fireWindow('resize');
  assert.equal(h.popup().hidden, true);
  assert.equal(h.natives.get('levelsSelect').value, '0');
});

await test('label activation toggles once and moving focus outside cancels pending navigation', () => {
  const h = createSelectHarness();
  h.click(h.labels.get('levelsSelect'));
  assert.equal(h.popup().hidden, false);
  assert.equal(h.document.activeElement, h.trigger());
  h.click(h.labels.get('levelsSelect'));
  assert.equal(h.popup().hidden, true);
  h.click(h.trigger());
  assert.equal(h.popup().hidden, false, 'The containing label must not toggle the trigger a second time.');
  h.key(h.trigger(), 'ArrowDown');
  h.document.body.focus();
  assert.equal(h.popup().hidden, true);
  assert.equal(h.natives.get('levelsSelect').value, '0');
});

await test('held Enter and Space keys cannot repeat a commit or reopen the popup', () => {
  const h = createSelectHarness();
  const native = h.natives.get('levelsSelect');
  let changes = 0;
  native.addEventListener('change', () => changes++);
  h.key(h.trigger(), 'Enter');
  h.key(h.trigger(), 'ArrowDown');
  h.key(h.trigger(), 'Enter', { repeat: true });
  assert.equal(native.value, '0');
  assert.equal(changes, 0);
  h.key(h.trigger(), 'Enter');
  assert.equal(native.value, '1');
  assert.equal(changes, 1);
  h.key(h.trigger(), 'Enter', { repeat: true });
  h.key(h.trigger(), ' ', { repeat: true });
  assert.equal(h.popup().hidden, true);
  assert.equal(changes, 1);
});

await test('unsupported DOM capabilities leave the native-control fallback untouched', () => {
  for (const missing of ['closest', 'after', 'replaceChildren']) {
    let creations = 0;
    class UnsupportedElement {}
    for (const method of ['closest', 'after', 'replaceChildren']) {
      if (method !== missing) UnsupportedElement.prototype[method] = () => {};
    }
    const native = { hidden: false, tabIndex: 0, value: 'en' };
    const context = vm.createContext({
      Element: UnsupportedElement, Map,
      document: {
        body: {},
        createElement() { creations++; throw new Error('Unsupported enhancement must not create nodes.'); },
        querySelectorAll: () => [native]
      }
    });
    context.window = context;
    assert.doesNotThrow(() => vm.runInContext(selectSource, context));
    assert.equal(context.StudioSelects, undefined);
    assert.equal(creations, 0);
    assert.deepEqual(native, { hidden: false, tabIndex: 0, value: 'en' });
  }
});

if (failures.length) throw new AggregateError(failures, `${failures.length} select/language regression(s) failed.`);
console.log(`${completed} select and public-language regressions passed.`);
