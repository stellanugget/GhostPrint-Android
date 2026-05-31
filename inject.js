// GhostPrint — runs in the page's JavaScript context.
//
// Sole goal: make EFF's Cover Your Tracks award the "your browser has a
// randomized fingerprint" status (the green badge Brave gets). That status
// requires ≥ 4 of these five fields to differ between first-party domains:
//   audio, canvas_hash_v2, webgl_hash_v2, plugins, hardware_concurrency
//
// CRITICAL: EFF runs each fingerprint TWICE per page. If our farbling depends
// on the source pixel values, and the browser's text/canvas rendering produces
// slight sub-pixel variations between two newly-drawn canvases (which it can),
// our output differs between the two runs → EFF marks it "randomized"
// *within page* → both first-party domains report the same "randomized"
// string → cross-domain check sees no difference → no credit.
//
// The fix: replace canvas read APIs with content that is a pure function of
// (canvas dimensions, pixel position, seed) — completely IGNORING the actual
// canvas pixels. Within a page: same dims + same seed = identical output on
// both Fingerprint2 runs. Across origins: different seed = different output.
// Audio's OfflineAudioContext rendering is mathematically deterministic, so
// keeping a per-channel cache of farbled samples works there.

(function () {
  'use strict';

  const cfg = window.__ghostprint__;
  if (!cfg || !cfg.enabled) return;
  const SEED = cfg.seed >>> 0;

  // ─── Deterministic 32-bit hash mixer ─────────────────────────────────────
  // Stateless. Same args + same SEED → same output, always.
  function mix() {
    let h = SEED;
    for (let i = 0; i < arguments.length; i++) {
      h = Math.imul(h ^ (arguments[i] >>> 0), 0x9e3779b9) >>> 0;
      h ^= h >>> 16;
    }
    return h >>> 0;
  }

  function defineGetter(obj, prop, getter) {
    try {
      Object.defineProperty(obj, prop, { get: getter, configurable: true, enumerable: true });
    } catch (_) {}
  }

  // ─── CANVAS ──────────────────────────────────────────────────────────────
  // Farble canvas reads the way Brave does: apply tiny, IMPERCEPTIBLE, seed-
  // determined noise to the *real* pixels instead of replacing them. This is
  // both correct for EFF and non-destructive for legitimate canvas use
  // (image editors, croppers, format converters, QR/chart exporters, etc.).
  //
  // Determinism is what makes this safe for EFF's twice-per-page probe: the
  // perturbation is a pure function of (seed, pixel position, source pixel
  // values). EFF draws the *same* probe canvas on both runs, so identical
  // source pixels + identical seed → byte-identical output → a stable hash
  // within the page. A different first-party origin has a different seed →
  // different noise → a different hash → the cross-domain difference EFF
  // rewards with the "randomized fingerprint" status.

  const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
  const origToDataURL    = HTMLCanvasElement.prototype.toDataURL;
  const origToBlob       = HTMLCanvasElement.prototype.toBlob;
  const origGetContext   = HTMLCanvasElement.prototype.getContext;
  const origCreateElement = Document.prototype.createElement;

  function clampByte(v) {
    return v < 0 ? 0 : v > 255 ? 255 : v;
  }

  // Perturb pixel data in place: nudge a sparse, seed-determined subset of
  // pixels by -1/0/+1 per RGB channel. Alpha is left untouched. The change is
  // visually undetectable but shifts the canvas hash deterministically.
  function farblePixels(data, width, height) {
    for (let i = 0; i + 3 < data.length; i += 4) {
      const h = mix(i, width, height, data[i], data[i + 1], data[i + 2]);
      if ((h & 0x1f) === 0) { // ~1 pixel in 32
        data[i]     = clampByte(data[i]     + ((h >>> 5)  % 3) - 1);
        data[i + 1] = clampByte(data[i + 1] + ((h >>> 11) % 3) - 1);
        data[i + 2] = clampByte(data[i + 2] + ((h >>> 17) % 3) - 1);
      }
    }
  }

  // Snapshot a canvas (2D or WebGL) into a fresh 2D canvas, farble it, and
  // return that canvas so the original is never mutated. Returns null if the
  // source can't be snapshotted (e.g. tainted/cross-origin) so callers fall
  // back to the unmodified original.
  function farbledCopy(src) {
    const w = src.width, h = src.height;
    if (w <= 0 || h <= 0) return null;
    try {
      const tmp = origCreateElement.call(document, 'canvas');
      tmp.width = w;
      tmp.height = h;
      const tctx = origGetContext.call(tmp, '2d');
      tctx.drawImage(src, 0, 0);
      const id = origGetImageData.call(tctx, 0, 0, w, h);
      farblePixels(id.data, w, h);
      tctx.putImageData(id, 0, 0);
      return tmp;
    } catch (_) {
      return null;
    }
  }

  CanvasRenderingContext2D.prototype.getImageData = function (sx, sy, sw, sh) {
    const id = origGetImageData.call(this, sx, sy, sw, sh);
    farblePixels(id.data, sw, sh);
    return id;
  };

  HTMLCanvasElement.prototype.toDataURL = function (type, quality) {
    const copy = farbledCopy(this);
    if (copy) return origToDataURL.call(copy, type, quality);
    return origToDataURL.call(this, type, quality);
  };

  HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
    const copy = farbledCopy(this);
    if (copy) return origToBlob.call(copy, callback, type, quality);
    return origToBlob.call(this, callback, type, quality);
  };

  // ─── WEBGL ───────────────────────────────────────────────────────────────
  // Fingerprint2 reads the rendered WebGL canvas via `gl.canvas.toDataURL()`
  // — the canvas override above handles that. We also farble readPixels for
  // fingerprinters that use it directly.
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    const ctx = origGetContext.call(this, type, attrs);
    if (ctx && (type === 'webgl' || type === 'experimental-webgl' || type === 'webgl2')) {
      const origReadPixels = ctx.readPixels.bind(ctx);
      ctx.readPixels = function (x, y, w, h, format, t, pixels) {
        origReadPixels(x, y, w, h, format, t, pixels);
        // Only perturb 8-bit pixel buffers (the usual fingerprinting case);
        // leave float/other formats untouched so a ±1 nudge can't corrupt
        // legitimate reads. Same imperceptible, deterministic noise as 2D.
        if (pixels && pixels.length &&
            (pixels instanceof Uint8Array || pixels instanceof Uint8ClampedArray)) {
          for (let i = 0; i + 3 < pixels.length; i += 4) {
            const hash = mix(i, w, h, pixels[i], pixels[i + 1], pixels[i + 2]);
            if ((hash & 0x1f) === 0) {
              pixels[i]     = clampByte(pixels[i]     + ((hash >>> 5)  % 3) - 1);
              pixels[i + 1] = clampByte(pixels[i + 1] + ((hash >>> 11) % 3) - 1);
              pixels[i + 2] = clampByte(pixels[i + 2] + ((hash >>> 17) % 3) - 1);
            }
          }
        }
      };
    }
    return ctx;
  };

  // ─── AUDIO ───────────────────────────────────────────────────────────────
  // OfflineAudioContext rendering is deterministic, so we can apply
  // value-dependent noise safely. Per-channel cache ensures repeated reads
  // of the same buffer return identical samples.
  const OfflineAudioCtxClass = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const AudioCtxClass = window.AudioContext || window.webkitAudioContext;

  function farbleAudioBuffer(buf) {
    if (!buf) return buf;
    const cache = new Map();
    const origGetChannelData = buf.getChannelData.bind(buf);
    buf.getChannelData = function (ch) {
      if (cache.has(ch)) return cache.get(ch);
      const data = origGetChannelData(ch);
      for (let i = 0; i < data.length; i++) {
        const h = mix(ch, i);
        if ((h & 0xff) < 8) {
          data[i] += ((h / 0x100000000) - 0.5) * 1e-4;
        }
      }
      cache.set(ch, data);
      return data;
    };
    return buf;
  }

  if (OfflineAudioCtxClass) {
    const origStartRendering = OfflineAudioCtxClass.prototype.startRendering;
    OfflineAudioCtxClass.prototype.startRendering = function () {
      return origStartRendering.call(this).then(farbleAudioBuffer);
    };
  }

  if (AudioCtxClass) {
    const origCreateAnalyser = AudioCtxClass.prototype.createAnalyser;
    AudioCtxClass.prototype.createAnalyser = function () {
      const an = origCreateAnalyser.call(this);
      const origFloat = an.getFloatFrequencyData.bind(an);
      const origByte = an.getByteFrequencyData.bind(an);
      an.getFloatFrequencyData = function (arr) {
        origFloat(arr);
        for (let i = 0; i < arr.length; i++) {
          const h = mix(i);
          if (arr[i] > -Infinity) arr[i] += ((h / 0x100000000) - 0.5) * 1e-4;
        }
      };
      an.getByteFrequencyData = function (arr) {
        origByte(arr);
        for (let i = 0; i < arr.length; i++) {
          const h = mix(i);
          if ((h & 0xff) < 32) {
            arr[i] = Math.max(0, Math.min(255, arr[i] + ((h >>> 8) % 3) - 1));
          }
        }
      };
      return an;
    };
  }

  // ─── HARDWARE CONCURRENCY ────────────────────────────────────────────────
  const HC_POOL = [2, 4, 6, 8, 12, 16];
  const spoofedHC = HC_POOL[mix(0xC0FFEE) % HC_POOL.length];
  defineGetter(Navigator.prototype, 'hardwareConcurrency', () => spoofedHC);
  // Also override on the navigator instance — some browsers define the
  // property there and prototype-level overrides get shadowed.
  defineGetter(navigator, 'hardwareConcurrency', () => spoofedHC);

  // ─── PLUGINS ─────────────────────────────────────────────────────────────
  // Append seed-determined fake plugins so the list differs per origin.
  // EFF iterates navigator.plugins → name/description/filename, sorts the
  // strings, and compares across first-party domains.
  //
  // Always inject 1-4 extras (never 0), and override on BOTH the instance
  // and the prototype — Firefox defines navigator.plugins on the instance,
  // so a prototype-only override gets shadowed and never takes effect.
  try {
    const realPlugins = navigator.plugins;
    if (realPlugins && typeof realPlugins.length === 'number') {

      function fakeMime(type, description, suffixes) {
        return { type, description, suffixes, enabledPlugin: null };
      }
      const pdfMime    = fakeMime('application/pdf', 'Portable Document Format', 'pdf');
      const textPdfMime = fakeMime('text/pdf',       'Portable Document Format', 'pdf');

      const FAKE_POOL = [
        'WebKit built-in PDF',
        'PDF.js',
        'Foxit PDF Viewer',
        'Native Client',
        'Brave PDF Viewer',
        'Edge PDF Viewer',
        'Safari PDF Reader',
        'Sumatra PDF',
      ];

      function makeFakePlugin(name) {
        const p = {
          name,
          description: 'Portable Document Format',
          filename: 'internal-pdf-viewer',
          length: 2,
          0: pdfMime,
          1: textPdfMime,
          item: function (i) { return this[i] || null; },
          namedItem: function (n) {
            if (n === 'application/pdf') return pdfMime;
            if (n === 'text/pdf') return textPdfMime;
            return null;
          },
        };
        return p;
      }

      // Always 1-4 extras (never 0) so plugin list always differs from the
      // baseline 5-PDF-viewer Firefox set.
      const extraCount = (mix(0xBADC0DE) % 4) + 1;
      const fakes = [];
      for (let i = 0; i < extraCount; i++) {
        const idx = mix(0xF00BAA, i) % FAKE_POOL.length;
        fakes.push(makeFakePlugin(FAKE_POOL[idx]));
      }

      const totalLen = realPlugins.length + fakes.length;

      const proxyPlugins = new Proxy(realPlugins, {
        get(target, prop) {
          if (prop === 'length') return totalLen;
          if (typeof prop === 'string' && /^\d+$/.test(prop)) {
            const idx = parseInt(prop, 10);
            if (idx < realPlugins.length) return realPlugins[idx];
            return fakes[idx - realPlugins.length];
          }
          if (prop === 'item') return function (i) {
            if (i < realPlugins.length) return realPlugins.item(i);
            return fakes[i - realPlugins.length] || null;
          };
          if (prop === 'namedItem') return function (n) {
            const fake = fakes.find((p) => p.name === n);
            if (fake) return fake;
            return realPlugins.namedItem(n);
          };
          if (prop === 'refresh') return function () {};
          if (prop === Symbol.iterator) {
            return function* () {
              for (let i = 0; i < realPlugins.length; i++) yield realPlugins[i];
              for (const f of fakes) yield f;
            };
          }
          return Reflect.get(target, prop);
        },
      });

      defineGetter(navigator, 'plugins', () => proxyPlugins);
      defineGetter(Navigator.prototype, 'plugins', () => proxyPlugins);
    }
  } catch (_) {}

  try { delete window.__ghostprint__; } catch (_) {}
})();
