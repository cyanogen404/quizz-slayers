// EDUX Slayers Background Service Worker (Manifest V3)

chrome.runtime.onInstalled.addListener(() => {
  console.log('⚔️ EDUX Slayers Extension installed successfully.');
  
  // Set default settings
  chrome.storage.local.set({
    delayMs: 400,
    autoNext: true,
    ollamaUrl: 'http://localhost:11434',
    slideStats: { solved: 0, retries: 0 }
  });
});

// Relay messages if needed
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'FETCH_OLLAMA') {
    fetch(`${request.url}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request.payload)
    })
      .then((res) => res.json())
      .then((data) => sendResponse({ success: true, data }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true; // async response
  }
});
