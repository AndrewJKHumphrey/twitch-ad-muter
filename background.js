// ── Storage helpers ───────────────────────────────────────────────────────────

async function getSet(key) {
  const data = await chrome.storage.local.get(key);
  return new Set(data[key] || []);
}

async function saveSet(key, set) {
  await chrome.storage.local.set({ [key]: [...set] });
}

async function getSetting(key, defaultValue) {
  const data = await chrome.storage.local.get({ [key]: defaultValue });
  return data[key];
}

// ── State model ───────────────────────────────────────────────────────────────
//
// adTabs          – tabs currently playing an ad (always muted)
// mutedByUs       – tabs we muted for any reason (so we only unmute what we muted)
// pendingUnmute   – ad ended on an inactive tab while muteInactive is OFF;
//                   unmute deferred until the tab is focused
//
// primaryTabs – { [windowId]: tabId } — one primary tab per browser window.
// Set exclusively via the right-click context menu. Persisted to storage so it
// survives service worker restarts.

let primaryTabs = {};
chrome.storage.local.get('primaryTabs', ({ primaryTabs: stored }) => {
  if (stored) primaryTabs = stored;
});

async function getPrimaryTabs() {
  const data = await chrome.storage.local.get('primaryTabs');
  return data.primaryTabs || {};
}

async function savePrimaryTabs(map) {
  primaryTabs = map;
  await chrome.storage.local.set({ primaryTabs: map });
}

function isTwitchUrl(url) {
  return url?.includes('twitch.tv') ?? false;
}

const NON_STREAM_PATHS = [
  '/',
  '/directory', '/following', '/subscriptions', '/settings',
  '/messages', '/drops', '/wallet', '/inventory', '/friends',
  '/moderator', '/store', '/turbo', '/bits', '/squad', '/search',
];

function isTwitchStreamUrl(url) {
  if (!isTwitchUrl(url)) return false;
  try {
    const path = new URL(url).pathname;
    return !NON_STREAM_PATHS.some(p => path === p || path.startsWith(p + '/'));
  } catch { return false; }
}

// Mute a tab and record that we did it
// Skips silently if the tab has "Do not mute" enabled
async function muteTab(tabId, mutedByUs, doNotMuteTabs) {
  if (doNotMuteTabs?.has(tabId)) return;
  mutedByUs.add(tabId);
  await chrome.tabs.update(tabId, { muted: true });
}

// Unmute a tab and remove our record of it
async function unmuteTab(tabId, mutedByUs, pendingUnmute) {
  mutedByUs.delete(tabId);
  pendingUnmute?.delete(tabId);
  await chrome.tabs.update(tabId, { muted: false });
}

// ── Messages from content.js ──────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender) => {
  const tabId = sender.tab?.id;
  if (message.type === 'AD_STATE_CHANGED')      handleAdStateChange(tabId, message.isAd);
  if (message.type === 'STREAM_STATE_CHANGED')  handleStreamStateChange(tabId, message.isOffline);
  if (message.type === 'STREAM_CRASH_DETECTED') handleStreamCrash(tabId);
});

async function handleAdStateChange(tabId, isAd) {
  if (!tabId) return;

  const [adTabs, mutedByUs, pendingUnmute] = await Promise.all([
    getSet('adTabs'), getSet('mutedByUs'), getSet('pendingUnmute'),
  ]);

  // Collect any tab-switch actions to perform after storage is saved.
  // Saving first prevents onActivated from reading stale mutedByUs state.
  let switchToId   = null; // tab to switch TO when ad starts
  let returnToId   = null; // tab to return to when ad ends

  if (isAd) {
    adTabs.add(tabId);
    pendingUnmute.delete(tabId);

    const tab = await chrome.tabs.get(tabId);
    if (!tab.mutedInfo?.muted) await muteTab(tabId, mutedByUs); // ads always mute regardless of Do Not Mute

    const { totalMutes = 0 } = await chrome.storage.local.get('totalMutes');
    await chrome.storage.local.set({ totalMutes: totalMutes + 1 });

    if (tab.active) {
      const switchOnAd = await getSetting('switchOnAd', false);
      if (switchOnAd) {
        const twitchTabs = (await chrome.tabs.query({ windowId: tab.windowId, url: '*://*.twitch.tv/*' }))
          .filter(t => isTwitchStreamUrl(t.url));
        if (twitchTabs.length >= 2) {
          const target = twitchTabs.find(t => t.id !== tabId && !adTabs.has(t.id));
          if (target) {
            switchToId = target.id;
          }
        }
      }
    }
  } else {
    adTabs.delete(tabId);

    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab) {
      if (mutedByUs.has(tabId)) {
        const muteInactive = await getSetting('muteInactive', false);
        if (tab.active) {
          // Active tab: unmute immediately
          await unmuteTab(tabId, mutedByUs, pendingUnmute);
        } else if (muteInactive) {
          // Inactive tab + setting on: keep muted
        } else {
          // Inactive tab + setting off: defer unmute until focused
          pendingUnmute.add(tabId);
        }
      }

      if (primaryTabs[tab.windowId] === tabId) {
        const returnOnAdEnd = await getSetting('returnOnAdEnd', false);
        if (returnOnAdEnd && !tab.active) returnToId = tabId;
      }
    }
  }

  // Pre-apply the unmute for the switch target in our tracking sets so the
  // save below reflects the correct state before onActivated reads it.
  if (switchToId && mutedByUs.has(switchToId) && !adTabs.has(switchToId)) {
    mutedByUs.delete(switchToId);
    pendingUnmute.delete(switchToId);
  }

  // Save BEFORE any chrome.tabs.update calls so onActivated always reads current state
  await Promise.all([
    saveSet('adTabs', adTabs),
    saveSet('mutedByUs', mutedByUs),
    saveSet('pendingUnmute', pendingUnmute),
    chrome.storage.local.set({ [`adState_${tabId}`]: isAd }),
  ]);

  // Switch away from the ad tab — unmute target at the browser level then activate it
  if (switchToId) {
    await chrome.tabs.update(switchToId, { muted: false });

    await chrome.tabs.update(switchToId, { active: true });
  }

  // Return to primary tab after ad ends — onActivated will handle unmuting it
  if (returnToId) {
    await chrome.tabs.update(returnToId, { active: true }).catch(() => {});
  }
}

// ── Stream crash / auto-reload ────────────────────────────────────────────────

// reloadAttempts: tabId → { count, resetTimer }
const reloadAttempts = new Map();
const MAX_RELOADS        = 3;
const RELOAD_RESET_MS    = 10 * 60 * 1000; // 10 minutes

async function handleStreamCrash(tabId) {
  if (!tabId) return;

  const autoReload = await getSetting('autoReloadOnCrash', true);
  if (!autoReload) return;

  const entry = reloadAttempts.get(tabId) ?? { count: 0, resetTimer: null };

  if (entry.count >= MAX_RELOADS) {
    console.log(`[TwitchAdMuter] Crash reload limit reached for tab ${tabId}`);
    return;
  }

  // Schedule reset of the counter after the window
  if (entry.resetTimer) clearTimeout(entry.resetTimer);
  entry.resetTimer = setTimeout(() => reloadAttempts.delete(tabId), RELOAD_RESET_MS);
  entry.count++;
  reloadAttempts.set(tabId, entry);

  console.log(`[TwitchAdMuter] Reloading crashed tab ${tabId} (attempt ${entry.count}/${MAX_RELOADS})`);
  try { await chrome.tabs.reload(tabId); } catch (_) { /* tab may be gone */ }
}

// ── Stream state changes (messages from content.js) ───────────────────────────

const closeTimers = new Map(); // tabId → timer id

async function handleStreamStateChange(tabId, isOffline) {
  if (!tabId) return;

  if (!isOffline) {
    // Stream came back live (e.g. brief dropout) — cancel any pending close
    if (closeTimers.has(tabId)) {
      clearTimeout(closeTimers.get(tabId));
      closeTimers.delete(tabId);
    }
    return;
  }

  const closeOnStreamEnd = await getSetting('closeOnStreamEnd', true);
  if (!closeOnStreamEnd) return;
  if (closeTimers.has(tabId)) return; // already queued

  // 5-second grace period to avoid closing on transient blips
  const timer = setTimeout(async () => {
    closeTimers.delete(tabId);
    try { await chrome.tabs.remove(tabId); } catch (_) { /* tab already gone */ }
  }, 5000);

  closeTimers.set(tabId, timer);
}

// ── Tab activated ─────────────────────────────────────────────────────────────

chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  const activatedTab = await chrome.tabs.get(tabId).catch(() => null);

  // Non-Twitch tabs have no effect on the extension's state
  if (!activatedTab || !isTwitchUrl(activatedTab.url)) return;

  const [adTabs, mutedByUs, pendingUnmute, doNotMuteTabs, muteInactive] = await Promise.all([
    getSet('adTabs'), getSet('mutedByUs'), getSet('pendingUnmute'), getSet('doNotMuteTabs'),
    getSetting('muteInactive', false),
  ]);

  // Unmute the tab that just became active — unless an ad is playing on it
  if (mutedByUs.has(tabId) && !adTabs.has(tabId)) {
    await unmuteTab(tabId, mutedByUs, pendingUnmute);
  } else {
    pendingUnmute.delete(tabId); // clear pending even if we didn't mute it
  }

  // If muteInactive is on, mute all other inactive Twitch tabs in this window
  if (muteInactive) {
    const allTwitchTabs = await chrome.tabs.query({ windowId });
    for (const tab of allTwitchTabs) {
      if (tab.id === tabId) continue;
      if (!isTwitchUrl(tab.url)) continue;
      if (!tab.mutedInfo?.muted) await muteTab(tab.id, mutedByUs, doNotMuteTabs);
    }
  }

  // Keep the Do Not Mute checkbox in sync with the newly active tab
  chrome.contextMenus.update('toggleDoNotMute', { checked: doNotMuteTabs.has(tabId) }).catch(() => {});

  await Promise.all([
    saveSet('mutedByUs', mutedByUs),
    saveSet('pendingUnmute', pendingUnmute),
  ]);
});

// ── muteInactive setting toggled (via storage.onChanged) ──────────────────────

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && 'muteInactive' in changes) {
    applyMuteInactiveSetting(changes.muteInactive.newValue);
  }
});

async function applyMuteInactiveSetting(enabled) {
  const [adTabs, mutedByUs, pendingUnmute, doNotMuteTabs] = await Promise.all([
    getSet('adTabs'), getSet('mutedByUs'), getSet('pendingUnmute'), getSet('doNotMuteTabs'),
  ]);

  const allTabs = await chrome.tabs.query({ url: '*://*.twitch.tv/*' });

  if (enabled) {
    // Mute every inactive Twitch tab that isn't already muted
    for (const tab of allTabs) {
      if (!tab.active && !tab.mutedInfo?.muted) {
        await muteTab(tab.id, mutedByUs, doNotMuteTabs);
      }
    }
  } else {
    // Unmute every tab we muted purely for inactivity (no ad playing)
    for (const tab of allTabs) {
      if (!tab.active && mutedByUs.has(tab.id) && !adTabs.has(tab.id)) {
        await unmuteTab(tab.id, mutedByUs, pendingUnmute);
      }
    }
  }

  await Promise.all([
    saveSet('mutedByUs', mutedByUs),
    saveSet('pendingUnmute', pendingUnmute),
  ]);
}

// ── New Twitch tab loaded while muteInactive is on ───────────────────────────

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!isTwitchUrl(tab.url)) return;

  // If the tab reloaded mid-ad, treat the ad as ended so the tab is unmuted.
  // content.js initialises with isCurrentlyAd=false and won't re-send AD_STATE_CHANGED
  // unless a new ad actually starts, so we must reset state here on reload.
  const adTabs = await getSet('adTabs');
  if (adTabs.has(tabId)) {
    await handleAdStateChange(tabId, false);
    return;
  }

  // Re-apply title indicators if this tab is the current primary or has DNM set —
  // content.js reinitialises on refresh and loses any title modifications.
  const [storedPrimaryTabs, doNotMuteTabsOnLoad] = await Promise.all([
    getPrimaryTabs(),
    getSet('doNotMuteTabs'),
  ]);
  if (storedPrimaryTabs[tab.windowId] === tabId) {
    chrome.tabs.sendMessage(tabId, { type: 'SET_PRIMARY_TITLE' }).catch(() => {});
  }
  if (doNotMuteTabsOnLoad.has(tabId)) {
    chrome.tabs.sendMessage(tabId, { type: 'SET_DNM_TITLE' }).catch(() => {});
  }

  // Sync the DNM checkbox to reflect this tab's state if it is currently active
  if (tab.active) {
    chrome.contextMenus.update('toggleDoNotMute', { checked: doNotMuteTabsOnLoad.has(tabId) }).catch(() => {});
    return;
  }
  const muteInactive = await getSetting('muteInactive', false);
  if (!muteInactive || tab.mutedInfo?.muted) return;

  const [mutedByUs, doNotMuteTabs] = await Promise.all([getSet('mutedByUs'), getSet('doNotMuteTabs')]);
  await muteTab(tabId, mutedByUs, doNotMuteTabs);
  await saveSet('mutedByUs', mutedByUs);
});

// ── Context menus ─────────────────────────────────────────────────────────────

function registerContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'twitchAdMuter',
      title: 'Twitch Ad Muter',
      contexts: ['page'],
      documentUrlPatterns: ['*://*.twitch.tv/*'],
    });
    chrome.contextMenus.create({
      id: 'setPrimaryTab',
      parentId: 'twitchAdMuter',
      title: 'Set as Primary Tab',
      contexts: ['page'],
      documentUrlPatterns: ['*://*.twitch.tv/*'],
    });
    chrome.contextMenus.create({
      id: 'toggleDoNotMute',
      parentId: 'twitchAdMuter',
      title: 'Do Not Mute This Tab (Ads are still muted)',
      type: 'checkbox',
      checked: false,
      contexts: ['page'],
      documentUrlPatterns: ['*://*.twitch.tv/*'],
    });
  });
}

chrome.runtime.onInstalled.addListener(registerContextMenus);
registerContextMenus();

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab) return;

  if (info.menuItemId === 'setPrimaryTab') {
    if (!isTwitchStreamUrl(tab.url)) return;

    const map = await getPrimaryTabs();

    // Clear the Primary title from the previous primary in this window (if any)
    const prevId = map[tab.windowId];
    if (prevId && prevId !== tab.id) {
      chrome.tabs.sendMessage(prevId, { type: 'CLEAR_PRIMARY_TITLE' }).catch(() => {});
    }

    map[tab.windowId] = tab.id;
    await savePrimaryTabs(map);
    chrome.tabs.sendMessage(tab.id, { type: 'SET_PRIMARY_TITLE' }).catch(() => {});
  }

  if (info.menuItemId === 'toggleDoNotMute') {
    const doNotMuteTabs = await getSet('doNotMuteTabs');
    const enabling = info.checked;

    if (enabling) {
      doNotMuteTabs.add(tab.id);
      // If the tab is currently muted by us (not by an ad), unmute it immediately
      const [adTabs, mutedByUs, pendingUnmute] = await Promise.all([
        getSet('adTabs'), getSet('mutedByUs'), getSet('pendingUnmute'),
      ]);
      if (mutedByUs.has(tab.id) && !adTabs.has(tab.id)) {
        await unmuteTab(tab.id, mutedByUs, pendingUnmute);
        await Promise.all([saveSet('mutedByUs', mutedByUs), saveSet('pendingUnmute', pendingUnmute)]);
      }
      chrome.tabs.sendMessage(tab.id, { type: 'SET_DNM_TITLE' }).catch(() => {});
    } else {
      doNotMuteTabs.delete(tab.id);
      chrome.tabs.sendMessage(tab.id, { type: 'CLEAR_DNM_TITLE' }).catch(() => {});
    }

    await saveSet('doNotMuteTabs', doNotMuteTabs);
  }
});

// ── Cleanup on tab close ──────────────────────────────────────────────────────

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const map = await getPrimaryTabs();
  const windowId = Object.keys(map).find(w => map[w] === tabId);
  if (windowId) {
    delete map[windowId];
    await savePrimaryTabs(map);
  }

  if (closeTimers.has(tabId)) {
    clearTimeout(closeTimers.get(tabId));
    closeTimers.delete(tabId);
  }
  if (reloadAttempts.has(tabId)) {
    clearTimeout(reloadAttempts.get(tabId).resetTimer);
    reloadAttempts.delete(tabId);
  }
  for (const key of ['adTabs', 'mutedByUs', 'pendingUnmute', 'doNotMuteTabs']) {
    const set = await getSet(key);
    if (set.has(tabId)) { set.delete(tabId); await saveSet(key, set); }
  }
  chrome.storage.local.remove([`adState_${tabId}`]);
});
