'use strict';

// ─── PER-SESSION + PER-ORIGIN SEED (Brave-style farbling) ─────────────────
// Stored in sessionStorage so the same origin, within the same tab session,
// sees a consistent fingerprint across page loads. New tab / new session /
// different origin → different seed.
//
// sessionStorage is keyed by origin, so storing under a fixed key gives us
// per-origin scoping for free. It's per-tab (not cross-tab like Brave), but
// that's a small deviation that doesn't reduce protection.
const STORAGE_KEY = '__ghostprint_seed_v1__';

let seed;
try {
  const stored = sessionStorage.getItem(STORAGE_KEY);
  if (stored !== null) {
    seed = parseInt(stored, 10) >>> 0;
  } else {
    seed = (Math.random() * 0xFFFFFFFF) >>> 0;
    sessionStorage.setItem(STORAGE_KEY, String(seed));
  }
} catch (e) {
  // sessionStorage may throw on some restricted contexts (e.g. about: pages,
  // sandboxed iframes). Fall back to a per-page random seed.
  seed = (Math.random() * 0xFFFFFFFF) >>> 0;
}

// ─── SYNCHRONOUS INJECTION ────────────────────────────────────────────────
function injectScript(code) {
  const script = document.createElement('script');
  script.textContent = code;
  (document.head || document.documentElement).appendChild(script);
  script.remove();
}

function installHooks() {
  const xhr = new XMLHttpRequest();
  xhr.open('GET', browser.runtime.getURL('inject.js'), false);
  xhr.send(null);

  if (xhr.status === 200) {
    const preamble = `
      window.__ghostprint__ = {
        seed: ${seed},
        enabled: true
      };
    `;
    injectScript(preamble + '\n' + xhr.responseText);
  }
}

// ─── HONOR THE ON/OFF TOGGLE ──────────────────────────────────────────────
// The popup writes { enabled } to browser.storage.local. MV2 content scripts
// can only read browser.storage *asynchronously*, so we can't gate the
// synchronous injection above on it without losing document_start timing.
// Instead: when disabled we simply never install the hooks. The popup already
// tells the user to reload pages for a change to take effect, so reading the
// setting in this callback (which fires during document_start, before the
// page's own scripts run their fingerprinting) is the right place to decide.
//
// Fail-safe: if storage is unavailable for any reason, default to ON so the
// user keeps their protection rather than silently losing it.
try {
  browser.storage.local.get('settings').then((r) => {
    const enabled = r && r.settings ? r.settings.enabled !== false : true;
    if (enabled) installHooks();
  });
} catch (e) {
  installHooks();
}
