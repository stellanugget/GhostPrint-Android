// GhostPrint — runs in the page's JavaScript context.
//
// Sole goal: make EFF's Cover Your Tracks show
// "your browser has a randomized fingerprint" (the green Brave-equivalent
// status). EFF awards that status when ≥ 4 of these 5 fields differ between
// first-party domains:
//   audio, canvas_hash_v2, webgl_hash_v2, plugins, hardware_concurrency
//
// EFF computes each of those fields TWICE per page (in the same document)
// and only treats it as a real value if both runs match. So the noise we add
// has to be DETERMINISTIC per-input (same input + same seed → same output)
// — not state-advancing — otherwise both runs of the same page produce
// different hashes, EFF marks the field as "randomized" within the page,
// and the cross-domain comparison sees two equal "randomized" strings
// instead of two different hashes.

(function () {
  'use strict';

  const cfg = window.__ghostprint__;
  if (!cfg || !cfg.enabled) return;
  const SEED = cfg.seed >>> 0;

  // ─── Deterministic hash mixer ────────────────────────────────────────────
  // Stateless 32-bit hash of arbitrary ints + the per-origin seed.
  // Same args → same result, always. Different SEED → different result.
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

  const clamp = (v) => v < 0 ? 0 : v > 255 ? 255 : v;

  // ─── CANVAS ──────────────────────────────────────────────────────────────
  // Apply ±1 noise to ~5% of pixels, deterministic per (position, value).
  // Same canvas read twice → same modified pixels. Different seed → different
  // modified pixels.
  function farblePixels(data) {
    for (let i = 0; i < data.length; i += 4) {
      const h = mix(i, data[i], data[i + 1], data[i + 2]);
      if ((h & 0xff) < 13) {  // ~5% (13/256)
        data[i]     = clamp(data[i]     + ((h >>> 8)  % 3) - 1);
        data[i + 1] = clamp(data[i + 1] + ((h >>> 12) % 3) - 1);
        data[i + 2] = clamp(data[i + 2] + ((h >>> 16) % 3) - 1);
      }
    }
  }

  const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
  CanvasRenderingContext2D.prototype.getImageData = function (sx, sy, sw, sh) {
    const id = origGetImageData.call(this, sx, sy, sw, sh);
    farblePixels(id.data);
    return id;
  };

  // For toDataURL / toBlob we render into a temp canvas instead of mutating
  // the original — otherwise repeated calls would compound noise and each
  // call would return a different hash.
  function farbleToTempCanvas(srcCanvas) {
    const tmp = document.createElement('canvas');
    tmp.width = srcCanvas.width;
    tmp.height = srcCanvas.height;
    const ctx = tmp.getContext('2d');
    ctx.drawImage(srcCanvas, 0, 0);
    const id = origGetImageData.call(ctx, 0, 0, tmp.width, tmp.height);
    farblePixels(id.data);
    ctx.putImageData(id, 0, 0);
    return tmp;
  }

  const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function (type, quality) {
    if (this.width > 0 && this.height > 0) {
      try { return origToDataURL.call(farbleToTempCanvas(this), type, quality); }
      catch (_) {}
    }
    return origToDataURL.call(this, type, quality);
  };

  const origToBlob = HTMLCanvasElement.prototype.toBlob;
  HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
    if (this.width > 0 && this.height > 0) {
      try { return origToBlob.call(farbleToTempCanvas(this), callback, type, quality); }
      catch (_) {}
    }
    return origToBlob.call(this, callback, type, quality);
  };

  // ─── WEBGL ───────────────────────────────────────────────────────────────
  // Farble readPixels output deterministically — same as canvas.
  const origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    const ctx = origGetContext.call(this, type, attrs);
    if (ctx && (type === 'webgl' || type === 'experimental-webgl' || type === 'webgl2')) {
      const origReadPixels = ctx.readPixels.bind(ctx);
      ctx.readPixels = function (x, y, w, h, format, t, pixels) {
        origReadPixels(x, y, w, h, format, t, pixels);
        if (pixels && pixels.length) {
          for (let i = 0; i < pixels.length; i += 4) {
            const hash = mix(i, pixels[i] | 0, pixels[i + 1] | 0, pixels[i + 2] | 0);
            if ((hash & 0xff) < 13) {
              pixels[i]     = clamp(pixels[i]     + ((hash >>> 8)  % 3) - 1);
              pixels[i + 1] = clamp(pixels[i + 1] + ((hash >>> 12) % 3) - 1);
              pixels[i + 2] = clamp(pixels[i + 2] + ((hash >>> 16) % 3) - 1);
            }
          }
        }
      };
    }
    return ctx;
  };

  // ─── AUDIO ───────────────────────────────────────────────────────────────
  // OfflineAudioContext fingerprinting renders an oscillator+compressor
  // graph and reads the resulting PCM. We apply deterministic noise to the
  // rendered buffer's channel data, cached per channel so repeated reads
  // return the same modified samples.
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
        const intVal = (data[i] * 1e7) | 0;
        const h = mix(ch, i, intVal);
        if ((h & 0xff) < 8) {  // ~3% of samples
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

  // AnalyserNode-based audio fingerprinting (less common, but covered):
  // farble the byte/float frequency data with deterministic noise.
  if (AudioCtxClass) {
    const origCreateAnalyser = AudioCtxClass.prototype.createAnalyser;
    AudioCtxClass.prototype.createAnalyser = function () {
      const an = origCreateAnalyser.call(this);
      const origFloat = an.getFloatFrequencyData.bind(an);
      const origByte = an.getByteFrequencyData.bind(an);
      an.getFloatFrequencyData = function (arr) {
        origFloat(arr);
        for (let i = 0; i < arr.length; i++) {
          if (arr[i] > -Infinity) {
            const h = mix(i, (arr[i] * 1000) | 0);
            arr[i] += ((h / 0x100000000) - 0.5) * 1e-4;
          }
        }
      };
      an.getByteFrequencyData = function (arr) {
        origByte(arr);
        for (let i = 0; i < arr.length; i++) {
          const h = mix(i, arr[i]);
          if ((h & 0xff) < 32) arr[i] = clamp(arr[i] + ((h >>> 8) % 3) - 1);
        }
      };
      return an;
    };
  }

  // ─── HARDWARE CONCURRENCY ────────────────────────────────────────────────
  // Pick from a small pool of common values, deterministically from SEED.
  // Each origin gets a different seed (sessionStorage scopes by origin),
  // so navigating between EFF's first-party test domains produces different
  // values — that's what triggers EFF's randomized_results++.
  const HC_POOL = [2, 4, 6, 8, 12, 16];
  const spoofedHC = HC_POOL[mix(0xC0FFEE) % HC_POOL.length];
  defineGetter(Navigator.prototype, 'hardwareConcurrency', () => spoofedHC);

  // ─── PLUGINS ─────────────────────────────────────────────────────────────
  // EFF iterates navigator.plugins and stringifies (name, description,
  // filename, mime types). To get cross-domain randomization credit we need
  // this string to differ per origin. We expose a Proxy that returns the
  // real plugins plus 0-3 extra fake PDF-viewer-like entries chosen by SEED.
  try {
    const realPlugins = navigator.plugins;
    if (realPlugins && typeof realPlugins.length === 'number') {

      function fakeMime(type, description, suffixes) {
        return { type, description, suffixes, enabledPlugin: null };
      }

      const FAKE_POOL = [
        { name: 'WebKit built-in PDF',    description: 'Portable Document Format', filename: 'internal-pdf-viewer' },
        { name: 'PDF.js',                 description: 'Portable Document Format', filename: 'internal-pdf-viewer' },
        { name: 'Foxit PDF Viewer',       description: 'Portable Document Format', filename: 'internal-pdf-viewer' },
        { name: 'Native Client',          description: '',                         filename: 'internal-nacl-plugin' },
        { name: 'Brave PDF Viewer',       description: 'Portable Document Format', filename: 'internal-pdf-viewer' },
      ];

      const pdfMime = fakeMime('application/pdf', 'Portable Document Format', 'pdf');
      const textPdfMime = fakeMime('text/pdf', 'Portable Document Format', 'pdf');

      function makeFakePlugin(meta) {
        const p = {
          name: meta.name,
          description: meta.description,
          filename: meta.filename,
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

      // Pick 0..4 fake plugins to append based on SEED
      const extraCount = mix(0xBADC0DE) % FAKE_POOL.length;
      const fakes = [];
      for (let i = 0; i < extraCount; i++) {
        // Pick which one (rotate by seed so different origins get different sets)
        const idx = (mix(0xF00BAA, i) % FAKE_POOL.length);
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

      defineGetter(Navigator.prototype, 'plugins', () => proxyPlugins);
    }
  } catch (_) {}

  // Hide the preamble global so page scripts can't fingerprint *us*
  try { delete window.__ghostprint__; } catch (_) {}
})();
