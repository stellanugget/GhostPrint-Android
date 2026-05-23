'use strict';

const SPOOFED_UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0';

const DEFAULT_SETTINGS = {
  enabled: true,
  protections: {
    canvas: true,
    webgl: true,
    audio: true,
    navigator: true,
    screen: true,
    webrtc: true,
    battery: true,
    fonts: true,
    mediaDevices: true,
    timezone: true,
    userAgent: true
  }
};

async function ensureSettings() {
  const result = await browser.storage.local.get('settings');
  if (!result.settings) {
    await browser.storage.local.set({ settings: DEFAULT_SETTINGS });
  }
}

browser.runtime.onInstalled.addListener(ensureSettings);
browser.runtime.onStartup.addListener(ensureSettings);

// ─── HTTP HEADER REWRITING ─────────────────────────────────────────────
// Rewrites the User-Agent header on outgoing requests so the value matches
// what we spoof in navigator.userAgent. Without this, the HTTP layer leaks
// the real Firefox 153 string and EFF (and trackers) read it directly.
//
// We deliberately leave Accept-Language and Accept untouched per user
// preference — keeping pt-BR for normal browsing.

let uaSpoofingEnabled = true;

async function loadUASpoofPreference() {
  const result = await browser.storage.local.get('settings');
  const s = result.settings || DEFAULT_SETTINGS;
  uaSpoofingEnabled = s.enabled && (s.protections.userAgent !== false);
}

loadUASpoofPreference();
browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) loadUASpoofPreference();
});

browser.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (!uaSpoofingEnabled) return {};
    for (const h of details.requestHeaders) {
      if (h.name.toLowerCase() === 'user-agent') {
        h.value = SPOOFED_UA;
      }
    }
    return { requestHeaders: details.requestHeaders };
  },
  { urls: ['<all_urls>'] },
  ['blocking', 'requestHeaders']
);

// ─── MESSAGE HANDLERS ──────────────────────────────────────────────────
browser.runtime.onMessage.addListener((message) => {
  if (message.type === 'GET_SETTINGS') {
    return browser.storage.local.get('settings').then(result => {
      return result.settings || DEFAULT_SETTINGS;
    });
  }
  if (message.type === 'SET_SETTINGS') {
    return browser.storage.local.set({ settings: message.settings });
  }
  if (message.type === 'RESET_SETTINGS') {
    return browser.storage.local.set({ settings: DEFAULT_SETTINGS });
  }
});
