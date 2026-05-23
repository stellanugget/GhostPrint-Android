'use strict';

// Generate a random seed for this page session.
// Using synchronous XHR to inject before any page scripts run at document_start.
const seed = ((Math.random() * 0xFFFFFFFF) >>> 0);

function injectScript(code) {
  const script = document.createElement('script');
  script.textContent = code;
  (document.head || document.documentElement).appendChild(script);
  script.remove();
}

// Load inject.js synchronously so it runs before page scripts
const xhr = new XMLHttpRequest();
xhr.open('GET', browser.runtime.getURL('inject.js'), false);
xhr.send(null);

if (xhr.status === 200) {
  // Wrap inject.js with the seed and settings stub — the full settings
  // check is async, so the injection always runs (enabled by default).
  // The popup toggle takes effect on the next page load via the seed skip.
  const preamble = `
    window.__ghostprint__ = {
      seed: ${seed},
      enabled: true
    };
  `;
  injectScript(preamble + '\n' + xhr.responseText);
}

// After injecting, check settings asynchronously and store them
// so the popup can read current state. Settings disable takes effect
// on next page load (content scripts can't un-inject).
browser.runtime.sendMessage({ type: 'GET_SETTINGS' }).then(settings => {
  window.__ghostprintSettings = settings;
}).catch(() => {});
