'use strict';

const DEFAULT_SETTINGS = { enabled: true };

// The five fields EFF's Cover Your Tracks checks for cross-domain
// randomization. If ≥ 4 of these differ between first-party domains,
// the EFF result becomes "your browser has a randomized fingerprint".
const EFF_FIELDS = [
  { icon: '🔊', label: 'AudioContext'        },
  { icon: '🖼️', label: 'Canvas hash'         },
  { icon: '🎮', label: 'WebGL hash'          },
  { icon: '🧩', label: 'Plugins'             },
  { icon: '⚙️', label: 'Hardware concurrency' },
];

let currentSettings = null;

async function loadSettings() {
  const r = await browser.storage.local.get('settings');
  if (!r.settings) {
    await browser.storage.local.set({ settings: DEFAULT_SETTINGS });
    return { ...DEFAULT_SETTINGS };
  }
  return { ...DEFAULT_SETTINGS, ...r.settings };
}

async function saveSettings(s) {
  await browser.storage.local.set({ settings: s });
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
    text.textContent  = 'Randomizing';
  } else {
    banner.className = 'status-banner inactive';
    icon.textContent  = '⚠️';
    text.textContent  = 'Disabled — reload pages';
  }
}

function renderFields(enabled) {
  const list = document.getElementById('protectionsList');
  list.innerHTML = '';
  for (const f of EFF_FIELDS) {
    const row = document.createElement('div');
    row.className = 'protection-row ' + (enabled ? 'on' : 'off');
    row.innerHTML =
      '<div class="protection-left">' +
      '<span class="protection-icon">' + f.icon + '</span>' +
      '<span class="protection-name">' + f.label + '</span>' +
      '</div>' +
      '<div class="protection-dot"></div>';
    list.appendChild(row);
  }
}

async function init() {
  currentSettings = await loadSettings();

  const toggle = document.getElementById('globalToggle');
  toggle.checked = currentSettings.enabled;
  toggle.addEventListener('change', async () => {
    currentSettings.enabled = toggle.checked;
    await saveSettings(currentSettings);
    renderStatus(currentSettings.enabled);
    renderFields(currentSettings.enabled);
  });

  document.getElementById('resetBtn').addEventListener('click', async () => {
    currentSettings = { ...DEFAULT_SETTINGS };
    await saveSettings(currentSettings);
    toggle.checked = currentSettings.enabled;
    renderStatus(currentSettings.enabled);
    renderFields(currentSettings.enabled);
  });

  renderStatus(currentSettings.enabled);
  renderFields(currentSettings.enabled);
  renderSeed();
}

document.addEventListener('DOMContentLoaded', init);
