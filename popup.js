const dot             = document.getElementById('dot');
const status          = document.getElementById('status');
const count           = document.getElementById('count');
const toggle          = document.getElementById('muteInactiveToggle');
const closeToggle      = document.getElementById('closeOnStreamEndToggle');
const autoReloadToggle = document.getElementById('autoReloadToggle');
const switchOnAdToggle    = document.getElementById('switchOnAdToggle');
const returnOnAdEndToggle = document.getElementById('returnOnAdEndToggle');

// ── Current tab status ────────────────────────────────────────────────────────

chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  chrome.storage.local.get([`adState_${tab?.id}`, 'totalMutes', 'muteInactive', 'closeOnStreamEnd', 'autoReloadOnCrash', 'switchOnAd', 'returnOnAdEnd'], (data) => {
    // Ad status
    if (!tab?.url?.includes('twitch.tv')) {
      dot.className = 'dot idle';
      status.textContent = 'Not on Twitch';
    } else if (data[`adState_${tab.id}`] === true) {
      dot.className = 'dot ad';
      status.textContent = 'Ad playing — tab muted';
    } else {
      dot.className = 'dot clear';
      status.textContent = 'No ad — tab unmuted';
    }

    count.textContent = data.totalMutes || 0;
    toggle.checked = data.muteInactive ?? false;
    closeToggle.checked      = data.closeOnStreamEnd  ?? true;
    autoReloadToggle.checked = data.autoReloadOnCrash ?? true;
    switchOnAdToggle.checked    = data.switchOnAd    ?? false;
    returnOnAdEndToggle.checked = data.returnOnAdEnd ?? false;
  });
});

// ── Toggle: mute inactive tabs ────────────────────────────────────────────────

toggle.addEventListener('change', () => {
  // Writing to storage triggers storage.onChanged in background.js,
  // which immediately mutes/unmutes the relevant tabs.
  chrome.storage.local.set({ muteInactive: toggle.checked });
});

closeToggle.addEventListener('change', () => {
  chrome.storage.local.set({ closeOnStreamEnd: closeToggle.checked });
});

autoReloadToggle.addEventListener('change', () => {
  chrome.storage.local.set({ autoReloadOnCrash: autoReloadToggle.checked });
});

switchOnAdToggle.addEventListener('change', () => {
  chrome.storage.local.set({ switchOnAd: switchOnAdToggle.checked });
});

returnOnAdEndToggle.addEventListener('change', () => {
  chrome.storage.local.set({ returnOnAdEnd: returnOnAdEndToggle.checked });
});

document.getElementById('helpBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('help.html') });
});
