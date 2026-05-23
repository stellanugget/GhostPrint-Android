'use strict';

const DEFAULT_SETTINGS = {
  enabled: true,
  protections: {
    canvas: true, webgl: true, audio: true, navigator: true,
    screen: true, webrtc: true, battery: true, fonts: true,
    mediaDevices: true, timezone: true
  }
};

const PROTECTION_META = [
  { key: 'canvas',       icon: '🖼️',  label: 'Canvas'        },
  { key: 'webgl',        icon: '🎮',  label: 'WebGL'         },
  { key: 'audio',        icon: '🔊',  label: 'Audio'         },
  { key: 'navigator',    icon: '🧭',  label: 'Navigator'     },
  { key: 'screen',       icon: '🖥️',  label: 'Screen'        },
  { key: 'webrtc',       icon: '📡',  label: 'WebRTC'        },
  { key: 'battery',      icon: '🔋',  label: 'Battery'       },
  { key: 'fonts',        icon: '🔤',  label: 'Fonts'         },
  { key: 'mediaDevices', icon: '📷',  label: 'Media Devices' },
  { key: 'timezone',     icon: '🕒',  label: 'Timezone'      },
];

let currentSettings = null;

async function loadSettings() {
  const result = await browser.storage.local.get('settings');
  if (!result.settings) {
    await browser.storage.local.set({ settings: DEFAULT_SETTINGS });
    return DEFAULT_SETTINGS;
  }
  // Merge in case new keys were added in an update
  return { ...DEFAULT_SETTINGS, ...result.settings, protections: { ...DEFAULT_SETTINGS.protections, ...result.settings.protections } };
}

async function saveSettings(settings) {
  await browser.storage.local.set({ settings });
}

function renderSeed() {
  const el = document.getElementById('sessionSeed');
  const ts = Date.now();
  el.textContent = '0x' + ((ts ^ (ts >>> 16)) >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

function renderStatus(enabled) {
  const banner = document.getElementById('statusBanner');
  const icon   = document.getElementById('statusIcon');
  const text   = document.getElementById('statusText');

  if (enabled) {
    banner.className = 'status-banner active';
    icon.textContent  = '🛡️';
    text.textContent  = 'Protected';
  } else {
    banner.className = 'status-banner inactive';
    icon.textContent  = '⚠️';
    text.textContent  = 'Unprotected — reload page to apply';
  }
}

function renderProtections(settings) {
  const list = document.getElementById('protectionsList');
  list.innerHTML = '';

  for (const meta of PROTECTION_META) {
    const on = settings.enabled && (settings.protections[meta.key] !== false);

    const row = document.createElement('div');
    row.className = 'protection-row ' + (on ? 'on' : 'off');
    row.dataset.key = meta.key;
    row.innerHTML = `
      <div class="protection-left">
        <span class="protection-icon">${meta.icon}</span>
        <span class="protection-name">${meta.label}</span>
      </div>
      <div class="protection-dot"></div>
    `;

    row.addEventListener('click', async () => {
      if (!currentSettings.enabled) return;
      currentSettings.protections[meta.key] = !currentSettings.protections[meta.key];
      await saveSettings(currentSettings);
      renderProtections(currentSettings);
    });

    list.appendChild(row);
  }
}

async function init() {
  currentSettings = await loadSettings();

  const globalToggle = document.getElementById('globalToggle');
  globalToggle.checked = currentSettings.enabled;

  globalToggle.addEventListener('change', async () => {
    currentSettings.enabled = globalToggle.checked;
    await saveSettings(currentSettings);
    renderStatus(currentSettings.enabled);
    renderProtections(currentSettings);
  });

  document.getElementById('resetBtn').addEventListener('click', async () => {
    currentSettings = { ...DEFAULT_SETTINGS, protections: { ...DEFAULT_SETTINGS.protections } };
    await saveSettings(currentSettings);
    globalToggle.checked = currentSettings.enabled;
    renderStatus(currentSettings.enabled);
    renderProtections(currentSettings);
  });

  renderStatus(currentSettings.enabled);
  renderProtections(currentSettings);
  renderSeed();
}

document.addEventListener('DOMContentLoaded', init);
