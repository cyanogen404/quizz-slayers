/**
 * EDUX Slayers Content Script v2.1.0
 * Modular coordinator: connects Network Interceptor, Slide Solver,
 * Test Solver, and Score Tracker.
 */

(function () {
  if (window.__EDUX_SLAYERS_INJECTED__) return;
  window.__EDUX_SLAYERS_INJECTED__ = true;

  console.log('⚔️ EDUX Slayers Extension v2.1.0 loaded.');

  // =========================================================================
  // 1. Network Interceptor Setup
  // =========================================================================
  let lastCapturedExamData = null;

  function injectNetworkInterceptor() {
    try {
      const script = document.createElement('script');
      script.src = chrome.runtime.getURL('injected.js');
      script.onload = () => script.remove();
      (document.head || document.documentElement).appendChild(script);
    } catch (e) {
      console.warn('[EDUX Slayers] Could not inject API interceptor:', e);
    }
  }
  injectNetworkInterceptor();

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data) return;
    if (event.data.type === 'EDUX_EXAM_DATA_CAPTURED') {
      lastCapturedExamData = event.data.payload;
      console.log('[EDUX Slayers] 📡 Đã tự động bắt được dữ liệu đề thi từ máy chủ EDUX!');
    } else if (event.data.type === 'EDUX_MODELS_DATA_CAPTURED') {
      const payload = event.data.payload;
      if (payload && Array.isArray(payload.data)) {
        window.EduxScoreTracker?.setCachedModels(payload.data);
      }
    } else if (event.data.type === 'EDUX_EXAM_HISTORY_CAPTURED') {
      window.EduxScoreTracker?.refresh();
    }
  });

  // =========================================================================
  // 2. Extension Message Handlers
  // =========================================================================
  chrome.storage.local.get(['delayMs', 'autoNext'], (res) => {
    if (res && window.EduxSlideSolver) {
      window.EduxSlideSolver.setConfig({
        delayMs: res.delayMs !== undefined ? res.delayMs : 100,
        autoNext: res.autoNext !== undefined ? res.autoNext : true
      });
    }
  });

  chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
    if (req.action === 'START_SLIDE_BRUTEFORCE') {
      window.EduxSlideSolver?.start(req.config);
      sendResponse({ success: true });
    } else if (req.action === 'STOP_SLIDE_BRUTEFORCE') {
      window.EduxSlideSolver?.stop();
      sendResponse({ success: true });
    } else if (req.action === 'FILL_TEST_ANSWERS') {
      if (window.EduxTestSolver) {
        window.EduxTestSolver.fillTestAnswers(req.answersText)
          .then((res) => sendResponse(res))
          .catch((err) => sendResponse({ success: false, message: String(err) }));
        return true;
      } else {
        sendResponse({ success: false, message: 'Động cơ Test Solver chưa sẵn sàng.' });
      }
    } else if (req.action === 'EXTRACT_QUESTIONS') {
      if (window.EduxTestSolver) {
        const res = window.EduxTestSolver.extractQuestions(lastCapturedExamData);
        sendResponse(res);
      } else {
        sendResponse({ success: false, message: 'Động cơ Test Solver chưa sẵn sàng.' });
      }
    } else if (req.action === 'GET_STATUS') {
      const status = window.EduxSlideSolver?.getStatus() || { isSlideRunning: false, solvedCount: 0, retryCount: 0 };
      sendResponse(status);
    } else if (req.action === 'UPDATE_SETTINGS') {
      window.EduxSlideSolver?.setConfig(req.settings);
      sendResponse({ success: true });
    } else if (req.action === 'GET_EXERCISE_SCORES') {
      if (window.EduxScoreTracker) {
        window.EduxScoreTracker.getScores()
          .then((res) => sendResponse(res))
          .catch((err) => sendResponse({ success: false, error: String(err) }));
        return true;
      } else {
        sendResponse({ success: false, message: 'Động cơ Score Tracker chưa sẵn sàng.' });
      }
    }
    return true;
  });
})();
