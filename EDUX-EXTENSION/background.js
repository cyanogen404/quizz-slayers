// EDUX Slayers Background Service Worker (Manifest V3)

chrome.runtime.onInstalled.addListener(() => {
  console.log('⚔️ EDUX Slayers Extension installed successfully.');

  // Set default configuration
  chrome.storage.local.get(['delayMs', 'autoNext', 'slideStats'], (existing) => {
    const defaults = {};
    if (existing.delayMs === undefined) defaults.delayMs = 100;
    if (existing.autoNext === undefined) defaults.autoNext = true;
    if (!existing.slideStats) defaults.slideStats = { solved: 0, retries: 0 };

    if (Object.keys(defaults).length > 0) {
      chrome.storage.local.set(defaults);
    }
  });
});

