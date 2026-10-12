import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const editorUrl = new URL('../index.html', import.meta.url);

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export async function flushMicrotasks() {
  for (let index = 0; index < 16; index++) await Promise.resolve();
}

// These fakes exercise application state and browser event ordering, not pixels,
// layout, GPU behavior, or browser codec support. They deliberately do not claim
// to replace a real-browser visual/performance test.
export async function createEditorHarness({ width = 1920, height = 1080, dpr = 2,
  search = '', reducedMotion = false, bitmapDecoder, fetch: fetchOverride } = {}) {
  const html = await readFile(editorUrl, 'utf8');
  const elements = new Map();
  const canvases = [];
  const frames = new Map();
  const timers = new Map();
  const localValues = new Map();
  const warnings = [];
  let nextTaskId = 1;
  let now = 0;

  class Element {
    constructor(tagName = 'div', id = '') {
      this.tagName = tagName.toUpperCase();
      this.id = id;
      this.value = '';
      this.textContent = '';
      this.dataset = {};
      this.disabled = false;
      this.hidden = false;
      this.style = { setProperty(name, value) { this[name] = value; } };
      this.attributes = new Map();
      this.listeners = new Map();
      this.children = [];
      const classes = new Set();
      this.classList = {
        contains: (value) => classes.has(value),
        add: (...values) => values.forEach((value) => classes.add(value)),
        remove: (...values) => values.forEach((value) => classes.delete(value)),
        toggle: (value, enabled = !classes.has(value)) => {
          if (enabled) classes.add(value); else classes.delete(value);
          return enabled;
        }
      };
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    addEventListener(type, callback) {
      const list = this.listeners.get(type) || [];
      list.push(callback);
      this.listeners.set(type, list);
    }
    removeEventListener(type, callback) {
      this.listeners.set(type, (this.listeners.get(type) || []).filter((fn) => fn !== callback));
    }
    async dispatch(type, event = {}) {
      return Promise.all((this.listeners.get(type) || []).map((fn) => fn({
        type, target: this, preventDefault() {}, ...event
      })));
    }
    append(...children) { this.children.push(...children); }
    appendChild(child) { this.children.push(child); return child; }
    replaceChildren(...children) { this.children = children; }
    querySelectorAll(selector) {
      const attribute = selector.match(/^\[data-([a-z-]+)\]$/)?.[1];
      assert.ok(attribute, `Unexpected descendant query: ${selector}`);
      const key = attribute.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
      return this.children.flatMap((child) => [
        ...(Object.hasOwn(child.dataset, key) ? [child] : []),
        ...child.querySelectorAll(selector)
      ]);
    }
    focus() {}
    click() { return this.dispatch('click'); }
    getBoundingClientRect() {
      if (this.id === 'controlPanel') return {
        left: context.innerWidth > 740 ? context.innerWidth - 382 : 10,
        top: context.innerWidth > 740 ? 18 : Math.max(0, context.innerHeight * 0.48 - 10),
        width: 364, height: 520
      };
      return { left: 0, top: 0, width: context.innerWidth, height: context.innerHeight };
    }
  }

  function createCanvas(id = '') {
    const canvas = new Element('canvas', id);
    canvas.width = 300;
    canvas.height = 150;
    const draws = [];
    const clears = [];
    const drawing = {
      canvas, draws, clears,
      clearRect(...args) { clears.push(args); }, fillRect() {}, fillText() {}, setTransform() {},
      resetTransform() {}, save() {}, restore() {}, translate() {}, scale() {},
      drawImage(...args) { draws.push(args); },
      getImageData(_x, _y, pixelWidth, pixelHeight) {
        const data = new Uint8ClampedArray(pixelWidth * pixelHeight * 4);
        for (let index = 0; index < data.length; index += 4) {
          data[index] = 128; data[index + 1] = 100;
          data[index + 2] = 80; data[index + 3] = 255;
        }
        return { width: pixelWidth, height: pixelHeight, data };
      },
      createImageData(pixelWidth, pixelHeight) {
        return { width: pixelWidth, height: pixelHeight,
          data: new Uint8ClampedArray(pixelWidth * pixelHeight * 4) };
      },
      putImageData() {}
    };
    canvas.getContext = (kind) => kind === '2d' ? drawing : null;
    canvas.toBlob = (callback, type = 'image/png') => callback(new Blob(['pixels'], { type }));
    canvases.push(canvas);
    return canvas;
  }

  for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"[^>]*>/gi)) {
    const [, tagName, id] = match;
    const element = tagName === 'canvas' ? createCanvas(id) : new Element(tagName, id);
    element.value = match[0].match(/\bvalue="([^"]*)"/)?.[1] || '';
    element.hidden = /\shidden(?:\s|>|=)/.test(match[0]);
    element.disabled = /\sdisabled(?:\s|>|=)/.test(match[0]);
    for (const attribute of match[0].matchAll(/\b([a-z][a-z-]*)="([^"]*)"/gi)) {
      element.setAttribute(attribute[1], attribute[2]);
      if (attribute[1].startsWith('data-')) {
        const key = attribute[1].slice(5).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
        element.dataset[key] = attribute[2];
      }
      if (attribute[1] === 'class') element.classList.add(...attribute[2].split(/\s+/));
    }
    elements.set(id, element);
  }
  const document = new Element('document');
  document.hidden = false;
  document.title = '';
  document.documentElement = new Element('html');
  document.head = new Element('head');
  document.body = new Element('body');
  document.querySelector = (selector) => {
    assert.ok(selector.startsWith('#'), `Unexpected query: ${selector}`);
    return elements.get(selector.slice(1)) || null;
  };
  document.querySelectorAll = () => [];
  document.createElement = (tagName) => tagName === 'canvas' ? createCanvas() : new Element(tagName);
  const location = new URL(`https://studio.example/index.html${search}`);
  const logs = { warn: (...values) => warnings.push(values), error: (...values) => warnings.push(values), log() {} };
  class FakeImage {
    constructor() { this.width = 1000; this.height = 1000; }
    set src(value) { this.source = value; }
    get src() { return this.source; }
  }
  const context = vm.createContext({
    console: logs, document, location, URL, URLSearchParams, Blob, TextDecoder,
    Uint8Array, Uint8ClampedArray, Float32Array, AbortController, DOMException,
    innerWidth: width, innerHeight: height, devicePixelRatio: dpr,
    performance: { now: () => now },
    Image: FakeImage,
    createImageBitmap: bitmapDecoder || (async (file) => ({
      width: file.width || 1000, height: file.height || 1000, name: file.name,
      closed: false, close() { this.closed = true; }
    })),
    matchMedia: () => ({ matches: reducedMotion, addEventListener() {}, addListener() {} }),
    localStorage: {
      getItem: (key) => localValues.get(key) ?? null,
      setItem: (key, value) => localValues.set(key, value),
      removeItem: (key) => localValues.delete(key)
    },
    requestAnimationFrame(callback) {
      const id = nextTaskId++; frames.set(id, callback); return id;
    },
    cancelAnimationFrame(id) { frames.delete(id); },
    setTimeout(callback, delay = 0) {
      const id = nextTaskId++; timers.set(id, { callback, delay }); return id;
    },
    clearTimeout(id) { timers.delete(id); },
    setInterval(callback, delay = 0) {
      const id = nextTaskId++; timers.set(id, { callback, delay, interval: true }); return id;
    },
    clearInterval(id) { timers.delete(id); },
    fetch: fetchOverride || (async () => ({ ok: false })),
    addEventListener: (...args) => document.addEventListener(...args),
    removeEventListener: (...args) => document.removeEventListener(...args)
  });
  context.window = context;
  context.parent = { postMessage() {} };

  const inlineScripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1]).filter((source) => source.trim());
  const applicationIndex = inlineScripts.findIndex((source) => source.includes('const state ='));
  assert.ok(applicationIndex >= 0, 'Cannot find editor application script.');
  for (const script of inlineScripts.slice(0, applicationIndex)) vm.runInContext(script, context);
  let application = inlineScripts[applicationIndex];
  const functionNames = [...application.matchAll(/^      (?:async )?function ([A-Za-z_$][\w$]*)\(/gm)]
    .map((match) => match[1]);
  assert.ok(functionNames.includes('restoreInitialPortrait'));
  const descriptors = functionNames.map((name) => `${name}: {
    get: () => ${name}, set: (replacement) => { ${name} = replacement; }
  }`).join(',');
  const exposure = `globalThis.__editorTest = { state, canvas, warpCanvas, controlPanel,
    get statusMessage() { return statusMessage; },
    get processorMessage() { return processorMessage; },
    get exportInProgress() { return exportInProgress; },
    get warpRenderer() { return warpRenderer; },
    set warpRenderer(replacement) { warpRenderer = replacement; }
  }; Object.defineProperties(globalThis.__editorTest, {${descriptors}});`;
  const startup = /\brestoreInitialPortrait\(\);\s*\n\s*\}\)\(\);/;
  assert.match(application, startup, 'Editor startup marker changed; update the test harness.');
  application = application.replace(startup, `${exposure}\n    })();`);
  vm.runInContext(application, context, { filename: 'index.html:application', timeout: 5000 });
  const api = context.__editorTest;
  api.stopRenderLoop();
  return {
    api, context, elements, canvases, frames, timers, warnings, html,
    setViewport(nextWidth, nextHeight, nextDpr = context.devicePixelRatio) {
      context.innerWidth = nextWidth; context.innerHeight = nextHeight;
      context.devicePixelRatio = nextDpr;
    },
    async runFrame(timestamp = now + 50) {
      now = timestamp;
      const callbacks = [...frames.values()]; frames.clear();
      for (const callback of callbacks) callback(timestamp);
      await flushMicrotasks();
    },
    async runTimers(maximumDelay = Infinity) {
      for (const [id, task] of [...timers]) {
        if (task.delay > maximumDelay) continue;
        if (!task.interval) timers.delete(id);
        task.callback();
      }
      await flushMicrotasks();
    }
  };
}
