// ── Ad detection ─────────────────────────────────────────────────────────────

// Known selector-based indicators (Twitch changes these periodically)
const AD_SELECTORS = [
  '[data-a-target="ad-countdown"]',
  '[data-test-selector="ad-overlay"]',
  '[data-test-selector="video-ad-label"]',
  '[data-a-target="player-ad-overlay"]',
  '[data-a-target="video-ad-label"]',
  '.video-ad-label',
  '[class*="player-ad-overlay"]',
  '[class*="ad-banner"]',
  '[class*="video-ad"]',
  '[class*="ad-countdown"]',
];

// Twitch renders a small "Ad" badge near the player controls.
// Search all text nodes inside/near the player for "Ad" or "Ads".
function hasAdBadge() {
  const player = document.querySelector('.video-player, [data-a-target="video-player"]');
  if (!player) return false;
  const walker = document.createTreeWalker(player, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const t = node.textContent.trim();
    if (t === 'Ad' || t === 'Ads') return true;
  }
  return false;
}

// Inject a script into page context to intercept HLS fetch calls.
// Twitch's m3u8 playlists contain "X-TV-TWITCH-AD" or "stitched-ad" markers
// when an ad segment is being served — this is the most reliable signal.
function injectPageScript() {
  const script = document.createElement('script');
  script.textContent = `
    (function() {
      let adActive = false;
      const orig = window.fetch;
      window.fetch = async function(...args) {
        const res = await orig.apply(this, args);
        const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
        if (url.includes('.m3u8')) {
          res.clone().text().then(body => {
            const isAd = body.includes('X-TV-TWITCH-AD') ||
                         body.includes('stitched-ad') ||
                         body.includes('ad-segment');
            if (isAd !== adActive) {
              adActive = isAd;
              window.postMessage({ source: 'twitch-ad-muter', isAd }, '*');
            }
          }).catch(() => {});
        }
        return res;
      };
    })();
  `;
  (document.head || document.documentElement).appendChild(script);
  script.remove();
}

injectPageScript();

// ── Hidden streamers ──────────────────────────────────────────────────────────

let hiddenStreamers = new Set();
chrome.storage.local.get('hiddenStreamers', ({ hiddenStreamers: arr }) => {
  hiddenStreamers = new Set((arr || []).map(s => s.toLowerCase()));
  applyHiding();
});

// Returns true if `el` contains links/data attributes pointing to streamers
// other than `username` — indicating it is a section/list rather than a card
// dedicated to one streamer.
function containsOtherStreamerRefs(el, username) {
  const logins = el.querySelectorAll('[data-login]');
  for (const l of logins) {
    if ((l.dataset.login || '').toLowerCase() !== username) return true;
  }
  const users = el.querySelectorAll('[data-a-user]');
  for (const u of users) {
    if ((u.dataset.aUser || '').toLowerCase() !== username) return true;
  }
  const links = el.querySelectorAll('a[href^="/"]');
  for (const a of links) {
    const href = (a.getAttribute('href') || '').toLowerCase();
    if (/^\/[a-z0-9_]+\/?$/.test(href) && !href.startsWith(`/${username}`)) return true;
  }
  return false;
}

// Walk up from a matched streamer link to find the full card container.
//
// Strategy: the card container is the element whose siblings are cards for
// *different* streamers.  We require "different" because multiple links to the
// same streamer (name link + avatar link) can share a parent that is still
// *inside* the card — stopping there would leave the offline text visible.
function getCardAncestor(el, username) {
  let node = el;
  // Track the most recent LI/ARTICLE we walked past — used only as a fallback
  // if sibling analysis fails to find a card boundary.  We can't short-circuit
  // on LI/ARTICLE because Twitch's directory wraps each <article> in several
  // grid-related <div>s, and the actual grid item is one of those outer divs.
  let semanticFallback = null;
  for (let i = 0; i < 14; i++) {
    node = node.parentElement;
    if (!node) break;

    if (!semanticFallback && (node.tagName === 'LI' || node.tagName === 'ARTICLE')) {
      semanticFallback = node;
    }

    const parent = node.parentElement;
    if (!parent) continue;

    if (parent.children.length > 1) {
      const sibs = Array.from(parent.children).filter(c => c !== node);
      const hasDifferentCard = sibs.some(sib => containsOtherStreamerRefs(sib, username));
      if (hasDifferentCard) return node;
    }
  }
  return semanticFallback;
}

// Hide an element and any same-level siblings that also reference the same streamer.
// This handles layouts (e.g. home page) where card content is split across sibling
// elements — thumbnail in one div, channel info in an adjacent sibling.
//
// We deliberately skip siblings that also reference *other* streamers — those
// are sections/lists (like search-page result groups) that contain the streamer
// alongside many others, and hiding them would over-hide unrelated content.
function hideWithSiblings(el, username) {
  el.dataset.qtHidden = username;
  el.style.display = 'none';

  const parent = el.parentElement;
  if (!parent) return;
  Array.from(parent.children).forEach(sib => {
    if (sib === el || sib.dataset.qtHidden) return;
    const refsStreamer = sib.querySelector(
      `a[href="/${username}" i], a[href^="/${username}/" i], a[href^="/${username}?" i], [data-login="${username}" i], [data-a-user="${username}" i]`
    );
    if (!refsStreamer) return;
    if (containsOtherStreamerRefs(sib, username)) return;
    sib.dataset.qtHidden = username;
    sib.style.display = 'none';
  });
}

// If the user navigated to a hidden streamer's channel page, send them home.
// Twitch reserved paths (/directory, /settings, …) won't be in hiddenStreamers,
// so a simple first-segment match is safe.
function redirectIfHiddenChannel() {
  const first = location.pathname.split('/')[1];
  if (first && hiddenStreamers.has(first.toLowerCase())) {
    location.replace('https://www.twitch.tv/');
  }
}

function applyHiding() {
  redirectIfHiddenChannel();

  if (!hiddenStreamers.size) {
    document.querySelectorAll('[data-qt-hidden]').forEach(el => {
      el.style.display = '';
      el.removeAttribute('data-qt-hidden');
    });
    return;
  }

  // Restore elements whose streamers are no longer in the hidden set
  document.querySelectorAll('[data-qt-hidden]').forEach(el => {
    if (!hiddenStreamers.has(el.dataset.qtHidden)) {
      el.style.display = '';
      el.removeAttribute('data-qt-hidden');
    }
  });

  // Hide elements matching any hidden streamer.
  // The " i" flag makes the attribute selectors case-insensitive — Twitch
  // sometimes preserves the original capitalization in hrefs (e.g. /YisLunae)
  // while we store usernames lowercase.
  for (const username of hiddenStreamers) {
    const selectors = [
      `a[href="/${username}" i]`,
      `a[href^="/${username}/" i]`,
      `a[href^="/${username}?" i]`,
      `[data-login="${username}" i]`,
      `[data-a-user="${username}" i]`,
    ];
    for (const sel of selectors) {
      document.querySelectorAll(sel).forEach(link => {
        const card = getCardAncestor(link, username) || link;
        if (!card.dataset.qtHidden) {
          hideWithSiblings(card, username);
        }
      });
    }
  }
}

// Reload hidden streamers from storage and re-apply
function refreshHiddenStreamers() {
  chrome.storage.local.get('hiddenStreamers', ({ hiddenStreamers: arr }) => {
    hiddenStreamers = new Set((arr || []).map(s => s.toLowerCase()));
    applyHiding();
  });
}

// Re-apply hiding whenever the stored list changes (e.g. popup chip removal)
chrome.storage.local.onChanged.addListener((changes) => {
  if ('hiddenStreamers' in changes) {
    hiddenStreamers = new Set((changes.hiddenStreamers.newValue || []).map(s => s.toLowerCase()));
    applyHiding();
  }
});


// Listen for page-context messages
// Track network signal separately so DOM polling cannot cancel a network-detected ad
let networkAdActive = false;
window.addEventListener('message', (e) => {
  if (e.data?.source !== 'twitch-ad-muter') return;
  networkAdActive = e.data.isAd;
  handleAdState(e.data.isAd, 'network');
});

// ── Tab title management ──────────────────────────────────────────────────────
//
// Both Primary and DNM replace '- Twitch' to prevent Twitch from recognising
// its own branding and fighting to overwrite the title in a loop.
// A single shared MutationObserver is used so the two states can't conflict.

const PRIMARY_SUFFIX = ' - Primary';
const DNM_SUFFIX     = ' - DNM';

let isPrimaryActive = false;
let isDnmActive     = false;
let titleObserver   = null;

// Strip any suffix we may have applied and return the base title
function getBaseTitle() {
  return document.title
    .replace(/ - Primary$/, ' - Twitch')
    .replace(/ - DNM$/, ' - Twitch');
}

// Apply whichever suffix is currently active (Primary takes precedence over DNM)
function applyTitleState() {
  if (isPrimaryActive) {
    if (document.title.endsWith(PRIMARY_SUFFIX)) return;
    document.title = getBaseTitle().replace(' - Twitch', ' - Primary');
  } else if (isDnmActive) {
    if (document.title.endsWith(DNM_SUFFIX)) return;
    document.title = getBaseTitle().replace(' - Twitch', '') + DNM_SUFFIX;
  } else {
    // Neither active — restore Twitch's original suffix if we've changed it
    const base = getBaseTitle();
    if (document.title !== base) document.title = base;
  }
}

function startTitleObserver() {
  if (titleObserver) return;
  const titleEl = document.querySelector('title');
  if (!titleEl) return;
  titleObserver = new MutationObserver(applyTitleState);
  titleObserver.observe(titleEl, { childList: true });
}

function stopTitleObserver() {
  if (titleObserver) { titleObserver.disconnect(); titleObserver = null; }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'HIDDEN_STREAMERS_UPDATED') {
    refreshHiddenStreamers();
  } else if (message.type === 'SET_PRIMARY_TITLE') {
    isPrimaryActive = true;
    applyTitleState();
    startTitleObserver();
  } else if (message.type === 'CLEAR_PRIMARY_TITLE') {
    isPrimaryActive = false;
    applyTitleState();
    if (!isDnmActive) stopTitleObserver();
  } else if (message.type === 'SET_DNM_TITLE') {
    isDnmActive = true;
    applyTitleState();
    startTitleObserver();
  } else if (message.type === 'CLEAR_DNM_TITLE') {
    isDnmActive = false;
    applyTitleState();
    if (!isPrimaryActive) stopTitleObserver();
  }
});

// ── Stream offline detection ───────────────────────────────────────────────────

const OFFLINE_SELECTORS = [
  '[data-a-target="player-overlay-stream-paused"]',
  '.offline-recommendations-overlay',
  '[data-test-selector="stream-offline-notification"]',
];

function hasOfflineText() {
  return document.body?.textContent.includes('Most Recent Video') ?? false;
}

// ── Stream crash detection ────────────────────────────────────────────────────

const CRASH_SELECTORS = [
  '[data-test-selector="player-overlay-has-error"]',
  '[data-a-target="player-error-overlay"]',
  '[class*="player-error"]',
];

// Selectors for Twitch's own "Try again" / reload button inside error overlays
const CRASH_RETRY_SELECTORS = [
  '[data-a-target="player-error-reload-button"]',
  '[data-test-selector="player-overlay-has-error"] button',
  '[data-a-target="player-error-overlay"] button',
];

function hasCrashText() {
  const player = document.querySelector('.video-player, [data-a-target="video-player"]');
  if (!player) return false;
  return player.textContent.includes('Error #2000');
}

// Track video.currentTime to detect a frozen (stalled) stream
const STALL_THRESHOLD = 15; // consecutive seconds with no time progress
let lastVideoTime = null;
let stallCount    = 0;

function handleCrashDetected(reason) {
  console.log(`[TwitchAdMuter] Stream crash detected (${reason})`);
  stallCount = 0; // reset so we don't fire again immediately after reload

  // Try Twitch's built-in retry button first (less disruptive than a full reload)
  for (const sel of CRASH_RETRY_SELECTORS) {
    const btn = document.querySelector(sel);
    if (btn) { btn.click(); return; }
  }

  // No native button — ask background.js to reload the tab
  chrome.runtime.sendMessage({ type: 'STREAM_CRASH_DETECTED' });
}

// ── State management ──────────────────────────────────────────────────────────

let isCurrentlyAd = false;
let isCurrentlyOffline = false;

// Frozen countdown detection — stream ended mid-ad
let lastCountdownText  = null;
let countdownFrozenFor = 0;
const COUNTDOWN_FREEZE_THRESHOLD = 5; // seconds

function handleAdState(isAd, source) {
  if (isAd === isCurrentlyAd) return;
  isCurrentlyAd = isAd;
  console.log(`[TwitchAdMuter] Ad state changed → ${isAd} (detected via: ${source})`);
  chrome.runtime.sendMessage({ type: 'AD_STATE_CHANGED', isAd });
}

function handleStreamState(isOffline) {
  if (isOffline === isCurrentlyOffline) return;
  isCurrentlyOffline = isOffline;
  console.log(`[TwitchAdMuter] Stream state changed → ${isOffline ? 'offline' : 'live'}`);
  chrome.runtime.sendMessage({ type: 'STREAM_STATE_CHANGED', isOffline });
}

// ── DOM polling ───────────────────────────────────────────────────────────────

function checkDOM() {
  const selectorHit = AD_SELECTORS.find(s => document.querySelector(s));
  const badgeHit    = !selectorHit && hasAdBadge();

  if (selectorHit) {
    handleAdState(true, `selector: ${selectorHit}`);
  } else if (badgeHit) {
    handleAdState(true, 'text-badge');
  } else if (!networkAdActive) {
    // Only clear via DOM if the network signal also shows no ad,
    // preventing DOM from cancelling a network-detected ad due to selector drift.
    handleAdState(false, 'dom-clear');
  }

  // video.ended is the most reliable offline signal: when a live HLS stream terminates
  // the browser sets this natively, independent of Twitch's DOM structure.
  const video            = document.querySelector('video');
  const videoEnded       = !isCurrentlyAd && !!(video?.ended);
  // Suppress DOM-based offline detection during ads — Twitch can show offline
  // overlays mid-ad that would otherwise trigger the tab close timer.
  const offlineSelectorHit = !isCurrentlyAd && !videoEnded && OFFLINE_SELECTORS.find(s => document.querySelector(s));
  const offlineTextHit     = !isCurrentlyAd && !videoEnded && !offlineSelectorHit && hasOfflineText();
  handleStreamState(!!(videoEnded || offlineSelectorHit || offlineTextHit));

  // Crash detection — skip during ads or intentional stream-end
  if (!isCurrentlyAd && !isCurrentlyOffline) {
    const crashSelectorHit = CRASH_SELECTORS.find(s => document.querySelector(s));
    const crashTextHit     = !crashSelectorHit && hasCrashText();
    if (crashSelectorHit || crashTextHit) {
      handleCrashDetected(crashSelectorHit || 'error-text');
    } else {
      // Stall detection: track whether currentTime is advancing
      if (video && !video.paused && !video.ended && video.readyState >= 2) {
        if (lastVideoTime !== null && video.currentTime === lastVideoTime) {
          stallCount++;
          if (stallCount >= STALL_THRESHOLD) handleCrashDetected('stall');
        } else {
          stallCount = 0;
        }
        lastVideoTime = video.currentTime;
      } else {
        stallCount = 0;
        lastVideoTime = null;
      }
    }
  } else {
    // Reset stall tracking while ads play or stream is offline
    stallCount    = 0;
    lastVideoTime = null;

    // While an ad is playing, watch for a frozen countdown — stream ended mid-ad
    if (isCurrentlyAd) {
      const countdown = document.querySelector('[data-a-target="video-ad-countdown"]');
      const text = countdown?.textContent.trim() ?? null;
      if (text && text === lastCountdownText) {
        countdownFrozenFor++;
        if (countdownFrozenFor >= COUNTDOWN_FREEZE_THRESHOLD) handleStreamState(true);
      } else {
        countdownFrozenFor = 0;
      }
      lastCountdownText = text;
    } else {
      countdownFrozenFor = 0;
      lastCountdownText  = null;
    }
  }

  // Feature: hide blocked streamers across all Twitch pages
  applyHiding();

}


setInterval(checkDOM, 1000);

let debounceTimer = null;
const observer = new MutationObserver(() => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(checkDOM, 150);
});

function startObserving() {
  observer.observe(document.querySelector('.video-player') || document.body, {
    childList: true, subtree: true, attributes: true,
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startObserving);
} else {
  startObserving();
}
