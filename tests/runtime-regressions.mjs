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

function bitmap(name, width = 800, height = 1000) {
  return { name, width, height, closed: false, close() { this.closed = true; } };
}

// A transaction-shaped fake is enough to test ordering and invalidation; it is
// not intended to emulate browser quota, transaction scheduling, or durability.
function memoryDatabase() {
  const records = new Map();
  const writes = [];
  let closed = 0;
  const database = {
    records, writes,
    get closeCount() { return closed; },
    close() { closed++; },
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
  return database;
}

await test('startup restoration never replaces an explicitly selected photo', async () => {
  const harness = await createEditorHarness();
  const { api } = harness;
  const oldPhoto = deferred();
  api.loadLastPortrait = () => oldPhoto.promise;
  api.loadSessionSettings = async () => ({ gridSize: 13, contrast: 60 });
  api.analyzePortrait = async () => {};
  api.saveLastPortrait = async () => {};
  const startup = api.restoreInitialPortrait();
  await api.decodeFile({ name: 'new-photo', type: 'image/png', size: 1 });
  const selected = api.state.image;
  const selectedGrid = api.state.gridSize;
  oldPhoto.resolve({ blob: { name: 'old-photo', type: 'image/png', size: 1 } });
  await startup;
  assert.equal(api.state.image, selected);
  assert.equal(api.state.gridSize, selectedGrid, 'Stale restored settings must not mutate the new session.');
  assert.notEqual(api.statusMessage.key, 'statusRestored');
});

await test('a newer decoded photo wins and superseded bitmaps are released', async () => {
  const older = deferred();
  const newer = deferred();
  const harness = await createEditorHarness({
    bitmapDecoder: (file) => file.name === 'older' ? older.promise : newer.promise
  });
  const { api } = harness;
  api.analyzePortrait = async () => {};
  api.saveLastPortrait = async () => {};
  const olderOperation = api.decodeFile({ name: 'older', type: 'image/png', size: 1 });
  const newerOperation = api.decodeFile({ name: 'newer', type: 'image/png', size: 1 });
  const newerImage = bitmap('newer');
  newer.resolve(newerImage);
  await newerOperation;
  const winningImage = api.state.image;
  assert.ok(winningImage);
  const olderImage = bitmap('older');
  older.resolve(olderImage);
  await olderOperation;
  assert.equal(api.state.image, winningImage);
  assert.equal(olderImage.closed, true);
  assert.equal(newerImage.closed, true, 'The bounded working copy must release the decoded source bitmap.');
});

await test('cancelled segmentation resolves cleanly instead of throwing during cleanup', async () => {
  const { api } = await createEditorHarness();
  api.yieldToBrowser = async () => {};
  api.getPortraitSegmenter = async () => ({});
  api.queuePortraitSegmentation = async () => {
    api.state.analysisToken++;
    return null;
  };
  await assert.doesNotReject(api.analyzePortrait(bitmap('cancelled')));
});

await test('stale completed segmentation disposes its mask without publishing it', async () => {
  const { api } = await createEditorHarness();
  let disposed = 0;
  let decodedMask = false;
  api.yieldToBrowser = async () => {};
  api.getPortraitSegmenter = async () => ({});
  api.queuePortraitSegmentation = async () => {
    api.state.analysisToken++;
    return [{ mask: { dispose() { disposed++; }, toImageData() { decodedMask = true; } } }];
  };
  await api.analyzePortrait(bitmap('stale'));
  assert.equal(api.state.segmentation, null);
  assert.equal(decodedMask, false);
  assert.equal(disposed, 1);
});

await test('analysis blocks scheduled and direct render work', async () => {
  const harness = await createEditorHarness();
  const { api, frames } = harness;
  let rebuilt = 0;
  api.rebuildSamples = () => { rebuilt++; };
  api.state.analyzing = true;
  api.requestRender();
  assert.equal(frames.size, 0, 'A suspended analysis must not schedule the portrait loop.');
  api.renderFrame(1000);
  assert.equal(rebuilt, 0, 'A queued pre-analysis frame must also be guarded.');
  api.state.analyzing = false;
  api.requestRender();
  assert.equal(frames.size, 1, 'The loop must resume once analysis finishes.');
});

await test('loader reports real phases and completes only after the portrait is drawn', async () => {
  const harness = await createEditorHarness();
  const { api, elements, context, frames } = harness;
  const model = deferred();
  const inference = deferred();
  let disposed = 0;
  api.state.image = bitmap('loading');
  api.yieldToBrowser = async () => {};
  api.getPortraitSegmenter = () => model.promise;
  api.queuePortraitSegmentation = () => inference.promise;
  api.scheduleSessionSave = () => {};
  const analysis = api.analyzePortrait(api.state.image);
  await flushMicrotasks();
  assert.equal(api.processorMessage.key, 'processorLoadSegmentation');
  assert.equal(api.state.processorStep, 2);
  assert.equal(api.state.processorFinishing, null);
  assert.equal(elements.get('processor').classList.contains('is-complete'), false);
  assert.doesNotMatch(elements.get('processorStepCount').textContent, /%/);
  assert.equal(elements.get('processorProgress').getAttribute('aria-valuenow'), null);
  assert.equal(elements.get('processorBar').style.transform, 'scaleX(0.25)');
  model.resolve({});
  await flushMicrotasks();
  assert.equal(api.processorMessage.key, 'processorSeparate');
  assert.equal(api.state.processorStep, 3);
  assert.equal(elements.get('processorBar').style.transform, 'scaleX(0.5)');
  context.document.hidden = true;
  inference.resolve([{ mask: {
    async toImageData() { return { width: 1, height: 1, data: new Uint8ClampedArray([0, 0, 0, 255]) }; },
    dispose() { disposed++; }
  } }]);
  await analysis;
  assert.equal(disposed, 1);
  assert.equal(api.state.analyzing, false);
  assert.equal(api.state.staticReady, false);
  assert.equal(api.state.processorStep, 4);
  assert.equal(api.state.processorFinishing, 'processorPortraitComplete');
  assert.equal(api.processorMessage.key, 'processorRender');
  assert.equal(elements.get('processor').classList.contains('is-complete'), false);
  assert.equal(elements.get('processorProgress').getAttribute('aria-valuenow'), null);
  assert.equal(elements.get('processorBar').style.transform, 'scaleX(0.75)');
  assert.equal(elements.get('skipAnalysisButton').disabled, true);
  assert.equal(frames.size, 0, 'Hidden tabs cannot pretend that the presentation frame already happened.');
  await harness.runTimers();
  assert.equal(elements.get('processor').classList.contains('is-active'), true);
  context.document.hidden = false;
  api.requestRender();
  await harness.runFrame(1000);
  assert.equal(api.state.staticReady, true);
  assert.equal(api.processorMessage.key, 'processorPortraitComplete');
  assert.equal(elements.get('processor').classList.contains('is-complete'), true);
  assert.equal(elements.get('processorBar').style.transform, 'scaleX(1)');
  assert.equal(elements.get('processorProgress').getAttribute('aria-valuenow'), '4');
  await harness.runTimers(300);
  assert.equal(elements.get('processor').classList.contains('is-active'), false);
  assert.equal(elements.get('controlPanel').inert, false);
});

await test('skipping separation keeps the original background and rejects late masks', async () => {
  const harness = await createEditorHarness();
  const { api, elements } = harness;
  const inference = deferred();
  let disposed = 0;
  let decoded = 0;
  let saves = 0;
  api.state.image = bitmap('skip-separation');
  api.state.colorModeIndex = 3;
  const originalGrid = api.state.gridSize;
  api.yieldToBrowser = async () => {};
  api.getPortraitSegmenter = async () => ({});
  api.queuePortraitSegmentation = () => inference.promise;
  api.scheduleSessionSave = () => { saves++; };
  const analysis = api.analyzePortrait(api.state.image);
  await flushMicrotasks();
  assert.equal(api.processorMessage.key, 'processorSeparate');
  await elements.get('skipAnalysisButton').dispatch('click');
  assert.equal(api.state.backgroundModeIndex, 2);
  assert.equal(elements.get('backgroundSelect').value, '2');
  assert.equal(api.state.colorModeIndex, 3, 'Skipping must not reset other portrait adjustments.');
  assert.equal(api.state.gridSize, originalGrid);
  assert.equal(api.state.segmentation, null);
  assert.equal(api.state.analyzing, false);
  assert.equal(api.state.staticReady, false);
  assert.equal(api.processorMessage.key, 'processorRender');
  assert.equal(elements.get('processor').classList.contains('is-complete'), false);
  assert.ok(saves > 0, 'The explicit background choice should be saved with the session.');
  inference.resolve([{ mask: {
    toImageData() { decoded++; throw new Error('A cancelled mask must not be decoded.'); },
    dispose() { disposed++; }
  } }]);
  await analysis;
  assert.equal(decoded, 0);
  assert.equal(disposed, 1);
  assert.equal(api.state.segmentation, null);
  await harness.runFrame(1000);
  assert.equal(api.state.staticReady, true);
  assert.equal(api.processorMessage.key, 'processorBasicMode');
  assert.ok(api.state.samples.every((point) => !point.isArtBackground));
  await harness.runTimers(300);
  assert.equal(elements.get('processor').classList.contains('is-active'), false);
});

await test('an old first-yield continuation cannot overwrite a new loader phase', async () => {
  const { api, elements } = await createEditorHarness();
  const firstYield = deferred();
  let modelRequests = 0;
  api.state.image = bitmap('first');
  api.yieldToBrowser = () => firstYield.promise;
  api.getPortraitSegmenter = async () => { modelRequests++; return {}; };
  const first = api.analyzePortrait(api.state.image);
  api.beginImageRequest();
  api.state.image = bitmap('second');
  api.showProcessor(api.state.image);
  api.updateProcessor('processorSeparate', 3);
  const generation = api.state.processorGeneration;
  firstYield.resolve();
  await first;
  assert.equal(modelRequests, 0);
  assert.equal(api.processorMessage.key, 'processorSeparate');
  assert.equal(api.state.processorGeneration, generation);
  assert.equal(elements.get('processor').classList.contains('is-active'), true);
});

await test('an obsolete completion callback never hides a newer loader', async () => {
  const harness = await createEditorHarness();
  const { api, elements, timers } = harness;
  api.state.image = bitmap('first');
  api.scheduleSessionSave = () => {};
  api.showProcessor(api.state.image);
  api.beginProcessorRender('processorPortraitComplete');
  await harness.runFrame(1000);
  const obsoleteHide = timers.get(api.state.processorTimer)?.callback;
  assert.equal(typeof obsoleteHide, 'function');
  api.beginImageRequest();
  api.state.image = bitmap('second');
  api.showProcessor(api.state.image);
  const generation = api.state.processorGeneration;
  obsoleteHide();
  assert.equal(api.state.processorGeneration, generation);
  assert.equal(elements.get('processor').classList.contains('is-active'), true);
  assert.equal(elements.get('processor').getAttribute('aria-hidden'), 'false');
  assert.equal(elements.get('controlPanel').inert, true);
});

await test('clear dismisses a pending loader and late model loading cannot bring it back', async () => {
  const harness = await createEditorHarness();
  const { api, elements } = harness;
  const model = deferred();
  api.openPortraitDatabase = async () => memoryDatabase();
  api.state.image = bitmap('private');
  api.yieldToBrowser = async () => {};
  api.getPortraitSegmenter = () => model.promise;
  const analysis = api.analyzePortrait(api.state.image);
  await flushMicrotasks();
  assert.equal(elements.get('processor').classList.contains('is-active'), true);
  await api.clearLocalPortraitData();
  model.resolve({});
  await analysis;
  await harness.runTimers();
  assert.equal(api.state.image, null);
  assert.equal(api.state.processorFinishing, null);
  assert.equal(elements.get('processor').classList.contains('is-active'), false);
  assert.equal(elements.get('processor').getAttribute('aria-hidden'), 'true');
  assert.equal(elements.get('controlPanel').inert, false);
  assert.equal(elements.get('intro').inert, false);
});

await test('model failure stays in rendering phase until the fallback portrait appears', async () => {
  const harness = await createEditorHarness();
  const { api, elements } = harness;
  api.state.image = bitmap('offline');
  api.yieldToBrowser = async () => {};
  api.getPortraitSegmenter = async () => { throw new Error('Synthetic offline model'); };
  api.scheduleSessionSave = () => {};
  await api.analyzePortrait(api.state.image);
  assert.equal(api.state.analyzing, false);
  assert.equal(api.processorMessage.key, 'processorRender');
  assert.equal(elements.get('processor').classList.contains('is-complete'), false);
  await harness.runFrame(1000);
  assert.equal(api.state.staticReady, true);
  assert.equal(api.processorMessage.key, 'processorBasicMode');
  await harness.runTimers(300);
  assert.equal(elements.get('processor').classList.contains('is-active'), false);
});

await test('an inference timeout renders a fallback and disposes any late mask without reopening the loader', async () => {
  const harness = await createEditorHarness();
  const { api, elements } = harness;
  const inference = deferred();
  let disposed = 0;
  api.state.image = bitmap('timed-out');
  api.yieldToBrowser = async () => {};
  api.getPortraitSegmenter = async () => ({});
  api.queuePortraitSegmentation = () => inference.promise;
  api.scheduleSessionSave = () => {};
  const analysis = api.analyzePortrait(api.state.image);
  await flushMicrotasks();
  assert.equal(api.processorMessage.key, 'processorSeparate');
  await harness.runTimers(20000);
  await analysis;
  assert.equal(api.state.analyzing, false);
  assert.equal(api.processorMessage.key, 'processorRender');
  assert.equal(elements.get('processor').classList.contains('is-complete'), false);
  await harness.runFrame(1000);
  await harness.runTimers(300);
  assert.equal(api.state.staticReady, true);
  assert.equal(elements.get('processor').classList.contains('is-active'), false);
  inference.resolve([{ mask: { dispose() { disposed++; } } }]);
  await flushMicrotasks();
  assert.equal(disposed, 1);
  assert.equal(api.state.segmentation, null);
  assert.equal(elements.get('processor').classList.contains('is-active'), false);
});

await test('conversion failures release the modal instead of leaving it on its final phase', async () => {
  const { api, elements } = await createEditorHarness();
  api.state.image = bitmap('render-error');
  api.showProcessor(api.state.image);
  api.beginProcessorRender('processorPortraitComplete');
  api.rebuildSamples = () => { throw new Error('Synthetic character conversion error'); };
  assert.doesNotThrow(() => api.renderFrame(1000));
  assert.equal(api.state.staticReady, false);
  assert.equal(api.state.processorFinishing, null);
  assert.equal(elements.get('processor').classList.contains('is-active'), false);
  assert.equal(elements.get('controlPanel').inert, false);
  assert.equal(api.statusMessage.key, 'statusRenderInterrupted');
});

await test('late GPU presentation failures cannot strand the loader or escape its recovery path', async () => {
  const harness = await createEditorHarness();
  const { api, elements } = harness;
  api.state.image = bitmap('gpu-error');
  api.state.motionIndex = 3;
  api.scheduleSessionSave = () => {};
  api.warpRenderer = {
    updateTextures() {}, updateAsciiTexture() {},
    render() { throw new Error('Synthetic lost graphics context'); }
  };
  api.showProcessor(api.state.image);
  api.beginProcessorRender('processorPortraitComplete');
  assert.doesNotThrow(() => api.renderFrame(1000));
  await harness.runTimers(250);
  assert.equal(api.state.processorFinishing, null);
  assert.equal(elements.get('processor').classList.contains('is-active'), false);
  assert.equal(elements.get('controlPanel').inert, false);
});

await test('reduced motion completes the same render lifecycle without a decorative delay', async () => {
  const harness = await createEditorHarness({ reducedMotion: true });
  const { api, elements } = harness;
  api.state.image = bitmap('reduced-motion');
  api.scheduleSessionSave = () => {};
  api.showProcessor(api.state.image);
  api.beginProcessorRender('processorPortraitComplete');
  assert.equal(api.state.reducedMotion, true);
  assert.equal(elements.get('processor').classList.contains('is-complete'), false);
  await harness.runFrame(1000);
  assert.equal(api.state.staticReady, true);
  await harness.runTimers(0);
  assert.equal(elements.get('processor').classList.contains('is-active'), false);
  assert.equal(elements.get('controlPanel').inert, false);
});

await test('clear resets the visible session and cancels delayed settings saves', async () => {
  const harness = await createEditorHarness();
  const { api, timers, elements } = harness;
  const database = memoryDatabase();
  api.openPortraitDatabase = async () => database;
  const image = bitmap('current');
  api.state.image = image;
  api.state.staticReady = true;
  api.state.samples = [{ glyph: 'x' }];
  api.state.segmentation = { data: new Float32Array([1]), width: 1, height: 1 };
  elements.get('filePicker').value = 'chosen-photo.png';
  api.scheduleSessionSave();
  assert.ok(timers.size > 0);
  await api.clearLocalPortraitData();
  await harness.runTimers();
  assert.equal(image.closed, true);
  assert.equal(api.state.image, null);
  assert.equal(api.state.samples.length, 0);
  assert.equal(api.state.segmentation, null);
  assert.equal(api.state.staticReady, false);
  assert.equal(api.state.analyzing, false);
  assert.equal(elements.get('filePicker').value, '');
  assert.equal(elements.get('intro').classList.contains('is-hidden'), false);
  assert.equal(database.writes.length, 0, 'Clearing must not be followed by the previously scheduled write.');
});

await test('a storage open that finishes after clear cannot put the photo back', async () => {
  const { api } = await createEditorHarness();
  const opening = deferred();
  const database = memoryDatabase();
  let opens = 0;
  api.openPortraitDatabase = () => ++opens === 1 ? opening.promise : Promise.resolve(database);
  const saving = api.saveLastPortrait({ name: 'private-photo', type: 'image/png' });
  await flushMicrotasks();
  const clearing = api.clearLocalPortraitData();
  assert.equal(api.state.image, null, 'The visible session resets before the storage queue drains.');
  opening.resolve(database);
  await Promise.all([saving, clearing]);
  assert.equal(database.records.size, 0);
  assert.equal(database.writes.length, 0);
  assert.equal(database.closeCount, 2);
});

await test('a delayed settings write cannot cross a clear boundary', async () => {
  const { api } = await createEditorHarness();
  const opening = deferred();
  const database = memoryDatabase();
  api.state.image = bitmap('current');
  let opens = 0;
  api.openPortraitDatabase = () => ++opens === 1 ? opening.promise : Promise.resolve(database);
  const saving = api.saveSessionSettings({ contrast: 50 }, api.state.storageEpoch, api.state.decodeToken);
  await flushMicrotasks();
  const clearing = api.clearLocalPortraitData();
  opening.resolve(database);
  await Promise.all([saving, clearing]);
  assert.equal(database.records.size, 0);
  assert.equal(database.writes.length, 0);
});

await test('a newly selected photo is saved after an in-flight clear, never deleted by it', async () => {
  const { api } = await createEditorHarness();
  const opening = deferred();
  const database = memoryDatabase();
  database.records.set('last-portrait', { name: 'old-photo' });
  let opens = 0;
  api.openPortraitDatabase = () => ++opens === 1 ? opening.promise : Promise.resolve(database);
  const clearing = api.clearLocalPortraitData();
  await flushMicrotasks();
  api.state.image = bitmap('new-photo');
  const file = { name: 'new-photo', type: 'image/png' };
  const saving = api.saveLastPortrait(file);
  await flushMicrotasks();
  assert.equal(opens, 1, 'The new write must wait for the earlier clear to finish.');
  opening.resolve(database);
  await Promise.all([clearing, saving]);
  assert.equal(database.records.get('last-portrait').blob, file);
  assert.ok(database.records.has('editor-settings-v1'));
});

await test('blocked or timed-out storage opens reject and release a late connection', async () => {
  for (const failure of ['blocked', 'timeout']) {
    const harness = await createEditorHarness();
    const { api, context, timers } = harness;
    const request = {};
    let closed = 0;
    context.indexedDB = { open: () => request };
    const opening = api.openPortraitDatabase();
    const rejected = assert.rejects(opening, /blocked|respond/i);
    if (failure === 'blocked') request.onblocked();
    else await harness.runTimers(5000);
    await rejected;
    request.result = { close() { closed++; } };
    request.onsuccess();
    assert.equal(closed, 1, 'A connection arriving after rejection must not remain open.');
    assert.equal(timers.size, 0);
  }
});

await test('one rejected storage write does not poison subsequent queued saves', async () => {
  const { api } = await createEditorHarness();
  const database = memoryDatabase();
  let opens = 0;
  api.openPortraitDatabase = async () => {
    if (++opens === 1) throw new Error('Storage blocked');
    return database;
  };
  await assert.rejects(api.saveLastPortrait({ name: 'first' }), /blocked/);
  const file = { name: 'second', type: 'image/png' };
  await api.saveLastPortrait(file);
  assert.equal(database.records.get('last-portrait').blob, file);
});

await test('a photo still decoding cannot repopulate a cleared session', async () => {
  const decoding = deferred();
  const { api } = await createEditorHarness({ bitmapDecoder: () => decoding.promise });
  const database = memoryDatabase();
  api.openPortraitDatabase = async () => database;
  api.analyzePortrait = async () => {};
  const importing = api.decodeFile({ name: 'late-photo', type: 'image/png', size: 1 });
  await api.clearLocalPortraitData();
  const decodedImage = bitmap('late-photo');
  decoding.resolve(decodedImage);
  await importing;
  assert.equal(api.state.image, null);
  assert.equal(decodedImage.closed, true);
  assert.equal(database.records.size, 0);
});

await test('saved editor settings are compact and restored only within valid bounds', async () => {
  const { api } = await createEditorHarness();
  const settings = api.captureSettings();
  assert.ok(JSON.stringify(settings).length < 2048);
  assert.equal('samples' in settings, false);
  api.restoreSettings({ contrast: 20, temperature: -10, gridSize: 7,
    paletteIndex: 0.5, motionIndex: -1, tint: Infinity });
  assert.equal(api.state.contrast, 20);
  assert.equal(api.state.temperature, -10);
  assert.equal(api.state.gridSize, 7);
  assert.equal(api.state.paletteIndex, settings.paletteIndex);
  assert.equal(api.state.motionIndex, settings.motionIndex);
  assert.equal(api.state.tint, settings.tint);
});

await test('viewport changes preserve artwork geometry and respect the pixel budget', async () => {
  const harness = await createEditorHarness();
  const { api, canvases } = harness;
  const logicalSize = [api.state.width, api.state.height];
  for (const [width, height, dpr] of [[390, 844, 3], [1920, 1080, 2], [7680, 4320, 3]]) {
    harness.setViewport(width, height, dpr);
    api.resize();
    assert.deepEqual([api.state.width, api.state.height], logicalSize);
    const displayedWidth = Number.parseFloat(api.canvas.style.width);
    const displayedHeight = Number.parseFloat(api.canvas.style.height);
    assert.ok(Math.abs(displayedWidth / displayedHeight - logicalSize[0] / logicalSize[1]) < 0.01,
      'Preview fitting must preserve the artwork aspect ratio.');
    for (const canvas of canvases) {
      assert.ok(canvas.width * canvas.height <= 1_800_000,
        `${canvas.id || 'work canvas'} exceeds the work-pixel budget: ${canvas.width} × ${canvas.height}`);
    }
  }
});

await test('accepted source aspect ratios never exceed the final rounded render budget', async () => {
  const { api } = await createEditorHarness();
  api.analyzePortrait = async () => {};
  for (const [width, height] of [[1000, 1000], [4032, 3024], [3024, 4032], [8000, 2000]]) {
    const decoded = bitmap('synthetic-large', width, height);
    api.acceptPortraitImage(decoded);
    assert.equal(decoded.closed, true);
    assert.ok(Math.max(api.state.image.width, api.state.image.height) <= 2048,
      'The retained source copy must not retain the full decoded phone photo.');
    assert.ok(Math.max(api.state.width, api.state.height) <= 1200);
    assert.ok(api.canvas.width * api.canvas.height <= 1_800_000,
      `Rounded render size is above budget: ${api.canvas.width} × ${api.canvas.height}`);
    assert.ok(Math.abs(api.state.width / api.state.height - width / height) < 0.01,
      'Normalizing a source must preserve its aspect ratio.');
  }
});

await test('an explicit preset wins over a portrait and never silently falls back', async () => {
  const { api } = await createEditorHarness({
    search: '?embed=1&preset=https://assets.example/explicit.json&portrait=https://assets.example/photo.png'
  });
  const attempts = [];
  api.loadAssetPresetUrl = async (url) => { attempts.push(['preset', url]); return false; };
  api.loadPortraitUrl = (...args) => { attempts.push(['portrait', ...args]); };
  api.loadLastPortrait = async () => { attempts.push(['local']); return null; };
  await api.restoreInitialPortrait();
  assert.deepEqual(attempts, [['preset', 'https://assets.example/explicit.json']]);
  assert.equal(api.statusMessage.key, 'statusPresetFailed');
});

await test('an explicit portrait takes priority over saved assets', async () => {
  const { api } = await createEditorHarness({
    search: '?embed=1&portrait=https://assets.example/photo.png'
  });
  const attempts = [];
  api.loadAssetPresetUrl = async (url) => { attempts.push(['preset', url]); return false; };
  api.loadPortraitUrl = (url) => { attempts.push(['portrait', url]); };
  api.loadLastPortrait = async () => { attempts.push(['local']); return null; };
  await api.restoreInitialPortrait();
  assert.deepEqual(attempts, [['portrait', 'https://assets.example/photo.png']]);
});

for (const language of ['en', 'zh']) await test(`an embed without a source shows a ${language} error without loading old assets`, async () => {
  const { api, context, elements, html } = await createEditorHarness({ search: `?embed=1&lang=${language}` });
  const attempts = [];
  const messages = [];
  context.fetch = async (...args) => { attempts.push(['fetch', ...args]); throw new Error('Unexpected request'); };
  context.__ASCII_PORTRAIT_PRESET__ = { sentinel: 'must-not-be-used' };
  api.applyAssetPreset = (...args) => { attempts.push(['apply', ...args]); return true; };
  api.loadLastPortrait = async () => { attempts.push(['local']); return null; };
  api.loadSessionSettings = async () => { attempts.push(['settings']); return null; };
  context.parent = { postMessage: (payload) => messages.push(payload) };
  await api.restoreInitialPortrait();
  assert.deepEqual(attempts, []);
  assert.equal(api.statusMessage.key, 'statusEmbedSourceFailed');
  const status = elements.get('status');
  assert.equal(status.classList.contains('is-error'), true);
  assert.match(status.textContent, language === 'zh' ? /缺少嵌入素材/ : /Embed source missing/);
  assert.match(status.textContent, /portrait/);
  assert.match(status.textContent, /preset/);
  assert.match(html, /\.embed-mode \.status\.is-error\s*\{\s*display:\s*block\s*!important/,
    'Embed errors must override the hidden status rule.');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'error');
});

await test('embed geometry notifications can reach a cross-origin parent without exposing samples', async () => {
  const { api, context } = await createEditorHarness({ search: '?embed=1' });
  const messages = [];
  context.parent = { postMessage: (payload, targetOrigin) => messages.push({ payload, targetOrigin }) };
  api.state.samples = [{ privateSample: true }];
  api.notifyHost('ready');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].targetOrigin, '*',
    'The parent origin may differ from the component/viewer origin.');
  assert.deepEqual(JSON.parse(JSON.stringify(messages[0].payload)), {
    channel: 'ascii-portrait', type: 'ready',
    width: api.state.artworkWidth, height: api.state.artworkHeight
  });
});

await test('explicit synthetic presets validate both supported versions and reject malformed input', async () => {
  const { api, elements } = await createEditorHarness();
  const preset = {
    version: 2, width: 100, height: 140, columns: 1, rows: 1, gridSize: 10,
    paletteIndex: 0, colorModeIndex: 0, contrast: 0, temperature: 0, tint: 0,
    warpIndex: 0, motionIndex: 0, motionStrength: 0, backgroundModeIndex: 0,
    glyphs: '.', samples: [{
      gridX: 0, gridY: 0, x: 5, y: 7, glyphIndex: 0, glyph: '.', isArtBackground: false,
      foregroundWeight: 1, luma: 0.5, height: 0.5, lightness: 0.5, ink: 0.5,
      baseAlpha: 1, maskAlpha: 1, r: 128, g: 128, b: 128,
      baseRed: 128, baseGreen: 128, baseBlue: 128
    }]
  };
  assert.equal(api.validateAssetPreset(preset), true);
  assert.equal(api.validateAssetPreset({ ...preset, version: 1, motionIndex: 4 }), true);
  assert.equal(api.validateAssetPreset({ ...preset, version: 3 }), false);
  assert.equal(elements.has('freezeAssetButton'), false, 'Legacy loading must not restore the removed Freeze UI.');
  const malformed = { ...preset, samples: preset.samples.slice(1) };
  assert.equal(api.validateAssetPreset(malformed), false);
  assert.equal(api.validateAssetPreset({ ...preset, motionIndex: 99 }), false);
});

await test('export snapshots isolate glyphs and settings from subsequent editor changes', async () => {
  const { api, canvases } = await createEditorHarness();
  const gpuCalls = [];
  let disposed = 0;
  const renderer = {
    resize() {}, updateTextures() {}, updateAsciiTexture() {},
    render(...args) { gpuCalls.push(args); }, dispose() { disposed++; }
  };
  api.warpRenderer = renderer;
  api.createDisplacementRenderer = () => renderer;
  api.state.image = bitmap('synthetic');
  api.rebuildSamples();
  const originalSamples = api.state.samples;
  const paintCalls = [];
  const paint = api.paintGlyph;
  api.paintGlyph = (ctx, point, glyphIndex, glow, opacity, renderState, renderGlyphs) => {
    paintCalls.push([point.gridX, point.gridY, point.baseRed, glyphIndex, glow, opacity,
      renderState.gridSize, renderState.colorModeIndex, renderGlyphs]);
    return paint(ctx, point, glyphIndex, glow, opacity, renderState, renderGlyphs);
  };
  const previousCanvasCount = canvases.length;
  const snapshot = api.createVideoExportSnapshot();
  assert.notEqual(snapshot.canvas, api.canvas, 'Recording must own its canvas.');
  snapshot.renderFrame(1700);
  const firstPaint = paintCalls.splice(0);
  const firstGpu = gpuCalls.splice(0);
  assert.ok(firstPaint.length > 0, 'The fixture must exercise animated glyphs, not just a static frame.');
  api.state.gridSize = 13;
  api.state.colorModeIndex = 4;
  api.state.motionIndex = 3;
  api.state.motionStrength = 0;
  originalSamples.forEach((point) => { point.baseRed = 0; });
  api.state.samples = [];
  snapshot.renderFrame(1700);
  assert.deepEqual(paintCalls.splice(0), firstPaint);
  assert.deepEqual(gpuCalls.splice(0), firstGpu);
  snapshot.dispose();
  assert.equal(disposed, 1);
  for (const buffer of canvases.slice(previousCanvasCount)) {
    assert.equal(buffer.width, 1);
    assert.equal(buffer.height, 1);
  }
});

await test('snapshot allocation failure releases every buffer already created', async () => {
  const { api, canvases } = await createEditorHarness();
  api.warpRenderer = { updateTextures() {} };
  api.state.image = bitmap('synthetic');
  api.rebuildSamples();
  api.createDisplacementRenderer = () => null;
  const previousCanvasCount = canvases.length;
  assert.throws(() => api.createVideoExportSnapshot(), /graphics|resources/i);
  assert.ok(canvases.length > previousCanvasCount);
  for (const buffer of canvases.slice(previousCanvasCount)) {
    assert.equal(buffer.width, 1);
    assert.equal(buffer.height, 1);
  }
});

await test('clear aborts an active video and suppresses a late encoder completion', async () => {
  const { api, context, elements } = await createEditorHarness();
  api.openPortraitDatabase = async () => memoryDatabase();
  const encoding = deferred();
  let capturedSignal;
  let disposed = 0;
  let downloads = 0;
  context.AsciiMotionExport = {
    getPreferredFormat: () => ({ mimeType: 'video/webm', extension: 'webm', label: 'WebM' }),
    record({ signal }) { capturedSignal = signal; return encoding.promise; }
  };
  api.createVideoExportSnapshot = () => ({ canvas: {}, renderFrame() {}, dispose() { disposed++; } });
  api.downloadBlob = () => { downloads++; };
  api.state.image = bitmap('current');
  api.state.staticReady = true;
  api.state.samples = [{}];
  elements.get('exportFormatSelect').value = 'video';
  const exporting = elements.get('downloadButton').dispatch('click');
  await flushMicrotasks();
  assert.equal(api.exportInProgress, true);
  await elements.get('clearLocalDataButton').dispatch('click');
  assert.equal(capturedSignal.aborted, true);
  assert.equal(api.statusMessage.key, 'statusCleared');
  encoding.resolve({ blob: new Blob(['media']), extension: 'webm', label: 'WebM' });
  await exporting;
  assert.equal(downloads, 0);
  assert.equal(disposed, 1);
  assert.equal(api.statusMessage.key, 'statusCleared');
  assert.equal(api.exportInProgress, false);
});

for (const language of ['en', 'zh']) for (const failure of ['TimeoutError', 'EncodingError']) {
await test(`${failure} reports a ${language} recovery message and permits a clean retry`, async () => {
  const { api, context, elements } = await createEditorHarness();
  api.applyLanguage(language, { persist: false });
  const failedEncoding = deferred();
  let attempts = 0;
  let disposed = 0;
  const downloads = [];
  const signals = [];
  context.AsciiMotionExport = {
    getPreferredFormat: () => ({ mimeType: 'video/webm', extension: 'webm', label: 'WebM' }),
    record({ signal }) {
      signals.push(signal);
      attempts++;
      return attempts === 1 ? failedEncoding.promise
        : Promise.resolve({ blob: new Blob(['valid media']), extension: 'webm', label: 'WebM' });
    }
  };
  api.createVideoExportSnapshot = () => ({ canvas: {}, renderFrame() {}, dispose() { disposed++; } });
  api.downloadBlob = (_blob, filename) => { downloads.push(filename); };
  api.state.image = bitmap('current');
  api.state.staticReady = true;
  api.state.samples = [{}];
  const button = elements.get('downloadButton');
  const format = elements.get('exportFormatSelect');
  format.value = 'video';
  const exporting = button.dispatch('click');
  await flushMicrotasks();
  assert.equal(api.exportInProgress, true);
  assert.equal(format.disabled, true);
  failedEncoding.reject(Object.assign(new Error('Encoding did not complete'), { name: failure }));
  await exporting;
  assert.deepEqual(downloads, [], 'An incomplete encoding must never be downloaded.');
  assert.equal(disposed, 1);
  assert.equal(api.statusMessage.key,
    failure === 'TimeoutError' ? 'statusExportTimeoutFailed' : 'statusExportEncodingFailed');
  assert.match(elements.get('status').textContent,
    language === 'zh' ? /重试.*PNG/ : /Retry.*PNG/);
  assert.equal(elements.get('status').classList.contains('is-error'), true);
  assert.equal(api.exportInProgress, false);
  assert.equal(format.disabled, false);
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, api.t('exportAction'));
  await button.dispatch('click');
  assert.equal(attempts, 2);
  assert.notEqual(signals[0], signals[1], 'Retry must receive a fresh cancellation signal.');
  assert.equal(signals[1].aborted, false);
  assert.deepEqual(downloads, ['ascii-portrait.webm']);
  assert.equal(disposed, 2);
  assert.equal(api.statusMessage.key, 'statusVideoExported');
  assert.equal(api.exportInProgress, false);
  assert.equal(format.disabled, false);
  assert.equal(button.disabled, false);
});
}

await test('clear suppresses a PNG encode that finishes after the session was removed', async () => {
  const { api, elements } = await createEditorHarness();
  api.openPortraitDatabase = async () => memoryDatabase();
  let finishEncoding;
  let disposed = 0;
  let downloads = 0;
  api.createVideoExportSnapshot = () => ({
    canvas: { toBlob(callback) { finishEncoding = callback; } },
    renderFrame() {}, dispose() { disposed++; }
  });
  api.downloadBlob = () => { downloads++; };
  api.state.image = bitmap('current');
  api.state.staticReady = true;
  elements.get('exportFormatSelect').value = 'png';
  const exporting = elements.get('downloadButton').dispatch('click');
  await flushMicrotasks();
  assert.equal(typeof finishEncoding, 'function');
  await elements.get('clearLocalDataButton').dispatch('click');
  finishEncoding(new Blob(['pixels'], { type: 'image/png' }));
  await exporting;
  assert.equal(downloads, 0);
  assert.equal(disposed, 1);
  assert.equal(api.statusMessage.key, 'statusCleared');
  assert.equal(api.exportInProgress, false);
});

await test('WebGL fallback never redraws an old portrait after the session was cleared', async () => {
  const { api, elements } = await createEditorHarness();
  api.openPortraitDatabase = async () => memoryDatabase();
  api.state.image = bitmap('synthetic');
  api.rebuildSamples();
  await api.clearLocalPortraitData();
  const drawing = api.canvas.getContext('2d');
  drawing.draws.length = 0;
  await elements.get('warpCanvas').dispatch('webglcontextlost');
  assert.equal(api.state.staticReady, false);
  assert.equal(drawing.draws.length, 0, 'Context loss must not resurrect a stale cached portrait.');
});

await test('failed WebGL compile and link paths release allocated shader resources', async () => {
  const { api } = await createEditorHarness();
  for (const failure of ['compile', 'link']) {
    const shaders = [];
    const deletedShaders = [];
    const program = {};
    let deletedProgram = null;
    let contextReleased = false;
    const gl = {
      VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4,
      createProgram: () => program,
      createShader(type) { const shader = { type }; shaders.push(shader); return shader; },
      shaderSource() {}, compileShader() {}, attachShader() {}, linkProgram() {},
      getShaderParameter: () => failure !== 'compile',
      getShaderInfoLog: () => 'Synthetic compile failure',
      getProgramParameter: () => failure !== 'link',
      getProgramInfoLog: () => 'Synthetic link failure',
      deleteShader(shader) { deletedShaders.push(shader); },
      deleteProgram(value) { deletedProgram = value; },
      getExtension(name) {
        assert.equal(name, 'WEBGL_lose_context');
        return { loseContext() { contextReleased = true; } };
      }
    };
    const target = { style: {}, getContext: () => gl };
    assert.equal(api.createDisplacementRenderer(target), null);
    assert.deepEqual(deletedShaders, shaders);
    assert.equal(deletedProgram, program);
    assert.equal(contextReleased, true);
    assert.equal(target.style.display, 'none');
  }
});

await test('animated glyph operations repeat exactly at the six-second loop boundary', async () => {
  const { api } = await createEditorHarness();
  api.state.image = bitmap('synthetic');
  api.rebuildSamples();
  const calls = [];
  api.paintGlyph = (_ctx, point, index, glow, opacity) => {
    calls.push([point.gridX, point.gridY, index, glow, opacity]);
  };
  for (const motionMode of [1, 4]) {
    api.renderAnimatedSource(1250, motionMode, 82);
    const first = calls.splice(0);
    assert.ok(first.length > 0);
    api.renderAnimatedSource(7250, motionMode, 82);
    assert.deepEqual(calls.splice(0), first);
    api.renderAnimatedSource(0, motionMode, 82);
    const start = calls.splice(0);
    api.renderAnimatedSource(6000, motionMode, 82);
    assert.deepEqual(calls.splice(0), start);
  }
});

await test('preset loading enforces the stream limit and cancels oversized reads', async () => {
  const { api } = await createEditorHarness();
  let cancelled = false;
  let reads = 0;
  const reader = {
    async read() { reads++; return { done: false, value: new Uint8Array(6) }; },
    async cancel() { cancelled = true; }
  };
  await assert.rejects(api.readJsonResponse({ headers: { get: () => null },
    body: { getReader: () => reader } }, 10), /large|limit/i);
  assert.equal(reads, 2);
  assert.equal(cancelled, true);
  const value = await api.readJsonResponse({ headers: { get: () => null },
    text: async () => '{"version":2}' }, 100);
  assert.equal(value.version, 2);
});

await flushMicrotasks();
if (failures.length) throw new AggregateError(failures, `${failures.length} editor runtime regression checks failed.`);
console.log(`Editor runtime regression checks passed (${completed} scenarios; synthetic browser primitives).`);
