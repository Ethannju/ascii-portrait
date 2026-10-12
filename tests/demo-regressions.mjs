import assert from 'node:assert/strict';
import { createEditorHarness, deferred, flushMicrotasks } from './editor-harness.mjs';

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

// Controlled events test request ordering, not browser image decoding, CORS,
// network availability, the demo asset's appearance, or real canvas pixels.
function controlImages(context) {
  const pending = [];
  context.Image = class ControlledImage {
    constructor() {
      this.width = this.naturalWidth = 768;
      this.height = this.naturalHeight = 1024;
      pending.push(this);
    }
    set src(value) { this.source = value; }
    get src() { return this.source; }
    succeed() { this.onload?.(); }
    fail() { this.onerror?.(new Error('Synthetic image loading failure')); }
  };
  return pending;
}

// Transaction-shaped storage is only used to observe reads/writes and ordering;
// browser quota handling, transaction lifetime, and durability are not emulated.
function memoryDatabase() {
  const records = new Map();
  const writes = [];
  return {
    records, writes,
    close() {},
    transaction() {
      const transaction = {
        objectStore() {
          return {
            put(value, key) { records.set(key, value); writes.push({ key, value }); },
            delete(key) { records.delete(key); },
            get(key) {
              const request = {};
              queueMicrotask(() => {
                request.result = records.get(key);
                request.onsuccess?.();
              });
              return request;
            }
          };
        }
      };
      queueMicrotask(() => transaction.oncomplete?.());
      return transaction;
    }
  };
}

const demoSources = {
  portrait: 'https://studio.example/assets/demo-portrait.jpg',
  astronaut: 'https://studio.example/assets/demo-astronaut.jpg',
  mecha: 'https://studio.example/assets/demo-mecha.jpg'
};

await test('the demo button opens a chooser without replacing the accepted photo or settings', async () => {
  const { api, context, elements } = await createEditorHarness();
  const images = controlImages(context);
  api.analyzePortrait = async () => {};
  await api.decodeFile({ name: 'existing-photo.png', type: 'image/png', size: 1 }, { persist: false });
  const accepted = api.state.image;
  const settings = JSON.stringify(api.captureSettings());
  const token = api.state.decodeToken;
  const gallery = elements.get('demoGallery');
  const button = elements.get('demoButton');
  const thumbnails = elements.get('demoGrid').querySelectorAll('[data-demo-id]');
  assert.equal(gallery.hidden, true);
  assert.deepEqual(thumbnails.map((thumbnail) => thumbnail.dataset.demoId), Object.keys(demoSources));
  assert.deepEqual(thumbnails.map((thumbnail) => thumbnail.children[0].src),
    Object.values(demoSources).map((source) => source.replace('https://studio.example/', './')));
  await button.dispatch('click');
  assert.equal(gallery.hidden, false);
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  assert.equal(images.length, 0);
  assert.equal(api.state.image, accepted);
  assert.equal(api.state.decodeToken, token);
  assert.equal(JSON.stringify(api.captureSettings()), settings);
  await button.dispatch('click');
  assert.equal(gallery.hidden, true);
  assert.equal(button.getAttribute('aria-expanded'), 'false');
});

for (const [id, source] of Object.entries(demoSources)) await test(`the ${id} fixture uses the common portrait and ASCII pipeline without segmentation`, async () => {
  const harness = await createEditorHarness();
  const { api, context, elements } = harness;
  const images = controlImages(context);
  const accepted = [];
  const accept = api.acceptPortraitImage;
  api.acceptPortraitImage = (...args) => { accepted.push(args); return accept(...args); };
  let analysisRequests = 0;
  api.analyzePortrait = async () => { analysisRequests++; };
  let rebuilds = 0;
  const rebuild = api.rebuildSamples;
  api.rebuildSamples = (...args) => { rebuilds++; return rebuild(...args); };

  await elements.get('demoButton').dispatch('click');
  const thumbnail = elements.get('demoGrid').querySelectorAll('[data-demo-id]')
    .find((button) => button.dataset.demoId === id);
  await thumbnail.dispatch('click');
  assert.equal(api.statusMessage.key, 'statusLoadingDemo');
  assert.equal(api.state.pendingDemoId, id);
  assert.equal(api.state.imageRequestPending, true);
  assert.equal(elements.get('demoSelect').value, id);
  assert.equal(elements.get('originalViewButton').disabled, true);
  assert.equal(images.length, 1);
  assert.equal(images[0].src, source);
  images[0].succeed();
  await flushMicrotasks();

  assert.equal(accepted.length, 1);
  assert.equal(accepted[0][0], images[0]);
  assert.equal(accepted[0][1].demo, true);
  assert.equal(accepted[0][1].demoId, id);
  assert.equal(api.state.demoMode, true);
  assert.equal(api.state.demoId, id);
  assert.equal(api.state.pendingDemoId, null);
  assert.equal(api.state.imageRequestPending, false);
  assert.equal(api.state.previewMode, 'ascii');
  assert.equal(elements.get('demoGallery').hidden, true);
  assert.equal(thumbnail.getAttribute('aria-pressed'), 'true');
  assert.equal(elements.get('originalViewButton').disabled, false);
  assert.equal(api.state.backgroundModeIndex, 2);
  assert.equal(elements.get('backgroundSelect').value, '2');
  assert.equal(api.state.segmentation, null);
  assert.equal(analysisRequests, 0, 'Built-in demos must not start model loading or segmentation.');
  assert.equal(elements.get('intro').classList.contains('is-hidden'), true);
  assert.equal(api.state.image.getContext('2d').draws[0][0], images[0]);

  await harness.runFrame(1000);
  assert.ok(rebuilds > 0, 'The demo must use the existing character conversion pipeline.');
  assert.equal(api.state.staticReady, true);
  assert.ok(api.state.samples.length > 0);
  assert.ok(api.state.samples.every((point) => !point.isArtBackground));
  assert.equal(api.statusMessage.key, 'statusRenderSummary');
});

await test('a failed demo offers an actionable status and can be retried', async () => {
  const { api, context, elements } = await createEditorHarness();
  const images = controlImages(context);
  const loading = api.loadDemoPortrait('astronaut');
  images[0].fail();
  await loading;
  assert.equal(api.state.image, null);
  assert.equal(api.state.demoMode, false);
  assert.equal(api.state.demoId, null);
  assert.equal(api.state.pendingDemoId, null);
  assert.equal(api.state.imageRequestPending, false);
  assert.equal(api.statusMessage.key, 'statusDemoFailed');
  assert.match(api.t(api.statusMessage.key), /try again.*choose your own photo/i);
  assert.equal(elements.get('intro').classList.contains('is-hidden'), false);
  assert.equal(elements.get('demoButton').disabled, false);

  const retry = api.loadDemoPortrait('astronaut');
  assert.equal(images.length, 2);
  images[1].succeed();
  await retry;
  assert.equal(api.state.demoMode, true);
  assert.equal(api.state.demoId, 'astronaut');
  assert.equal(api.statusMessage.key, 'statusLoaded');
});

await test('a timed-out demo releases comparison controls and ignores a late image event', async () => {
  const harness = await createEditorHarness();
  const { api, context, elements } = harness;
  const images = controlImages(context);
  const loading = api.loadDemoPortrait();
  await harness.runTimers(20000);
  await loading;
  assert.equal(api.statusMessage.key, 'statusDemoFailed');
  assert.equal(elements.get('demoButton').disabled, false);
  assert.equal(api.state.imageRequestPending, false);
  assert.equal(api.state.pendingDemoId, null);
  assert.equal(elements.get('originalViewButton').disabled, true);
  images[0].succeed();
  await flushMicrotasks();
  assert.equal(api.state.image, null);
  assert.equal(api.state.demoMode, false);
});

await test('the persistent demo selector switches accepted subjects and comparison labels together', async () => {
  const { api, context, elements } = await createEditorHarness();
  const images = controlImages(context);
  for (const [index, id] of Object.keys(demoSources).entries()) {
    elements.get('demoSelect').value = id;
    await elements.get('demoSelect').dispatch('change');
    assert.equal(images[index].src, demoSources[id]);
    images[index].succeed();
    await flushMicrotasks();
    assert.equal(api.state.demoId, id);
    assert.equal(elements.get('demoSelect').value, id);
    const caption = elements.get('sourceCaption').textContent;
    assert.match(caption, /AI-generated/i);
    assert.match(caption, new RegExp(id === 'portrait' ? 'portrait' : id, 'i'));
    const activeCards = elements.get('demoGrid').querySelectorAll('[data-demo-id]')
      .filter((card) => card.getAttribute('aria-pressed') === 'true');
    assert.deepEqual(activeCards.map((card) => card.dataset.demoId), [id]);
  }
  const token = api.state.decodeToken;
  assert.equal(await api.loadDemoPortrait('missing-demo'), false);
  assert.equal(api.state.decodeToken, token, 'An unknown demo must not invalidate the current comparison.');
  assert.equal(images.length, 3);
});

await test('original comparison uses the exact prepared source and shares the ASCII presentation bounds', async () => {
  for (const [width, height] of [[768, 1024], [1024, 1536], [1234, 777]]) {
    const harness = await createEditorHarness();
    const { api, context, elements, canvases } = harness;
    const images = controlImages(context);
    const loading = api.loadDemoPortrait('mecha');
    images[0].width = images[0].naturalWidth = width;
    images[0].height = images[0].naturalHeight = height;
    images[0].succeed();
    await loading;
    await harness.runFrame(1000);
    const prepared = api.state.image;
    const sampled = canvases.filter((canvas) => canvas !== prepared &&
      canvas.getContext('2d').draws.some((draw) => draw[0] === prepared));
    assert.ok(sampled.length > 0, 'ASCII conversion must sample the accepted prepared source.');
    const source = elements.get('sourcePreview');
    await elements.get('originalViewButton').dispatch('click');
    assert.equal(api.state.previewMode, 'original');
    assert.equal(source.hidden, false);
    assert.equal(elements.get('originalViewButton').getAttribute('aria-pressed'), 'true');
    assert.equal(elements.get('asciiViewButton').getAttribute('aria-pressed'), 'false');
    assert.equal(context.document.body.classList.contains('is-source-view'), true);
    assert.equal(elements.get('sourceModeLabel').textContent, api.t('sourceModeOriginal'));
    assert.equal(images.length, 1, 'Comparison must reuse the source rather than decode another image.');
    const draw = source.getContext('2d').draws.at(-1);
    const scale = Math.min(source.width / prepared.width, source.height / prepared.height);
    assert.equal(draw[0], prepared);
    assert.deepEqual(draw.slice(1), [(source.width - prepared.width * scale) / 2,
      (source.height - prepared.height * scale) / 2, prepared.width * scale, prepared.height * scale]);
    assert.equal(source.width, api.canvas.width);
    assert.equal(source.height, api.canvas.height);
    for (const viewport of [[1280, 800], [390, 844]]) {
      harness.setViewport(...viewport);
      api.resize();
      for (const property of ['width', 'height', 'left', 'top']) {
        assert.equal(source.style[property], api.canvas.style[property], `Shared ${property} at ${viewport}`);
        assert.equal(source.style[property], api.warpCanvas.style[property]);
      }
    }
  }
});

await test('comparison toggles preserve character settings, sample buffers, and saved local data', async () => {
  const harness = await createEditorHarness();
  const { api, context, elements, frames } = harness;
  const images = controlImages(context);
  const database = memoryDatabase();
  const savedPhoto = { name: 'saved-photo' };
  const savedSettings = { contrast: -22 };
  database.records.set('last-portrait', savedPhoto);
  database.records.set('editor-settings-v1', savedSettings);
  api.openPortraitDatabase = async () => database;
  const loading = api.loadDemoPortrait();
  images[0].succeed();
  await loading;
  await harness.runFrame(1000);
  const settings = JSON.stringify(api.captureSettings());
  const samples = api.state.samples;
  const sampleKey = api.state.lastSampleKey;
  let settingsSaves = 0;
  api.scheduleSessionSave = () => { settingsSaves++; };
  for (let index = 0; index < 3; index++) {
    await elements.get('originalViewButton').dispatch('click');
    assert.equal(frames.size, 0, 'Original view should not leave the ASCII motion loop running.');
    assert.equal(api.state.backgroundModeIndex, 2, 'Source preview is independent of background handling.');
    await elements.get('asciiViewButton').dispatch('click');
    assert.equal(api.state.previewMode, 'ascii');
    assert.equal(elements.get('sourcePreview').hidden, true);
    assert.equal(elements.get('asciiViewButton').getAttribute('aria-pressed'), 'true');
    assert.equal(elements.get('sourceModeLabel').textContent, api.t('sourceModeAscii'));
    assert.equal(context.document.body.classList.contains('is-source-view'), false);
  }
  await harness.runTimers();
  assert.equal(JSON.stringify(api.captureSettings()), settings);
  assert.equal(api.state.samples, samples);
  assert.equal(api.state.lastSampleKey, sampleKey);
  assert.equal(api.state.staticReady, true);
  assert.equal(settingsSaves, 0);
  assert.equal(database.records.get('last-portrait'), savedPhoto);
  assert.equal(database.records.get('editor-settings-v1'), savedSettings);
  assert.equal(database.writes.length, 0);
  assert.equal(api.setPreviewMode('invalid-mode'), false);
  assert.equal(api.state.previewMode, 'ascii');
});

await test('comparison labels follow the selected language without changing the accepted source', async () => {
  const { api, context, elements } = await createEditorHarness();
  const images = controlImages(context);
  const loading = api.loadDemoPortrait('astronaut');
  images[0].succeed();
  await loading;
  const accepted = api.state.image;
  api.setPreviewMode('original');
  api.applyLanguage('zh', { persist: false });
  assert.equal(elements.get('sourceModeLabel').textContent, api.t('sourceModeOriginal'));
  assert.equal(elements.get('sourceCaption').textContent,
    api.t('sourceCaptionDemo', { subjectKey: 'demoAstronaut' }));
  assert.match(elements.get('sourceCaption').textContent, /宇航员/);
  assert.equal(api.state.image, accepted);
  assert.equal(api.state.demoId, 'astronaut');
  assert.equal(api.state.previewMode, 'original');
  api.setPreviewMode('ascii');
  assert.equal(elements.get('sourceModeLabel').textContent, api.t('sourceModeAscii'));
});

await test('editing character controls in original view rebuilds ASCII once without changing the source preview', async () => {
  const harness = await createEditorHarness();
  const { api, context, elements, frames } = harness;
  const images = controlImages(context);
  const loading = api.loadDemoPortrait('astronaut');
  images[0].succeed();
  await loading;
  await harness.runFrame(1000);
  api.setPreviewMode('original');
  const accepted = api.state.image;
  const source = elements.get('sourcePreview');
  const sourceDrawCount = source.getContext('2d').draws.length;
  const oldSamples = api.state.samples;
  elements.get('gridRange').value = '10';
  await elements.get('gridRange').dispatch('input');
  assert.equal(api.state.staticReady, false);
  assert.equal(frames.size, 1, 'Changing a render setting must still schedule the cached ASCII rebuild.');
  await harness.runFrame(1100);
  assert.equal(api.state.staticReady, true);
  assert.notEqual(api.state.samples, oldSamples);
  assert.equal(api.state.gridSize, 10);
  assert.equal(api.state.image, accepted);
  assert.equal(api.state.previewMode, 'original');
  assert.equal(source.hidden, false);
  assert.equal(source.getContext('2d').draws.length, sourceDrawCount);
  assert.equal(frames.size, 0, 'The comparison should settle again after one rebuild.');
});

await test('newer demo requests win regardless of late success, failure, or settlement order', async () => {
  for (const olderOutcome of ['succeed', 'fail']) {
    for (const newerOutcome of ['succeed', 'fail']) {
      for (const olderFinishesFirst of [true, false]) {
        const { api, context, elements } = await createEditorHarness();
        const images = controlImages(context);
        const initial = api.loadDemoPortrait('portrait');
        images[0].succeed();
        await initial;
        const previous = api.state.image;
        api.setPreviewMode('original');
        const older = api.loadDemoPortrait('astronaut');
        const newer = api.loadDemoPortrait('mecha');
        if (olderFinishesFirst) {
          images[1][olderOutcome]();
          await older;
          assert.equal(api.state.image, previous);
          assert.equal(api.state.pendingDemoId, 'mecha');
          assert.equal(api.state.imageRequestPending, true);
          assert.equal(elements.get('demoSelect').value, 'mecha');
          assert.equal(elements.get('originalViewButton').disabled, true);
          assert.equal(api.statusMessage.key, 'statusLoadingDemo');
        }
        images[2][newerOutcome]();
        await newer;
        const accepted = api.state.image;
        const acceptedId = newerOutcome === 'succeed' ? 'mecha' : 'portrait';
        const status = api.statusMessage.key;
        if (!olderFinishesFirst) {
          images[1][olderOutcome]();
          await older;
        }
        assert.equal(api.state.image, accepted);
        assert.equal(api.state.demoId, acceptedId);
        assert.equal(api.state.pendingDemoId, null);
        assert.equal(api.state.imageRequestPending, false);
        assert.equal(elements.get('demoSelect').value, acceptedId);
        assert.equal(api.statusMessage.key, status);
        assert.equal(api.state.previewMode, 'ascii');
        assert.equal(elements.get('sourcePreview').hidden, true);
        if (newerOutcome === 'succeed') assert.equal(accepted.getContext('2d').draws[0][0], images[2]);
        else assert.equal(accepted, previous);
      }
    }
  }
});

await test('a failed replacement keeps the previous source and comparison available without stale labels', async () => {
  const harness = await createEditorHarness();
  const { api, context, elements } = harness;
  const images = controlImages(context);
  const loading = api.loadDemoPortrait('astronaut');
  images[0].succeed();
  await loading;
  await harness.runFrame(1000);
  const previous = api.state.image;
  api.setPreviewMode('original');
  const source = elements.get('sourcePreview');
  const clears = source.getContext('2d').clears.length;
  const replacing = api.loadDemoPortrait('mecha');
  assert.equal(source.hidden, true);
  assert.ok(source.getContext('2d').clears.length > clears);
  assert.equal(api.setPreviewMode('original'), false, 'Pending sources must not expose an old image as the new selection.');
  images[1].fail();
  await replacing;
  assert.equal(api.statusMessage.key, 'statusDemoFailed');
  assert.equal(api.state.image, previous);
  assert.equal(api.state.demoId, 'astronaut');
  assert.equal(elements.get('demoSelect').value, 'astronaut');
  assert.match(elements.get('sourceCaption').textContent, /astronaut/i);
  assert.equal(elements.get('originalViewButton').disabled, false);
  assert.equal(api.setPreviewMode('original'), true);
  assert.equal(source.getContext('2d').draws.at(-1)[0], previous);
});

await test('uploading and clearing reset an active original comparison immediately', async () => {
  const decoded = deferred();
  const harness = await createEditorHarness({ bitmapDecoder: () => decoded.promise });
  const { api, context, elements } = harness;
  const images = controlImages(context);
  const database = memoryDatabase();
  api.openPortraitDatabase = async () => database;
  const loading = api.loadDemoPortrait('mecha');
  images[0].succeed();
  await loading;
  api.setPreviewMode('original');
  const source = elements.get('sourcePreview');
  const clears = source.getContext('2d').clears.length;
  const uploading = api.decodeFile({ name: 'replacement.png', type: 'image/png', size: 1 });
  assert.equal(api.state.previewMode, 'ascii');
  assert.equal(source.hidden, true);
  assert.ok(source.getContext('2d').clears.length > clears);
  assert.equal(elements.get('originalViewButton').disabled, true);
  assert.equal(elements.get('demoSelect').value, '');
  const uploaded = { width: 400, height: 600, close() {} };
  decoded.resolve(uploaded);
  await uploading;
  assert.equal(api.state.demoMode, false);
  assert.equal(api.state.demoId, null);
  assert.equal(api.state.pendingDemoId, null);
  assert.equal(api.state.previewMode, 'ascii');
  assert.equal(api.state.image.getContext('2d').draws[0][0], uploaded);
  assert.equal(api.setPreviewMode('original'), true);
  assert.equal(source.getContext('2d').draws.at(-1)[0], api.state.image);
  await api.clearLocalPortraitData();
  assert.equal(api.state.image, null);
  assert.equal(api.state.demoId, null);
  assert.equal(api.state.previewMode, 'ascii');
  assert.equal(source.hidden, true);
  assert.equal(context.document.body.classList.contains('is-source-view'), false);
  assert.equal(elements.get('originalViewButton').disabled, true);
  assert.equal(elements.get('asciiViewButton').disabled, true);
  assert.equal(api.setPreviewMode('original'), false);
});

await test('PNG and video exports use ASCII snapshot buffers while original comparison is visible', async () => {
  const harness = await createEditorHarness();
  const { api, context, elements } = harness;
  const images = controlImages(context);
  const loading = api.loadDemoPortrait('portrait');
  images[0].succeed();
  await loading;
  await harness.runFrame(1000);
  const asciiBuffer = api.canvas.getContext('2d').draws.at(-1)[0];
  const prepared = api.state.image;
  api.setPreviewMode('original');
  const snapshots = [];
  const createSnapshot = api.createVideoExportSnapshot;
  api.createVideoExportSnapshot = (...args) => {
    const snapshot = createSnapshot(...args);
    snapshots.push(snapshot);
    return snapshot;
  };
  const downloads = [];
  api.downloadBlob = (...args) => downloads.push(args);
  let recorded = 0;
  context.AsciiMotionExport = {
    getPreferredFormat: () => ({ mimeType: 'video/webm', extension: 'webm', label: 'WebM' }),
    async record({ renderFrame }) {
      recorded++;
      renderFrame(0);
      renderFrame(3000);
      return { blob: new Blob(['video'], { type: 'video/webm' }), extension: 'webm', label: 'WebM' };
    }
  };
  await api.exportPngStill();
  await api.exportMotionVideo();
  assert.equal(recorded, 1);
  assert.deepEqual(downloads.map(([, name]) => name), ['ascii-portrait.png', 'ascii-portrait.webm']);
  assert.equal(snapshots.length, 2);
  for (const snapshot of snapshots) {
    const base = snapshot.canvas.getContext('2d').draws.at(-1)[0];
    assert.equal(base.getContext('2d').draws[0][0], asciiBuffer);
    assert.notEqual(base, prepared);
    assert.notEqual(base, elements.get('sourcePreview'));
    assert.notEqual(asciiBuffer, prepared);
    assert.notEqual(asciiBuffer, elements.get('sourcePreview'));
  }
  assert.equal(api.state.previewMode, 'original');
  assert.equal(elements.get('sourcePreview').hidden, false);
});

await test('a selected photo beats an in-flight demo without demo settings leaking into it', async () => {
  for (const outcome of ['succeed', 'fail']) {
    const { api, context, elements } = await createEditorHarness();
    const images = controlImages(context);
    api.analyzePortrait = async () => {};
    api.saveLastPortrait = async () => {};
    api.state.backgroundModeIndex = 1;
    api.state.contrast = 23;
    const loading = api.loadDemoPortrait();
    await api.decodeFile({ name: 'user-photo.png', type: 'image/png', size: 1 });
    const selected = api.state.image;
    const settings = JSON.stringify(api.captureSettings());
    const status = api.statusMessage.key;
    images[0][outcome]();
    await loading;
    assert.equal(api.state.image, selected, `A late demo ${outcome} must not replace the user photo.`);
    assert.equal(api.state.demoMode, false);
    assert.equal(JSON.stringify(api.captureSettings()), settings);
    assert.equal(api.state.backgroundModeIndex, 1);
    assert.equal(api.statusMessage.key, status);
    assert.equal(elements.get('demoButton').disabled, false);
  }
});

await test('selecting a photo invalidates the demo even before the photo finishes decoding', async () => {
  const decoded = deferred();
  const { api, context } = await createEditorHarness({ bitmapDecoder: () => decoded.promise });
  const images = controlImages(context);
  api.analyzePortrait = async () => {};
  api.saveLastPortrait = async () => {};
  api.state.backgroundModeIndex = 1;
  const loading = api.loadDemoPortrait();
  const selecting = api.decodeFile({ name: 'pending-user-photo.png', type: 'image/png', size: 1 });
  const settings = JSON.stringify(api.captureSettings());
  images[0].succeed();
  await loading;
  assert.equal(api.state.image, null);
  assert.equal(api.state.demoMode, false);
  assert.equal(JSON.stringify(api.captureSettings()), settings);
  assert.equal(api.statusMessage.key, 'statusReading');
  decoded.resolve({ width: 600, height: 800, close() {} });
  await selecting;
  assert.ok(api.state.image);
  assert.equal(api.state.demoMode, false);
  assert.equal(api.state.backgroundModeIndex, 1);
});

await test('clearing while the demo loads prevents late completion from repopulating the editor', async () => {
  const harness = await createEditorHarness();
  const { api, context, elements } = harness;
  const images = controlImages(context);
  const database = memoryDatabase();
  api.openPortraitDatabase = async () => database;
  const loading = api.loadDemoPortrait();
  await api.clearLocalPortraitData();
  const settings = JSON.stringify(api.captureSettings());
  images[0].succeed();
  await loading;
  await harness.runTimers();
  assert.equal(api.state.image, null);
  assert.equal(api.state.demoMode, false);
  assert.equal(api.state.samples.length, 0);
  assert.equal(api.state.staticReady, false);
  assert.equal(JSON.stringify(api.captureSettings()), settings);
  assert.equal(elements.get('intro').classList.contains('is-hidden'), false);
  assert.equal(elements.get('demoButton').disabled, false);
  assert.equal(database.records.size, 0);
  assert.equal(database.writes.length, 0);
});

await test('demo rendering and adjustments preserve the saved user photo and settings', async () => {
  const harness = await createEditorHarness();
  const { api, context } = harness;
  const images = controlImages(context);
  const database = memoryDatabase();
  const savedPhoto = { name: 'saved-user-photo' };
  const savedSettings = { contrast: -20, backgroundModeIndex: 0 };
  database.records.set('last-portrait', savedPhoto);
  database.records.set('editor-settings-v1', savedSettings);
  api.openPortraitDatabase = async () => database;
  const loading = api.loadDemoPortrait();
  images[0].succeed();
  await loading;
  await harness.runFrame(1000);
  api.state.contrast = 61;
  api.scheduleSessionSave();
  await harness.runTimers();
  await api.saveSessionSettings(api.captureSettings(), api.state.storageEpoch, api.state.decodeToken);
  assert.equal(database.records.get('last-portrait'), savedPhoto);
  assert.equal(database.records.get('editor-settings-v1'), savedSettings);
  assert.equal(database.writes.length, 0, 'Neither scheduled nor already-queued settings saves may persist the demo.');
});

await test('demo selection invalidates a user settings write waiting for storage', async () => {
  const { api, context } = await createEditorHarness();
  const images = controlImages(context);
  const opening = deferred();
  const database = memoryDatabase();
  api.state.image = { width: 800, height: 1000 };
  api.openPortraitDatabase = () => opening.promise;
  const saving = api.saveSessionSettings({ contrast: 40 }, api.state.storageEpoch, api.state.decodeToken);
  await flushMicrotasks();
  const loading = api.loadDemoPortrait();
  images[0].succeed();
  await loading;
  opening.resolve(database);
  await saving;
  assert.equal(database.writes.length, 0);
  assert.equal(api.state.demoMode, true);
});

await test('uploading after the demo restores ordinary photo and adjustment persistence', async () => {
  const harness = await createEditorHarness();
  const { api, context } = harness;
  const images = controlImages(context);
  const database = memoryDatabase();
  api.openPortraitDatabase = async () => database;
  const loading = api.loadDemoPortrait();
  images[0].succeed();
  await loading;
  const file = { name: 'next-user-photo.png', type: 'image/png', size: 1 };
  await api.decodeFile(file);
  await flushMicrotasks();
  assert.equal(api.state.demoMode, false);
  assert.equal(database.records.get('last-portrait')?.blob, file);
  api.state.contrast = 36;
  api.scheduleSessionSave();
  await harness.runTimers(260);
  assert.equal(database.records.get('editor-settings-v1')?.contrast, 36);
});

await test('a photo chosen after completed demos gets the background the visitor had, not Source field', async () => {
  for (const scenario of ['upload', 'two demos', 'explicit choice', 'clear']) {
    const { api, context, elements } = await createEditorHarness();
    const images = controlImages(context);
    const analyzed = [];
    api.analyzePortrait = async (image) => { analyzed.push(image); };
    api.saveLastPortrait = async () => {};
    api.openPortraitDatabase = async () => memoryDatabase();
    for (const id of scenario === 'two demos' ? ['portrait', 'mecha'] : ['portrait']) {
      const loading = api.loadDemoPortrait(id);
      images.at(-1).succeed();
      await loading;
      assert.equal(api.state.backgroundModeIndex, 2, 'Demos keep their quiet source background.');
    }
    assert.equal(analyzed.length, 0, 'Demos must not download the segmentation model.');
    let expected = 0;
    if (scenario === 'explicit choice') {
      const select = elements.get('backgroundSelect');
      select.value = '1';
      await select.dispatch('change');
      analyzed.length = 0;
      expected = 1;
    }
    if (scenario === 'clear') {
      await api.clearLocalPortraitData();
      assert.equal(api.state.backgroundModeIndex, 0);
      assert.equal(elements.get('backgroundSelect').value, '0');
    }
    await api.decodeFile({ name: 'own-photo.png', type: 'image/png', size: 1 });
    assert.equal(api.state.demoMode, false);
    assert.equal(api.state.backgroundModeIndex, expected, `${scenario}: background mode`);
    assert.equal(elements.get('backgroundSelect').value, String(expected));
    assert.equal(analyzed.length, 1, `${scenario}: the visitor's photo should be separated from its background.`);
  }
});

await test('demo selection prevents stale startup restoration from applying a saved photo or settings', async () => {
  for (const resolveBeforeDemo of [true, false]) {
    const { api, context } = await createEditorHarness();
    const images = controlImages(context);
    const stored = deferred();
    api.loadLastPortrait = () => stored.promise;
    api.loadSessionSettings = async () => ({ gridSize: 13, contrast: 99, backgroundModeIndex: 0 });
    const startup = api.restoreInitialPortrait();
    const loading = api.loadDemoPortrait();
    const initialSettings = JSON.stringify(api.captureSettings());
    if (!resolveBeforeDemo) {
      images[0].succeed();
      await loading;
    }
    const selected = api.state.image;
    const settings = JSON.stringify(api.captureSettings());
    stored.resolve({ blob: { name: 'old-user-photo.png', type: 'image/png', size: 1 } });
    await startup;
    assert.equal(api.state.image, selected);
    assert.equal(JSON.stringify(api.captureSettings()), settings);
    if (resolveBeforeDemo) {
      assert.equal(settings, initialSettings);
      assert.equal(api.statusMessage.key, 'statusLoadingDemo');
      images[0].succeed();
      await loading;
    }
    assert.equal(api.state.demoMode, true);
    assert.equal(api.state.backgroundModeIndex, 2);
    assert.notEqual(api.state.contrast, 99);
  }
});

await test('public portrait storage uses its own database namespace', async () => {
  const { api, context } = await createEditorHarness();
  const request = {};
  const opens = [];
  context.indexedDB = { open: (...args) => { opens.push(args); return request; } };
  const opening = api.openPortraitDatabase();
  request.result = memoryDatabase();
  request.onsuccess();
  await opening;
  assert.deepEqual(opens, [['ascii-portrait-public-v1', 1]]);
});

await flushMicrotasks();
if (failures.length) throw new AggregateError(failures, `${failures.length} demo regression checks failed.`);
console.log(`Demo regression checks passed (${completed} scenarios; synthetic browser primitives).`);
