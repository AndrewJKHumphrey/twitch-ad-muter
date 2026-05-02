const dot             = document.getElementById('dot');
const status          = document.getElementById('status');
const count           = document.getElementById('count');
const toggle               = document.getElementById('muteInactiveToggle');
const muteOnNonStreamToggle = document.getElementById('muteOnNonStreamToggle');
const closeToggle          = document.getElementById('closeOnStreamEndToggle');
const autoReloadToggle     = document.getElementById('autoReloadToggle');
const switchOnAdToggle     = document.getElementById('switchOnAdToggle');
const returnOnAdEndToggle  = document.getElementById('returnOnAdEndToggle');
const langSelect      = document.getElementById('langSelect');

// ── Language ──────────────────────────────────────────────────────────────────

function applyLang(lang) {
  applyTranslations(lang);
  // Status text is set dynamically — re-run tab query to refresh it
  updateStatus(lang);
}

let currentLang = 'en';

chrome.storage.local.get({ language: 'en' }, (data) => {
  currentLang = data.language;
  langSelect.value = currentLang;
  applyLang(currentLang);
});

langSelect.addEventListener('change', () => {
  currentLang = langSelect.value;
  chrome.storage.local.set({ language: currentLang });
  applyLang(currentLang);
});

// ── Current tab status ────────────────────────────────────────────────────────

function updateStatus(lang) {
  const t = TRANSLATIONS[lang] || TRANSLATIONS.en;
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    chrome.storage.local.get([`adState_${tab?.id}`, 'totalMutes', 'muteInactive', 'muteOnNonStream', 'closeOnStreamEnd', 'autoReloadOnCrash', 'switchOnAd', 'returnOnAdEnd'], (data) => {
      if (!tab?.url?.includes('twitch.tv')) {
        dot.className = 'dot idle';
        status.textContent = t.statusNotTwitch;
      } else if (data[`adState_${tab.id}`] === true) {
        dot.className = 'dot ad';
        status.textContent = t.statusAdPlaying;
      } else {
        dot.className = 'dot clear';
        status.textContent = t.statusNoAd;
      }

      count.textContent = data.totalMutes || 0;
      toggle.checked = data.muteInactive ?? false;
      muteOnNonStreamToggle.checked = data.muteOnNonStream ?? false;
      closeToggle.checked      = data.closeOnStreamEnd  ?? true;
      autoReloadToggle.checked = data.autoReloadOnCrash ?? true;
      switchOnAdToggle.checked    = data.switchOnAd    ?? false;
      returnOnAdEndToggle.checked = data.returnOnAdEnd ?? false;
    });
  });
}

// ── Toggles ───────────────────────────────────────────────────────────────────

toggle.addEventListener('change', () => {
  chrome.storage.local.set({ muteInactive: toggle.checked });
});

muteOnNonStreamToggle.addEventListener('change', () => {
  chrome.storage.local.set({ muteOnNonStream: muteOnNonStreamToggle.checked });
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



// ── Hidden streamers chip list ────────────────────────────────────────────────

function renderHiddenStreamers(list) {
  const container = document.getElementById('hiddenStreamersList');
  const countEl   = document.getElementById('hiddenStreamersCount');
  const t = TRANSLATIONS[currentLang] || TRANSLATIONS.en;
  container.innerHTML = '';
  countEl.textContent = list.length ? `(${list.length})` : '';
  if (!list.length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'font-size:11px;color:#adadb8;padding-top:4px;';
    empty.textContent = t.popup_hiddenStreamers_empty || 'None hidden';
    container.appendChild(empty);
    return;
  }
  list.forEach(username => {
    const chip = document.createElement('span');
    chip.style.cssText = 'display:inline-flex;align-items:center;gap:4px;background:#2a2a2d;border-radius:12px;padding:2px 8px;margin:2px 2px 2px 0;font-size:11px;';
    chip.textContent = username;
    const x = document.createElement('button');
    x.textContent = '\u00d7';
    x.style.cssText = 'background:none;border:none;color:#adadb8;cursor:pointer;padding:0 0 0 2px;font-size:13px;line-height:1;';
    x.addEventListener('click', () => removeHiddenStreamer(username));
    chip.appendChild(x);
    container.appendChild(chip);
  });
}

function removeHiddenStreamer(username) {
  chrome.storage.local.get('hiddenStreamers', ({ hiddenStreamers: arr }) => {
    const updated = (arr || []).filter(u => u !== username);
    chrome.storage.local.set({ hiddenStreamers: updated }, () => {
      renderHiddenStreamers(updated);
    });
  });
}

document.getElementById('hiddenStreamersHeader').addEventListener('click', () => {
  const list = document.getElementById('hiddenStreamersList');
  list.style.display = list.style.display === 'none' ? 'block' : 'none';
});

chrome.storage.local.get('hiddenStreamers', ({ hiddenStreamers: arr }) => {
  renderHiddenStreamers(arr || []);
});

document.getElementById('helpBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('help.html') });
});
