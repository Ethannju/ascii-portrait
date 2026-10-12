import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../motion-export.js', import.meta.url), 'utf8');
let completed = 0;
async function test(name, run) {
  await run();
  completed += 1;
  console.log(`  ✓ ${name}`);
}

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, listener, options = {}) {
      if (!listeners.has(type)) listeners.set(type, new Map());
      listeners.get(type).set(listener, options.once);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    dispatch(type) {
      for (const [listener, once] of [...(listeners.get(type) || [])]) {
        if (once) listeners.get(type).delete(listener);
        listener({ type });
      }
      this[`on${type}`]?.({ type });
    },
    listenerCount() { return [...listeners.values()].reduce((sum, set) => sum + set.size, 0); }
  };
}

async function microtasks() {
  for (let index = 0; index < 20; index++) await Promise.resolve();
}

// Model WebCodecs ownership, asynchronous outputs, queue pressure, and flush.
// Encoded payloads are synthetic: these tests validate our scheduling/container,
// not whether a real browser encoder emits a decodable VP8/VP9 bitstream.
function fixture(options = {}) {
  let now = 0;
  let nextTimer = 1;
  const timers = new Map();
  const encoders = [];
  const videoFrames = [];
  const encoded = [];
  const queries = [];
  const rendered = [];
  const outputEvents = [];
  let maximumQueue = 0;
  const document = { ...eventTarget(), hidden: Boolean(options.hidden) };
  const signal = { ...eventTarget(), aborted: Boolean(options.aborted) };
  const controller = { signal, abort() { signal.aborted = true; signal.dispatch('abort'); } };
  const window = {
    ...eventTarget(), document,
    isSecureContext: !options.insecure,
    performance: { now: () => now },
    setTimeout(callback, delay = 0) {
      const id = nextTimer++;
      timers.set(id, { callback, at: now + Math.max(0, delay) });
      return id;
    },
    clearTimeout(id) { timers.delete(id); }
  };
  const canvas = { width: options.width ?? 200, height: options.height ?? 100 };
  class Frame {
    constructor(input, init) {
      assert.equal(input, canvas, 'Only the immutable export canvas becomes a VideoFrame.');
      if (options.failFrameAt === videoFrames.length) throw new Error('VideoFrame allocation failed');
      assert.ok(Number.isInteger(init.timestamp));
      assert.ok(Number.isInteger(init.duration) && init.duration > 0);
      // Safari 26 stores some frame timestamps 1 µs low (1041667 -> 1041666).
      this.timestamp = init.timestamp - (options.frameTimestampRoundingAt?.includes(videoFrames.length) ? 1 : 0);
      this.duration = init.duration;
      this.renderedTime = canvas.time;
      this.closed = false;
      videoFrames.push(this);
    }
    close() { this.closed = true; }
  }
  class Encoder {
    static async isConfigSupported(config) {
      queries.push({ ...config });
      if (options.rejectSupport) throw new Error('Codec query failed');
      if (options.unsupportedQuery?.includes(config.codec)) {
        throw Object.assign(new Error('Unsupported codec'), { name: 'NotSupportedError' });
      }
      if (options.neverSupport) return new Promise(() => {});
      return { supported: options.supportedCodecs
        ? options.supportedCodecs.includes(config.codec)
        : config.codec === 'vp8' || config.codec.startsWith('vp09'), config: { ...config } };
    }
    constructor(callbacks) {
      if (options.failConstructor) throw new Error('Encoder allocation failed');
      Object.assign(this, eventTarget());
      this.callbacks = callbacks;
      this.state = 'unconfigured';
      this.encodeQueueSize = 0;
      this.tasks = new Set();
      this.flushes = [];
      this.flushCount = 0;
      encoders.push(this);
    }
    configure(config) {
      if (options.rejectConfigure?.includes(config.codec)) throw new Error('Codec configuration failed');
      this.config = { ...config };
      this.state = 'configured';
    }
    encode(frame, init = {}) {
      assert.equal(this.state, 'configured');
      assert.equal(frame.closed, false, 'The encoder must receive a live frame.');
      if (options.failEncodeAt === encoded.length) throw new Error('Frame encoding failed');
      const index = encoded.length;
      const item = { timestamp: frame.timestamp, duration: frame.duration,
        renderedTime: frame.renderedTime, keyFrame: Boolean(init.keyFrame), index };
      encoded.push(item);
      this.encodeQueueSize += 1;
      maximumQueue = Math.max(maximumQueue, this.encodeQueueSize);
      const timer = window.setTimeout(() => {
        this.tasks.delete(timer);
        if (this.state === 'closed') return;
        this.encodeQueueSize -= 1;
        if (options.asyncErrorAt === index) {
          this.fail(new Error('Asynchronous encoder failure'));
          return;
        }
        if (options.dropOutputAt !== index && !options.noOutput) {
          const payload = new Uint8Array([0x11, index >>> 8, index & 255, 0x55]);
          const chunk = {
            type: item.keyFrame ? 'key' : 'delta',
            // 2 µs is the smallest error beyond the tolerated 1 µs platform rounding.
            timestamp: item.timestamp + (options.invalidTimestampAt === index ? 2 : 0),
            duration: options.omitDuration ? undefined : item.duration + (options.invalidDurationAt === index ? 2 : 0),
            byteLength: options.emptyOutputAt === index ? 0 : payload.byteLength,
            copyTo(target) { target.set(payload.subarray(0, this.byteLength)); }
          };
          this.callbacks.output(chunk, { decoderConfig: {
            codec: options.outputCodec || this.config.codec,
            codedWidth: options.outputWidth || canvas.width, codedHeight: canvas.height
          } });
          outputEvents.push(index);
          if (options.duplicateOutputAt === index) this.callbacks.output(chunk, {});
        }
        this.dispatch('dequeue');
        this.finishFlushes();
      }, options.encoderDelay ?? 1);
      this.tasks.add(timer);
    }
    flush() {
      this.flushCount += 1;
      if (options.rejectFlush) return Promise.reject(new Error('Encoder flush failed'));
      return new Promise((resolve, reject) => {
        this.flushes.push({ resolve, reject });
        this.finishFlushes();
      });
    }
    finishFlushes() {
      if (this.encodeQueueSize || options.neverFlush || options.holdFlush ||
          (options.holdAfterFrames && encoded.length >= options.holdAfterFrames)) return;
      for (const pending of this.flushes.splice(0)) pending.resolve();
    }
    fail(error) {
      this.close();
      this.callbacks.error(error);
    }
    close() {
      this.state = 'closed';
      for (const timer of this.tasks) window.clearTimeout(timer);
      this.tasks.clear();
      this.encodeQueueSize = 0;
      for (const pending of this.flushes.splice(0)) pending.reject(new Error('Encoder closed'));
    }
  }
  if (!options.noEncoder) window.VideoEncoder = Encoder;
  if (!options.noFrame) window.VideoFrame = Frame;
  if (options.noSupportQuery) Encoder.isConfigSupported = undefined;
  // Deliberately no captureStream or MediaRecorder fallback: silently returning
  // a successful but dropped-frame recording is the regression being fixed.
  vm.runInNewContext(source, { window, Blob, Uint8Array, ArrayBuffer, DataView, TextEncoder, console });
  const renderFrame = (time, target) => {
    assert.equal(target, canvas);
    if (options.failRenderAt === rendered.length) throw new Error('Snapshot renderer failed');
    rendered.push(time);
    canvas.time = time;
    now += options.renderCost ?? 0;
  };
  function nextTask() {
    const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
    if (!next) return false;
    now = Math.max(now, next[1].at);
    timers.delete(next[0]);
    next[1].callback();
    return true;
  }
  async function until(predicate) {
    for (let count = 0; count < 20000; count++) {
      await microtasks();
      if (predicate()) return;
      if (!nextTask()) throw new Error('Export is pending without a timer or encoder event.');
    }
    throw new Error('Export exceeded the deterministic event budget.');
  }
  async function settle(pending) {
    let result;
    pending.then((value) => { result = { value }; }, (error) => { result = { error }; });
    await until(() => Boolean(result));
    if (result.error) throw result.error;
    return result.value;
  }
  function start(overrides = {}) {
    const pending = window.AsciiMotionExport.record({ canvas, renderFrame, signal, ...overrides });
    pending.catch(() => {});
    return pending;
  }
  const assertClean = () => {
    assert.ok(videoFrames.every((frame) => frame.closed), 'Every input frame must be released.');
    assert.ok(encoders.every((encoder) => encoder.state === 'closed'), 'Every allocated encoder must be closed.');
    assert.equal(timers.size, 0, 'No export or codec timers may survive completion/cancellation.');
    assert.equal(document.listenerCount(), 0);
    assert.equal(window.listenerCount(), 0);
    assert.equal(signal.listenerCount(), 0);
    assert.ok(encoders.every((encoder) => encoder.listenerCount() === 0));
  };
  return { api: window.AsciiMotionExport, canvas, renderFrame, start, settle, until, options,
    encoded, rendered, videoFrames, encoders, queries, outputEvents, window, document, controller,
    assertClean, get now() { return now; }, get maximumQueue() { return maximumQueue; } };
}

// Parse the returned WebM structurally. Looking for marker bytes would confuse
// arbitrary encoded payload bytes with EBML headers and miss broken sizes.
async function inspectWebm(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  function vint(offset, preserveMarker = false) {
    assert.ok(offset < bytes.length, 'Truncated EBML integer.');
    let length = 1;
    let marker = 0x80;
    while (length <= 8 && !(bytes[offset] & marker)) { length++; marker >>= 1; }
    assert.ok(length <= (preserveMarker ? 4 : 8) && offset + length <= bytes.length);
    let value = BigInt(preserveMarker ? bytes[offset] : bytes[offset] & (marker - 1));
    for (let index = 1; index < length; index++) value = value * 256n + BigInt(bytes[offset + index]);
    const unknown = !preserveMarker && value === (1n << BigInt(7 * length)) - 1n;
    assert.ok(unknown || value <= BigInt(Number.MAX_SAFE_INTEGER));
    return { value: Number(value), length, unknown };
  }
  function children(start = 0, end = bytes.length) {
    const nodes = [];
    for (let offset = start; offset < end;) {
      const id = vint(offset, true);
      const size = vint(offset + id.length);
      const dataStart = offset + id.length + size.length;
      const dataEnd = size.unknown ? end : dataStart + size.value;
      assert.ok(dataEnd <= end && dataEnd >= dataStart, 'EBML element extends beyond its parent.');
      nodes.push({ id: id.value, start: dataStart, end: dataEnd, offset });
      offset = dataEnd;
    }
    return nodes;
  }
  const within = (node) => children(node.start, node.end);
  const requireNode = (nodes, id) => {
    const result = nodes.find((node) => node.id === id);
    assert.ok(result, `Missing EBML element 0x${id.toString(16)}.`);
    return result;
  };
  const uint = (node) => bytes.subarray(node.start, node.end).reduce((value, byte) => value * 256 + byte, 0);
  const text = (node) => new TextDecoder().decode(bytes.subarray(node.start, node.end));
  const roots = children();
  const header = within(requireNode(roots, 0x1a45dfa3));
  assert.equal(text(requireNode(header, 0x4282)), 'webm');
  const segmentNode = requireNode(roots, 0x18538067);
  const segment = within(segmentNode);
  const info = within(requireNode(segment, 0x1549a966));
  const scale = uint(requireNode(info, 0x2ad7b1));
  const durationNode = requireNode(info, 0x4489);
  const durationView = new DataView(bytes.buffer, bytes.byteOffset + durationNode.start, durationNode.end - durationNode.start);
  assert.ok(durationView.byteLength === 4 || durationView.byteLength === 8);
  const duration = durationView.byteLength === 8 ? durationView.getFloat64(0) : durationView.getFloat32(0);
  const tracks = within(requireNode(segment, 0x1654ae6b));
  const trackEntries = tracks.filter((node) => node.id === 0xae);
  assert.equal(trackEntries.length, 1, 'The export has exactly one video track.');
  const track = within(trackEntries[0]);
  const trackNumber = uint(requireNode(track, 0xd7));
  assert.equal(uint(requireNode(track, 0x83)), 1);
  const codec = text(requireNode(track, 0x86));
  const video = within(requireNode(track, 0xe0));
  const width = uint(requireNode(video, 0xb0));
  const height = uint(requireNode(video, 0xba));
  const defaultDuration = track.find((node) => node.id === 0x23e383);
  const blocks = [];
  const clusters = segment.filter((node) => node.id === 0x1f43b675);
  for (const cluster of clusters) {
    const elements = within(cluster);
    const clusterTime = uint(requireNode(elements, 0xe7));
    for (const element of elements) {
      const group = element.id === 0xa0 ? within(element) : null;
      const block = element.id === 0xa3 ? element : group?.find((node) => node.id === 0xa1);
      if (!block) continue;
      const number = vint(block.start);
      assert.equal(number.value, trackNumber);
      const offset = block.start + number.length;
      assert.ok(offset + 3 <= block.end);
      const relative = new DataView(bytes.buffer, bytes.byteOffset + offset, 2).getInt16(0);
      const flags = bytes[offset + 2];
      assert.equal(flags & 0x06, 0, 'A frame must not be hidden inside an untested lacing format.');
      const blockDuration = group?.find((node) => node.id === 0x9b);
      blocks.push({ timeMs: (clusterTime + relative) * scale / 1e6,
        durationMs: blockDuration ? uint(blockDuration) * scale / 1e6 : null,
        key: group ? !group.some((node) => node.id === 0xfb) : Boolean(flags & 0x80),
        payload: [...bytes.subarray(offset + 3, block.end)] });
    }
  }
  // Seek/Cue offsets are relative to Segment payload, not the file or element header.
  const seekHead = segment.find((node) => node.id === 0x114d9b74);
  if (seekHead) for (const seek of within(seekHead)) {
    const parts = within(seek);
    const id = uint(requireNode(parts, 0x53ab));
    const target = uint(requireNode(parts, 0x53ac)) + segmentNode.start;
    assert.ok(segment.some((node) => node.id === id && node.offset === target), 'SeekHead must point to the matching element.');
  }
  const cues = segment.find((node) => node.id === 0x1c53bb6b);
  const cueTimes = [];
  if (cues) for (const cue of within(cues)) {
    const parts = within(cue);
    const time = uint(requireNode(parts, 0xb3));
    const positions = within(requireNode(parts, 0xb7));
    assert.equal(uint(requireNode(positions, 0xf7)), trackNumber);
    const target = uint(requireNode(positions, 0xf1)) + segmentNode.start;
    const cluster = clusters.find((node) => node.offset === target);
    assert.ok(cluster, 'Cue must point to an actual cluster.');
    assert.equal(uint(requireNode(within(cluster), 0xe7)), time);
    cueTimes.push(time * scale / 1e6);
  }
  return { durationMs: duration * scale / 1e6, scale, codec, width, height, blocks, cueTimes,
    defaultDurationMs: defaultDuration ? uint(defaultDuration) / 1e6 : null };
}

function assertTimeline(f, result, durationMs = 6000, fps = 24) {
  const count = Math.max(1, Math.round(durationMs * fps / 1000));
  assert.equal(result.durationMs, durationMs);
  assert.equal(result.frameCount, count);
  assert.equal(f.rendered.length, count);
  assert.equal(f.encoded.length, count);
  assert.ok(f.rendered.every((time) => time < durationMs), 'No duplicate endpoint may pause the loop seam.');
  for (let index = 0; index < count; index++) {
    assert.ok(Math.abs(f.rendered[index] - index * durationMs / count) < 1e-9);
    assert.equal(f.encoded[index].timestamp, Math.round(index * durationMs * 1000 / count));
    assert.equal(f.encoded[index].duration,
      Math.round((index + 1) * durationMs * 1000 / count) - f.encoded[index].timestamp);
    assert.equal(f.encoded[index].renderedTime, f.rendered[index]);
  }
  assert.equal(f.encoded.at(-1).timestamp + f.encoded.at(-1).duration, Math.round(durationMs * 1000));
  assert.equal(f.encoded[0].keyFrame, true);
}

await test('144 deterministic frames survive encoder output and WebM muxing', async () => {
  const f = fixture();
  const progress = [];
  const result = await f.settle(f.start({ onProgress: (value) => progress.push(value) }));
  assert.equal(result.extension, 'webm');
  assert.equal(result.mimeType.split(';')[0], 'video/webm');
  assert.equal(result.blob.type.split(';')[0], 'video/webm');
  assert.equal(result.label, 'WebM');
  assertTimeline(f, result);
  const webm = await inspectWebm(result.blob);
  assert.equal(webm.width, 200);
  assert.equal(webm.height, 100);
  assert.equal(webm.codec, f.encoders.find((encoder) => encoder.config)?.config.codec === 'vp8' ? 'V_VP8' : 'V_VP9');
  assert.equal(webm.durationMs, 6000);
  assert.equal(webm.defaultDurationMs, Math.round(6_000_000_000 / 144) / 1e6);
  assert.equal(webm.blocks.length, 144);
  assert.equal(webm.blocks[0].key, true);
  for (let index = 0; index < 144; index++) {
    assert.ok(Math.abs(webm.blocks[index].timeMs - f.encoded[index].timestamp / 1000) <= webm.scale / 1e6);
    assert.deepEqual(webm.blocks[index].payload, [0x11, index >>> 8, index & 255, 0x55]);
    assert.equal(webm.blocks[index].key, f.encoded[index].keyFrame);
    assert.equal(webm.blocks[index].durationMs, f.encoded[index].duration / 1000);
  }
  assert.deepEqual(webm.cueTimes, webm.blocks.filter((block) => block.key).map((block) => block.timeMs));
  assert.deepEqual(f.encoded.filter((frame) => frame.keyFrame).map((frame) => frame.timestamp),
    [0, 1_000_000, 2_000_000, 3_000_000, 4_000_000, 5_000_000]);
  assert.equal(progress.at(-1), 1);
  assert.ok(progress.every((value, index) => value >= 0 && value <= 1 && (!index || value >= progress[index - 1])));
  assert.ok(f.encoders.some((encoder) => encoder.flushCount > 0));
  const config = f.encoders.find((encoder) => encoder.config).config;
  assert.equal(config.latencyMode, 'quality', 'Realtime mode may discard frames to meet wall-clock deadlines.');
  assert.equal(config.width, 200);
  assert.equal(config.height, 100);
  assert.equal(config.framerate, 24);
  f.assertClean();
});

await test('Safari-style 1 µs frame timestamp rounding still writes the exact WebM timeline', async () => {
  const f = fixture({ frameTimestampRoundingAt: [25, 98] });
  const result = await f.settle(f.start());
  assert.equal(result.frameCount, 144);
  assert.equal(f.encoded[25].timestamp, 1_041_666, 'The fixture must reproduce the rounded frame.');
  const webm = await inspectWebm(result.blob);
  assert.equal(webm.blocks.length, 144);
  for (let index = 0; index < 144; index++) {
    assert.equal(Math.round(webm.blocks[index].timeMs * 1000), Math.round(index * 6_000_000 / 144));
  }
  f.assertClean();
});

await test('slow rendering and encoder backpressure never skip timeline frames', async () => {
  const f = fixture({ renderCost: 120, encoderDelay: 500 });
  const result = await f.settle(f.start());
  assertTimeline(f, result);
  assert.ok(f.now > 6000, 'The test must be slower than realtime.');
  assert.ok(f.maximumQueue <= 8, `The exporter queued ${f.maximumQueue} frames without backpressure.`);
  assert.equal((await inspectWebm(result.blob)).blocks.length, 144);
  f.assertClean();
});

await test('a fast renderer waits for a slow encoder instead of accumulating frames', async () => {
  const f = fixture({ encoderDelay: 500 });
  const result = await f.settle(f.start());
  assertTimeline(f, result);
  assert.ok(f.maximumQueue > 1, 'Exercise a genuinely queued encoder.');
  assert.ok(f.maximumQueue <= 8, `The exporter queued ${f.maximumQueue} frames without backpressure.`);
  f.assertClean();
});

for (const [reason, options] of [
  ['unsupported VP9', { supportedCodecs: ['vp8'] }],
  ['rejected VP9 query', { unsupportedQuery: ['vp09.00.40.08'] }]
]) {
  await test(`${reason} falls back to matching VP8 MIME and WebM track`, async () => {
    const f = fixture(options);
    const result = await f.settle(f.start());
    assert.deepEqual(f.queries.map((query) => query.codec), ['vp09.00.40.08', 'vp8']);
    assert.equal(result.mimeType, 'video/webm;codecs=vp8');
    assert.equal((await inspectWebm(result.blob)).codec, 'V_VP8');
    f.assertClean();
  });
}

await test('a one-frame loop and absent optional chunk durations preserve explicit container timing', async () => {
  const f = fixture({ omitDuration: true });
  const result = await f.settle(f.start({ durationMs: 10, fps: 24 }));
  assertTimeline(f, result, 10, 24);
  const webm = await inspectWebm(result.blob);
  assert.equal(webm.blocks.length, 1);
  assert.equal(webm.blocks[0].durationMs, 10);
  assert.equal(webm.durationMs, 10);
  f.assertClean();
});

await test('nonintegral frame intervals cover exactly one requested duration', async () => {
  const f = fixture();
  const durationMs = 1001;
  const fps = 29.97;
  const result = await f.settle(f.start({ durationMs, fps }));
  assertTimeline(f, result, durationMs, fps);
  assert.equal((await inspectWebm(result.blob)).durationMs, durationMs);
  f.assertClean();
});

for (const stage of ['capability check', 'encoder flush']) {
  await test(`cancellation interrupts a stalled ${stage} and ignores late output`, async () => {
    const f = fixture(stage === 'capability check' ? { neverSupport: true } : { holdFlush: true });
    const progress = [];
    const pending = f.start({ onProgress: (value) => progress.push(value) });
    await f.until(() => stage === 'capability check'
      ? f.queries.length > 0 : f.encoders.some((encoder) => encoder.flushCount > 0));
    f.controller.abort();
    await assert.rejects(f.settle(pending), { name: 'AbortError' });
    const previousProgress = progress.slice();
    for (const encoder of f.encoders) {
      assert.doesNotThrow(() => encoder.callbacks.output(null, null));
      encoder.callbacks.error(new Error('Late encoder error'));
    }
    assert.deepEqual(progress, previousProgress);
    f.assertClean();
  });
}

await test('completion progress waits for flushed encoded output', async () => {
  const f = fixture({ holdAfterFrames: 144 });
  const progress = [];
  const pending = f.start({ onProgress: (value) => progress.push(value) });
  await f.until(() => f.outputEvents.length === 144);
  assert.equal(f.encoded.length, 144);
  assert.ok(!progress.includes(1));
  f.options.holdAfterFrames = 0;
  for (const encoder of f.encoders) encoder.finishFlushes();
  await f.settle(pending);
  assert.equal(progress.at(-1), 1);
  f.assertClean();
});

await test('a renderer cannot resize the canvas during export', async () => {
  const f = fixture();
  await assert.rejects(f.settle(f.start({ renderFrame(time, target) {
    f.renderFrame(time, target);
    target.width += 2;
  } })), { name: 'EncodingError' });
  assert.equal(f.videoFrames.length, 0);
  f.assertClean();
});

await test('a failing progress callback releases asynchronous encoding resources', async () => {
  const f = fixture();
  await assert.rejects(f.settle(f.start({ onProgress(value) {
    if (value > 0) throw new Error('Progress callback failed');
  } })), /Progress callback failed/);
  f.assertClean();
});

for (const reason of ['signal', 'visibility', 'pagehide']) {
  await test(`${reason} cancellation releases frames, encoder, timers, and listeners`, async () => {
    const f = fixture({ encoderDelay: 500 });
    const pending = f.start();
    await f.until(() => f.encoded.length > 0);
    const renderedBeforeCancel = f.rendered.length;
    if (reason === 'signal') f.controller.abort();
    if (reason === 'visibility') { f.document.hidden = true; f.document.dispatch('visibilitychange'); }
    if (reason === 'pagehide') f.window.dispatch('pagehide');
    await assert.rejects(f.settle(pending), { name: 'AbortError' });
    assert.equal(f.rendered.length, renderedBeforeCancel);
    f.assertClean();
  });
}

for (const reason of ['hidden', 'aborted']) {
  await test(`already ${reason} requests do not allocate an encoder`, async () => {
    const f = fixture({ [reason]: true });
    await assert.rejects(f.settle(f.start()), { name: 'AbortError' });
    assert.equal(f.encoded.length, 0);
    assert.equal(f.encoders.length, 0);
    f.assertClean();
  });
}

for (const [reason, options] of [
  ['render', { failRenderAt: 2 }], ['frame allocation', { failFrameAt: 2 }],
  ['encoder allocation', { failConstructor: true }], ['encode', { failEncodeAt: 2 }],
  ['async encoder', { asyncErrorAt: 2 }], ['flush', { rejectFlush: true }],
  ['missing output', { dropOutputAt: 2 }], ['empty output', { emptyOutputAt: 2 }],
  ['missing final frame after flush', { dropOutputAt: 143 }],
  ['all output missing', { noOutput: true }], ['duplicate output', { duplicateOutputAt: 2 }],
  ['invalid timestamp', { invalidTimestampAt: 2 }], ['invalid duration', { invalidDurationAt: 2 }],
  ['unexpected codec change', { outputCodec: 'avc1.42E01E' }],
  ['unexpected dimensions', { outputWidth: 201 }],
  ['configure', { rejectConfigure: ['vp09.00.40.08', 'vp8'] }],
  ['flush timeout', { neverFlush: true }]
]) {
  await test(`${reason} failure cannot publish a partial loop`, async () => {
    const f = fixture(options);
    const progress = [];
    await assert.rejects(f.settle(f.start({ onProgress: (value) => progress.push(value) })));
    assert.ok(!progress.includes(1), 'A failed export must not report completion.');
    f.assertClean();
  });
}

for (const option of ['noEncoder', 'noFrame', 'noSupportQuery']) {
  await test(`${option} reports unsupported instead of falling back to lossy realtime capture`, async () => {
    const f = fixture({ [option]: true });
    assert.equal(f.api.getPreferredFormat(), null);
    await assert.rejects(f.settle(f.start()), { name: 'NotSupportedError' });
    f.assertClean();
  });
}

await test('unsupported codec configurations reject without rendering', async () => {
  const f = fixture({ supportedCodecs: [] });
  await assert.rejects(f.settle(f.start()), { name: 'NotSupportedError' });
  assert.ok(f.queries.length > 0);
  assert.equal(f.rendered.length, 0);
  f.assertClean();
});

for (const [reason, options, expected] of [
  ['never-ending capability query', { neverSupport: true }, 'TimeoutError'],
  ['unexpected capability query failure', { rejectSupport: true }, 'Error']
]) {
  await test(`${reason} rejects and clears its watchdog`, async () => {
    const f = fixture(options);
    await assert.rejects(f.settle(f.start()), { name: expected });
    assert.equal(f.encoders.length, 0);
    f.assertClean();
  });
}

for (const [reason, overrides] of [
  ['zero duration', { durationMs: 0 }], ['nonfinite duration', { durationMs: NaN }],
  ['zero frame rate', { fps: 0 }], ['excessive frame rate', { fps: 121 }],
  ['missing renderer', { renderFrame: null }]
]) {
  await test(`invalid ${reason} rejects before allocating frames`, async () => {
    const f = fixture();
    await assert.rejects(f.settle(f.start(overrides)), { name: 'TypeError' });
    assert.equal(f.videoFrames.length, 0);
    f.assertClean();
  });
}

// Exercise the actual editor adapter as well as the encoder utility. Resources
// owned by its immutable snapshot must be released even if download itself fails.
const editorSource = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const adapterSource = editorSource.slice(
  editorSource.indexOf('async function exportMotionVideo('),
  editorSource.indexOf('\n      function setExportBusy(')
);
assert.ok(adapterSource.includes('createVideoExportSnapshot()'));
for (const scenario of ['success', 'record-failure', 'download-failure', 'create-failure', 'unsupported', 'cleared-during-export']) {
  await test(`editor adapter ${scenario} preserves immutable snapshot ownership`, async () => {
    let disposed = 0;
    let created = 0;
    let downloaded = 0;
    const snapshot = { canvas: {}, renderFrame() {}, dispose() { disposed += 1; } };
    const statuses = [];
    const context = {
      state: { storageEpoch: 0 },
      getVideoExportFormat: () => scenario === 'unsupported' ? null : { label: 'Video' },
      createVideoExportSnapshot() {
        created += 1;
        if (scenario === 'create-failure') throw new Error('Snapshot allocation failed');
        return snapshot;
      },
      videoExportController: new AbortController(),
      setStatus: (key) => statuses.push(key),
      downloadBlob() {
        if (scenario === 'download-failure') throw new Error('Download failed');
        downloaded += 1;
      },
      window: { AsciiMotionExport: { async record(options) {
        assert.equal(options.canvas, snapshot.canvas);
        assert.equal(options.renderFrame, snapshot.renderFrame);
        assert.equal(options.durationMs, 6000);
        assert.equal(options.fps, 24);
        assert.equal(options.signal, context.videoExportController.signal);
        if (scenario === 'record-failure') throw new Error('Recording failed');
        if (scenario === 'cleared-during-export') context.state.storageEpoch += 1;
        return { blob: new Blob(['video']), extension: 'webm', label: 'WebM' };
      } } }
    };
    vm.runInNewContext(`${adapterSource}; globalThis.exportVideo = exportMotionVideo;`, context);
    if (scenario.endsWith('failure')) await assert.rejects(context.exportVideo());
    else await context.exportVideo();
    assert.equal(created, scenario === 'unsupported' ? 0 : 1);
    assert.equal(disposed, scenario === 'unsupported' || scenario === 'create-failure' ? 0 : 1);
    assert.equal(downloaded, scenario === 'success' ? 1 : 0);
    if (scenario === 'unsupported') assert.deepEqual(statuses, ['statusVideoUnsupported']);
  });
}

console.log(`Motion export regressions passed (${completed} scenarios; synthetic codecs, real WebM parser).`);
