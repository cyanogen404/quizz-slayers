/**
 * EDUX Slayers - Injected Network Interceptor
 * Injected into the page's MAIN execution context to intercept API responses
 * (e.g. /start or exam endpoints) matching Playwright's page.expect_response().
 */
(function () {
  if (window.__EDUX_SLAYERS_INTERCEPTOR_ACTIVE__) return;
  window.__EDUX_SLAYERS_INTERCEPTOR_ACTIVE__ = true;

  function broadcastExamPayload(data, sourceUrl) {
    try {
      window.postMessage(
        {
          type: 'EDUX_EXAM_DATA_CAPTURED',
          url: sourceUrl,
          payload: data,
          timestamp: Date.now()
        },
        '*'
      );
      console.log('[EDUX Slayers Interceptor] Captured exam payload from:', sourceUrl);
    } catch (e) {
      // Ignore serialization issues
    }
  }

  function isExamPayload(data, url) {
    if (!data || typeof data !== 'object') return false;
    const urlLower = (url || '').toLowerCase();
    
    // Check if URL suggests exam/start/round
    const isExamUrl = urlLower.includes('start') || urlLower.includes('exam') || urlLower.includes('interactive') || urlLower.includes('active-round');

    // Check payload structure
    const hasExamData = data.data && (
      data.data.exam_data ||
      data.data.question_text ||
      data.data.questions ||
      data.data.choices ||
      (Array.isArray(data.data) && data.data.length > 0 && data.data[0].question)
    );

    return isExamUrl || hasExamData;
  }

  // Intercept window.fetch
  const originalFetch = window.fetch;
  if (originalFetch) {
    window.fetch = async function (...args) {
      const response = await originalFetch.apply(this, args);
      try {
        const clone = response.clone();
        const url = (typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '');
        clone.json().then((json) => {
          if (isExamPayload(json, url)) {
            broadcastExamPayload(json, url);
          }
        }).catch(() => {});
      } catch (e) {
        // Silent catch
      }
      return response;
    };
  }

  // Intercept XMLHttpRequest
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._edux_url = url;
    return originalOpen.apply(this, [method, url, ...rest]);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', function () {
      try {
        const url = this._edux_url || '';
        const responseText = this.responseText;
        if (responseText && (url.includes('start') || url.includes('exam') || url.includes('interactive'))) {
          const json = JSON.parse(responseText);
          if (isExamPayload(json, url)) {
            broadcastExamPayload(json, url);
          }
        }
      } catch (e) {
        // Not JSON or parsing failed
      }
    });
    return originalSend.apply(this, args);
  };

  console.log('[EDUX Slayers] Injected API interceptor ready.');
})();
