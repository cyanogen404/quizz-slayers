// EDUX Slayers Background Service Worker (Manifest V3)

chrome.runtime.onInstalled.addListener(() => {
  console.log('⚔️ EDUX Slayers Extension installed successfully.');

  // Set default settings
  chrome.storage.local.set({
    delayMs: 400,
    autoNext: true,
    ollamaUrl: 'http://localhost:11434',
    ollamaModel: 'hf.co/arcee-ai/Arcee-VyLinh-GGUF:Q8_0',
    slideStats: { solved: 0, retries: 0 }
  });
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'FETCH_OLLAMA') {
    const url = request.url || 'http://localhost:11434';
    const payload = {
      model: request.model || 'hf.co/arcee-ai/Arcee-VyLinh-GGUF:Q8_0',
      prompt: request.prompt,
      stream: false,
      options: {
        temperature: 0
      }
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 90000); // 90s timeout

    fetch(`${url}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    })
      .then((res) => {
        clearTimeout(timeoutId);
        if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${res.statusText}`);
        return res.json();
      })
      .then((data) => sendResponse({ success: true, data }))
      .catch((err) => {
        clearTimeout(timeoutId);
        sendResponse({ success: false, error: err.message });
      });

    return true; // async response
  }
});
