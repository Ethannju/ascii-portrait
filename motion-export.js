(function installMotionExport(global) {
  'use strict';

  const format = Object.freeze({ mimeType: 'video/webm', extension: 'webm', label: 'WebM' });
  const codecs = [
    { codec: 'vp09.00.40.08', id: 'V_VP9', mimeType: 'video/webm;codecs=vp9' },
    { codec: 'vp8', id: 'V_VP8', mimeType: 'video/webm;codecs=vp8' }
  ];
  const BATCH_SIZE = 8;
  const OPERATION_TIMEOUT_MS = 60_000;
  // Safari 26 can return a VideoFrame timestamp 1 µs below the integer it was
  // given (1041667 becomes 1041666). The WebM is written from the exact timeline
  // below, so only that rounding is tolerated; a missing, duplicated, or
  // reordered frame is still off by a whole frame interval.
  const TIMESTAMP_TOLERANCE_US = 1;

  function exportError(message, name = 'EncodingError') {
    const error = new Error(message);
    error.name = name;
    return error;
  }

  function getPreferredFormat() {
    // This is only the synchronous UI capability check. Codec support at the
    // requested dimensions is checked asynchronously before rendering any frame.
    return typeof global.VideoEncoder === 'function' &&
      typeof global.VideoEncoder.isConfigSupported === 'function' &&
      typeof global.VideoFrame === 'function' ? format : null;
  }

  function bytesTogether(parts) {
    const bytes = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0));
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    return bytes;
  }

  function unsigned(value, width = 0) {
    if (!Number.isSafeInteger(value) || value < 0) throw exportError('Invalid WebM integer.');
    const bytes = [];
    do {
      bytes.unshift(value % 256);
      value = Math.floor(value / 256);
    } while (value);
    if (width && bytes.length > width) throw exportError('WebM integer overflow.');
    while (bytes.length < width) bytes.unshift(0);
    return new Uint8Array(bytes);
  }

  function elementSize(value) {
    // EBML sizes reserve the all-ones value for unknown size. Every element here
    // has a known size, including Segment and Cluster.
    let width = 1;
    while (value >= 2 ** (7 * width) - 1) width += 1;
    if (width > 8) throw exportError('The WebM file is too large.');
    const bytes = unsigned(value, width);
    bytes[0] |= 1 << (8 - width);
    return bytes;
  }

  function element(id, data) {
    const body = Array.isArray(data) ? bytesTogether(data) : data;
    return bytesTogether([unsigned(id), elementSize(body.byteLength), body]);
  }

  const uintElement = (id, value, width) => element(id, unsigned(value, width));
  const textElement = (id, value) => element(id, new Uint8Array(Array.from(value, (char) => char.charCodeAt(0))));

  function floatElement(id, value) {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setFloat64(0, value, false);
    return element(id, bytes);
  }

  function muxWebm(chunks, codec, width, height, durationUs) {
    // WebM / Matroska: https://www.webmproject.org/docs/container/
    // https://www.rfc-editor.org/rfc/rfc9559.html (timestamps, BlockDuration,
    // ReferenceBlock). A 1,000 ns tick preserves WebCodecs' integer microseconds.
    // One frame per Cluster keeps its signed 16-bit relative timestamp at zero.
    const header = element(0x1a45dfa3, [
      uintElement(0x4286, 1), uintElement(0x42f7, 1),
      uintElement(0x42f2, 4), uintElement(0x42f3, 8),
      textElement(0x4282, 'webm'), uintElement(0x4287, 4), uintElement(0x4285, 2)
    ]);
    const info = element(0x1549a966, [
      uintElement(0x2ad7b1, 1000), floatElement(0x4489, durationUs),
      textElement(0x4d80, 'ASCII Portrait'), textElement(0x5741, 'ASCII Portrait')
    ]);
    const trackFields = [
      uintElement(0xd7, 1), uintElement(0x73c5, 1), uintElement(0x83, 1),
      uintElement(0x9c, 0), textElement(0x86, codec.id),
      uintElement(0x23e383, Math.round(durationUs * 1000 / chunks.length)),
      element(0xe0, [
        uintElement(0xb0, width), uintElement(0xba, height),
        uintElement(0x54b0, width), uintElement(0x54ba, height), uintElement(0x54b2, 0)
      ])
    ];
    if (codec.id === 'V_VP9') {
      // VP9 Codec Feature Format: profile 0, level 4.0, 8-bit, matching the
      // negotiated codec string. VP8 has no CodecPrivate data.
      trackFields.push(element(0x63a2, new Uint8Array([1, 1, 0, 2, 1, 40, 3, 1, 8])));
    }
    const tracks = element(0x1654ae6b, [element(0xae, trackFields)]);
    const clusters = chunks.map((chunk) => {
      const fields = [
        // Track 1, relative timestamp 0, no lacing. Block (unlike SimpleBlock)
        // has no keyframe bit; absence of ReferenceBlock identifies a keyframe.
        element(0xa1, [new Uint8Array([0x81, 0, 0, 0]), chunk.bytes]),
        uintElement(0x9b, chunk.duration)
      ];
      // WebCodecs exposes key/delta, not the codec's reference-frame graph.
      // RFC 9559 explicitly permits 0 to mean an unknown dependency.
      if (chunk.type !== 'key') fields.push(element(0xfb, new Uint8Array([0])));
      return element(0x1f43b675, [uintElement(0xe7, chunk.timestamp), element(0xa0, fields)]);
    });

    const makeSeekHead = (positions) => element(0x114d9b74,
      [0x1549a966, 0x1654ae6b, 0x1c53bb6b].map((id, index) => element(0x4dbb, [
        element(0x53ab, unsigned(id)), uintElement(0x53ac, positions[index], 8)
      ])));
    // Fixed-width SeekPosition fields let us compute final byte offsets once.
    const seekSize = makeSeekHead([0, 0, 0]).byteLength;
    let position = seekSize + info.byteLength + tracks.byteLength;
    const cuePoints = [];
    chunks.forEach((chunk, index) => {
      if (chunk.type === 'key') {
        cuePoints.push(element(0xbb, [
          uintElement(0xb3, chunk.timestamp),
          element(0xb7, [uintElement(0xf7, 1), uintElement(0xf1, position)])
        ]));
      }
      position += clusters[index].byteLength;
    });
    const cues = element(0x1c53bb6b, cuePoints);
    const seekHead = makeSeekHead([seekSize, seekSize + info.byteLength, position]);
    const parts = [seekHead, info, tracks, ...clusters, cues];
    const segmentSize = parts.reduce((size, part) => size + part.byteLength, 0);
    return new Blob([header, unsigned(0x18538067), elementSize(segmentSize), ...parts], { type: codec.mimeType });
  }

  async function record({ canvas, renderFrame, durationMs = 6000, fps = 24, signal, onProgress } = {}) {
    if (!getPreferredFormat()) {
      throw exportError('This browser does not support frame-by-frame WebM export. Use a browser with WebCodecs video encoding.', 'NotSupportedError');
    }
    if (!canvas || !Number.isInteger(canvas.width) || !Number.isInteger(canvas.height) ||
        canvas.width <= 0 || canvas.height <= 0 || typeof renderFrame !== 'function' ||
        !Number.isFinite(durationMs) || durationMs <= 0 || !Number.isFinite(fps) || fps <= 0 || fps > 120) {
      throw new TypeError('Video export requires a sized canvas, renderer, positive duration, and valid frame rate.');
    }
    const width = canvas.width;
    const height = canvas.height;
    const durationUs = Math.round(durationMs * 1000);
    const frameCount = Math.max(1, Math.round(durationMs * fps / 1000));
    if (!Number.isSafeInteger(durationUs * 1000) || !Number.isSafeInteger(frameCount) || durationUs < frameCount) {
      throw new TypeError('The video timeline cannot be represented accurately.');
    }
    const timestampFor = (index) => Math.round(index * durationUs / frameCount);
    const chunks = [];
    const waiters = new Set();
    const yieldTimers = new Set();
    let encoder;
    let failure;
    let finished = false;
    let submitted = 0;

    const closeEncoder = () => {
      if (encoder && encoder.state !== 'closed') {
        try { encoder.close(); } catch (_) { /* Cleanup must not mask the original error. */ }
      }
    };
    const fail = (error) => {
      if (failure || finished) return;
      failure = error;
      closeEncoder();
      for (const reject of [...waiters]) reject(error);
    };
    const cancel = () => fail(exportError('Video export was cancelled. Keep this tab visible while encoding.', 'AbortError'));
    const onVisibility = () => { if (global.document?.hidden) cancel(); };
    const checkActive = () => {
      if (signal?.aborted || global.document?.hidden) cancel();
      if (failure) throw failure;
    };
    const waitFor = (promise, operation) => {
      checkActive();
      return new Promise((resolve, reject) => {
        let settled = false;
        let timer;
        const settle = (error, value) => {
          if (settled) return;
          settled = true;
          global.clearTimeout(timer);
          waiters.delete(stop);
          if (error) reject(error);
          else resolve(value);
        };
        const stop = (error) => settle(error);
        waiters.add(stop);
        timer = global.setTimeout(() => fail(exportError(`Video ${operation} did not finish in time.`, 'TimeoutError')), OPERATION_TIMEOUT_MS);
        Promise.resolve(promise).then((value) => settle(failure, value), (error) => settle(failure || error));
      });
    };
    const yieldToPage = () => waitFor(new Promise((resolve) => {
      const timer = global.setTimeout(() => { yieldTimers.delete(timer); resolve(); }, 0);
      yieldTimers.add(timer);
    }), 'rendering');

    global.document?.addEventListener('visibilitychange', onVisibility);
    global.addEventListener('pagehide', cancel);
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      checkActive();
      let selected;
      let config;
      for (const candidate of codecs) {
        const requested = {
          codec: candidate.codec, width, height, bitrate: 8_000_000,
          framerate: frameCount * 1_000_000 / durationUs,
          latencyMode: 'quality', bitrateMode: 'variable'
        };
        try {
          const support = await waitFor(global.VideoEncoder.isConfigSupported(requested), 'capability check');
          checkActive();
          if (support.supported) { selected = candidate; config = requested; break; }
        } catch (error) {
          checkActive();
          // An unsupported codec may reject instead of returning supported:false.
          if (error?.name !== 'NotSupportedError' && error?.name !== 'TypeError') throw error;
        }
      }
      if (!selected) throw exportError('This browser cannot encode VP9 or VP8 at the required resolution.', 'NotSupportedError');

      // WebCodecs quality mode must not drop frames to meet bitrate/framerate.
      // https://www.w3.org/TR/webcodecs/#enumdef-latencymode
      encoder = new global.VideoEncoder({
        output(chunk, metadata) {
          if (failure || finished) return;
          try {
            checkActive();
            const index = chunks.length;
            const timestamp = timestampFor(index);
            const duration = timestampFor(index + 1) - timestamp;
            if (index >= submitted || index >= frameCount ||
                !(Math.abs(chunk.timestamp - timestamp) <= TIMESTAMP_TOLERANCE_US) ||
                (chunk.duration != null && !(Math.abs(chunk.duration - duration) <= TIMESTAMP_TOLERANCE_US)) ||
                !chunk.byteLength ||
                (chunk.type !== 'key' && chunk.type !== 'delta') || (index === 0 && chunk.type !== 'key')) {
              throw exportError('The video encoder returned missing, reordered, or invalid frames.');
            }
            const decoded = metadata?.decoderConfig;
            if (decoded && ((decoded.codedWidth != null && decoded.codedWidth !== width) ||
                (decoded.codedHeight != null && decoded.codedHeight !== height) ||
                (decoded.codec && !(selected.id === 'V_VP9' ? decoded.codec.startsWith('vp09.') : decoded.codec === 'vp8')))) {
              throw exportError('The video encoder changed the required video format.');
            }
            const bytes = new Uint8Array(chunk.byteLength);
            chunk.copyTo(bytes);
            chunks.push({ bytes, timestamp, duration, type: chunk.type });
            onProgress?.(Math.min(0.99, chunks.length / frameCount));
          } catch (error) {
            fail(error);
          }
        },
        error(error) { fail(error || exportError('Video encoding failed.')); }
      });
      encoder.configure(config);
      checkActive();
      onProgress?.(0);
      let lastKeyTimestamp = -1_000_000;
      for (let index = 0; index < frameCount; index += 1) {
        checkActive();
        if (canvas.width !== width || canvas.height !== height) throw exportError('The export canvas size changed during encoding.');
        // Sample exactly one cycle without a duplicate endpoint. Render time is
        // independent of wall-clock speed and retains the original precision.
        renderFrame(index * durationMs / frameCount, canvas);
        checkActive();
        if (canvas.width !== width || canvas.height !== height) throw exportError('The export renderer changed the canvas size.');
        const timestamp = timestampFor(index);
        const duration = timestampFor(index + 1) - timestamp;
        const frame = new global.VideoFrame(canvas, { timestamp, duration });
        try {
          const keyFrame = timestamp - lastKeyTimestamp >= 1_000_000;
          if (keyFrame) lastKeyTimestamp = timestamp;
          submitted += 1;
          encoder.encode(frame, { keyFrame });
        } finally {
          frame.close();
        }
        checkActive();
        // Strong backpressure also bounds internal look-ahead, not only the
        // public encodeQueueSize. Do not reset/reconfigure between batches.
        if (submitted % BATCH_SIZE === 0) await waitFor(encoder.flush(), 'encoding');
        await yieldToPage();
      }
      await waitFor(encoder.flush(), 'finalization');
      checkActive();
      if (chunks.length !== frameCount) throw exportError(`The video encoder produced ${chunks.length} of ${frameCount} frames.`);
      const blob = muxWebm(chunks, selected, width, height, durationUs);
      checkActive();
      if (!blob.size) throw exportError('Video encoding returned an empty result.');
      onProgress?.(1);
      checkActive();
      return { blob, mimeType: selected.mimeType, extension: 'webm', label: 'WebM', frameCount: chunks.length, durationMs: durationUs / 1000 };
    } finally {
      finished = true;
      closeEncoder();
      for (const timer of yieldTimers) global.clearTimeout(timer);
      yieldTimers.clear();
      global.document?.removeEventListener('visibilitychange', onVisibility);
      global.removeEventListener('pagehide', cancel);
      signal?.removeEventListener('abort', cancel);
      chunks.length = 0;
    }
  }

  global.AsciiMotionExport = Object.freeze({ getPreferredFormat, record });
})(window);
