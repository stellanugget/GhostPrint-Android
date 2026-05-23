'use strict';

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
    timezone: true
  }
};

async function ensureSettings() {
  const result = await browser.storage.local.get('settings');
  if (!result.settings) {
    await browser.storage.local.set({ settings: DEFAULT_SETTINGS });
  }
}

// Initialize on install AND on every startup (background can be killed/restarted)
browser.runtime.onInstalled.addListener(ensureSettings);
browser.runtime.onStartup.addListener(ensureSettings);

// Handle messages from content scripts and popup
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
