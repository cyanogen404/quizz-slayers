/**
 * EDUX Slayers - Injected Network Interceptor
 * Injected into the page's MAIN execution context to intercept API responses
 * (e.g. /start or exam endpoints) matching Playwright's page.expect_response().
 */
(function () {
  if (window.__EDUX_SLAYERS_INTERCEPTOR_ACTIVE__) return;
  window.__EDUX_SLAYERS_INTERCEPTOR_ACTIVE__ = true;

  function broadcastEvent(type, data, sourceUrl) {
    try {
      window.postMessage(
        {
          type,
          url: sourceUrl,
          payload: data,
          timestamp: Date.now()
        },
        '*'
      );
      console.log(`[EDUX Slayers Interceptor] ${type} from:`, sourceUrl);
    } catch (e) {
      // Ignore serialization issues
    }
  }

  function broadcastExamPayload(data, sourceUrl) {
    broadcastEvent('EDUX_EXAM_DATA_CAPTURED', data, sourceUrl);
  }

  function checkAndBroadcast(data, url) {
    if (!data || typeof data !== 'object') return;
    const urlLower = (url || '').toLowerCase();

    // Check subject models API (/api/subjects/{id}/models)
    if (urlLower.includes('/api/subjects/') && urlLower.includes('/models')) {
      broadcastEvent('EDUX_MODELS_DATA_CAPTURED', data, url);
      return;
    }

    // Check exam history API (/api/exam/history)
    if (urlLower.includes('/api/exam/history')) {
      broadcastEvent('EDUX_EXAM_HISTORY_CAPTURED', data, url);
      return;
    }

    // Check exam payload for questions
    if (isExamPayload(data, url)) {
      broadcastExamPayload(data, url);
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
          checkAndBroadcast(json, url);
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
        if (responseText && (url.includes('start') || url.includes('exam') || url.includes('interactive') || url.includes('models'))) {
          const json = JSON.parse(responseText);
          checkAndBroadcast(json, url);
        }
      } catch (e) {
        // Not JSON or parsing failed
      }
    });
    return originalSend.apply(this, args);
  };

  console.log('[EDUX Slayers] Injected API interceptor ready.');
})();
