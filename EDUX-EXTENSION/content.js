/**
 * EDUX Slayers Content Script v2.0.0
 * Fully upgraded automation for EDUX matching Playwright tools
 * (quizz_bruteforce.py & test_solver.py) in precision, state handling,
 * and smoothness.
 */

(function () {
  if (window.__EDUX_SLAYERS_INJECTED__) return;
  window.__EDUX_SLAYERS_INJECTED__ = true;

  console.log('⚔️ EDUX Slayers Extension v2.0.0 loaded.');

  // =========================================================================
  // 1. Injected Network Interceptor for Exam API
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
      logMessage('📡 Đã tự động bắt được dữ liệu đề thi từ máy chủ EDUX!', 'success', true);
    }
  });

  // =========================================================================
  // 2. Global State & Configuration
  // =========================================================================
  let isSlideRunning = false;
  let slideLoopTimer = null;
  let solvedCount = 0;
  let retryCount = 0;
  let wrongAnswersMap = {};       // { questionKey: Set of tried indexes }
  let knownCorrectAnswers = {};   // { questionKey: correctIndex } - learned from "Đáp án đúng: X"
  let lastProgress = Date.now();
  let stallReported = false;
  const STALL_MS = 8000;

  let config = {
    delayMs: 400,
    autoNext: true
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function notifyPopup(type, payload) {
    try {
      chrome.runtime.sendMessage({ type, ...payload });
    } catch (e) {
      // Popup might be closed
    }
  }

  function logMessage(msg, logType = 'info', isTest = false) {
    console.log(`[EDUX Slayers] ${msg}`);
    notifyPopup(isTest ? 'TEST_LOG' : 'SLIDE_LOG', {
      message: msg,
      logType,
      solvedCount,
      retryCount
    });
    updateWidgetUI(msg, logType);
  }

  // =========================================================================
  // 3. Playwright-Equivalent DOM Utilities
  // =========================================================================

  /**
   * Safe visibility check matching Playwright's is_visible().
   */
  function safeIsVisible(el) {
    if (!el) return false;
    try {
      const style = window.getComputedStyle(el);
      if (style.display === 'none') return false;
      if (style.visibility === 'hidden') return false;
      if (parseFloat(style.opacity) === 0) return false;

      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return false;

      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Safe enabled check matching Playwright's safe_is_enabled().
   * Handles disabled attribute, aria-disabled="true", data-disabled="true",
   * and Tailwind disabled classes without false positives on prefixes like disabled:cursor-not-allowed.
   */
  function safeIsEnabled(el) {
    if (!el || !safeIsVisible(el)) return false;
    try {
      if (el.disabled) return false;
      if (el.getAttribute('aria-disabled') === 'true') return false;
      if (el.getAttribute('data-disabled') === 'true') return false;

      // Check real computed style in browser
      const style = window.getComputedStyle(el);
      if (style.pointerEvents === 'none') return false;

      // Check standalone classes only (classList.contains does not match disabled:cursor-not-allowed)
      const classList = el.classList;
      if (classList && classList.contains('cursor-not-allowed') && classList.contains('pointer-events-none')) {
        return false;
      }

      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Safe click with full Pointer/Mouse event dispatching for React/Vue synthetic events.
   * Calculates actual element coordinates and sets valid button/buttons states.
   */
  function safeClick(el) {
    if (!el) return false;
    try {
      if (typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
      }

      const rect = el.getBoundingClientRect();
      const clientX = rect.left + rect.width / 2;
      const clientY = rect.top + rect.height / 2;

      const baseOpts = {
        bubbles: true,
        cancelable: true,
        view: window,
        composed: true,
        clientX,
        clientY,
        screenX: (window.screenX || 0) + clientX,
        screenY: (window.screenY || 0) + clientY
      };

      el.dispatchEvent(new PointerEvent('pointerover', baseOpts));
      el.dispatchEvent(new MouseEvent('mouseover', baseOpts));
      el.dispatchEvent(new PointerEvent('pointerdown', { ...baseOpts, button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
      el.dispatchEvent(new MouseEvent('mousedown', { ...baseOpts, button: 0, buttons: 1 }));
      if (typeof el.focus === 'function') el.focus();
      el.dispatchEvent(new PointerEvent('pointerup', { ...baseOpts, button: 0, buttons: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
      el.dispatchEvent(new MouseEvent('mouseup', { ...baseOpts, button: 0, buttons: 0 }));

      if (typeof el.click === 'function') {
        el.click();
      } else {
        el.dispatchEvent(new MouseEvent('click', { ...baseOpts, button: 0, buttons: 0 }));
      }
      return true;
    } catch (e) {
      console.error('[EDUX Slayers] Click error:', e);
      try {
        if (typeof el.click === 'function') {
          el.click();
          return true;
        }
      } catch (err) {}
      return false;
    }
  }

  /**
   * Locate the active dialog modal if present.
   * Matches Playwright: get_active_dialog()
   * Only matches genuine modal overlays (dialog role, aria-modal, fixed/absolute overlay).
   */
  function getActiveDialog() {
    const selectors = [
      "div[role='dialog'][data-state='open']",
      "div[role='dialog']",
      "[aria-modal='true']",
      "div[data-slot='dialog-content']"
    ];
    for (const sel of selectors) {
      try {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          if (!safeIsVisible(el)) continue;
          const style = window.getComputedStyle(el);
          if (
            el.getAttribute('role') === 'dialog' ||
            el.getAttribute('aria-modal') === 'true' ||
            style.position === 'fixed' ||
            style.position === 'absolute' ||
            parseInt(style.zIndex, 10) > 10
          ) {
            return el;
          }
        }
      } catch (e) {}
    }
    return null;
  }

  /**
   * Find "Trang sau" / completion button inside popup quiz or in-page quiz.
   * Strictly matches completion buttons and ignores slide numbers, sidebars, and lecture navigation.
   * Matches Playwright: get_dialog_next_page_button()
   */
  function getDialogNextPageButton() {
    const dialog = getActiveDialog();
    const searchRoots = dialog ? [dialog, document] : [document];

    for (const root of searchRoots) {
      const candidates = Array.from(
        root.querySelectorAll(
          "button, a[role='button'], div[role='button'], [role='button'], div.cursor-pointer, span.cursor-pointer"
        )
      );

      // Pass 1: Buttons with green styling AND completion text
      for (const btn of candidates) {
        if (!safeIsVisible(btn) || !safeIsEnabled(btn)) continue;
        if (btn.closest('nav, aside, .sidebar, [class*="sidebar"], ul, ol')) continue;

        const txt = (btn.textContent || '').trim();
        const title = (btn.getAttribute('title') || '').trim();
        const aria = (btn.getAttribute('aria-label') || '').trim();

        // Never match slide numbers (e.g. "1", "2", "1 / 58")
        if (/^\d+(\s*\/\s*\d+)?$/.test(txt)) continue;

        // Never match navigation buttons
        if (txt.includes('Bài giảng') || title.includes('Bài giảng') || txt.includes('Khóa học')) continue;
        if (txt.includes('Thử lại') || txt.includes('Bỏ qua') || txt.includes('Phản hồi') || txt.includes('Đổi câu hỏi')) continue;

        const isGreen =
          btn.classList.contains('bg-green-600') ||
          btn.className.includes('bg-green') ||
          btn.className.includes('bg-emerald');

        const isTextMatch =
          txt === 'Trang sau' ||
          (txt.includes('Trang sau') && txt.length <= 25) ||
          title === 'Trang sau' ||
          aria === 'Trang sau' ||
          txt === 'Tiếp tục' ||
          txt === 'Hoàn thành';

        if (isGreen && isTextMatch) {
          return btn;
        }
      }

      // Pass 2: Any button matching exact completion text
      for (const btn of candidates) {
        if (!safeIsVisible(btn) || !safeIsEnabled(btn)) continue;
        if (btn.closest('nav, aside, .sidebar, [class*="sidebar"], ul, ol')) continue;

        const txt = (btn.textContent || '').trim();
        const title = (btn.getAttribute('title') || '').trim();
        const aria = (btn.getAttribute('aria-label') || '').trim();

        if (/^\d+(\s*\/\s*\d+)?$/.test(txt)) continue;
        if (txt.includes('Bài giảng') || title.includes('Bài giảng') || txt.includes('Khóa học')) continue;
        if (txt.includes('Thử lại') || txt.includes('Bỏ qua') || txt.includes('Phản hồi') || txt.includes('Đổi câu hỏi')) continue;

        const isTextMatch =
          txt === 'Trang sau' ||
          (txt.includes('Trang sau') && txt.length <= 25) ||
          title === 'Trang sau' ||
          aria === 'Trang sau' ||
          txt === 'Tiếp tục' ||
          txt === 'Hoàn thành';

        if (isTextMatch) {
          return btn;
        }
      }
    }

    return null;
  }

  /**
   * Find "Bỏ qua" button (skip countdown timer).
   * Matches Playwright: get_dialog_skip_button()
   */
  function getDialogSkipButton() {
    const selectors = ['button', 'a[role="button"]', 'div[role="button"]', '[role="button"]'];
    for (const sel of selectors) {
      try {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          if (!safeIsVisible(el)) continue;
          const txt = (el.textContent || '').trim();
          const title = el.getAttribute('title') || '';
          const aria = el.getAttribute('aria-label') || '';
          if ((txt.includes('Bỏ qua') || title.includes('Bỏ qua') || aria.includes('Bỏ qua')) && safeIsEnabled(el)) {
            return el;
          }
        }
      } catch (e) {}
    }
    return null;
  }

  /**
   * Find "Câu tiếp theo" button.
   * Matches Playwright: get_dialog_next_question_button()
   */
  function getDialogNextQuestionButton() {
    const selectors = ['button', 'a[role="button"]', 'div[role="button"]', '[role="button"]'];
    for (const sel of selectors) {
      try {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          if (!safeIsVisible(el)) continue;
          const txt = (el.textContent || '').trim();
          const title = el.getAttribute('title') || '';
          const aria = el.getAttribute('aria-label') || '';
          if (
            (txt.includes('Câu tiếp') || title.includes('Câu tiếp') || aria.includes('Câu tiếp')) &&
            safeIsEnabled(el)
          ) {
            return el;
          }
        }
      } catch (e) {}
    }
    return null;
  }

  /**
   * Find "Thử lại" button anywhere on the page or in dialog.
   * Matches Playwright: get_dialog_retry_button()
   */
  function getDialogRetryButton() {
    const selectors = [
      'button',
      'a[role="button"]',
      'div[role="button"]',
      '[role="button"]',
      'div.cursor-pointer',
      'span.cursor-pointer'
    ];
    for (const sel of selectors) {
      try {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          if (!safeIsVisible(el)) continue;
          const txt = (el.textContent || '').trim();
          const title = el.getAttribute('title') || '';
          const aria = el.getAttribute('aria-label') || '';
          if (
            (txt === 'Thử lại' || (txt.includes('Thử lại') && txt.length <= 30) ||
             title.includes('Thử lại') || aria.includes('Thử lại')) &&
            safeIsEnabled(el)
          ) {
            return el;
          }
        }
      } catch (e) {}
    }
    return null;
  }

  /**
   * Find action button by multiple target text names.
   * Prioritizes active dialog container first, checks safeIsEnabled or safeIsVisible.
   * Excludes navigation buttons like "Bài giảng".
   * Matches Playwright: find_action_button()
   */
  function findActionButton(names, mustBeEnabled = true) {
    const checkFn = mustBeEnabled ? safeIsEnabled : safeIsVisible;
    const dialog = getActiveDialog();
    const containers = dialog ? [dialog, document] : [document];

    for (const container of containers) {
      for (const name of names) {
        const buttons = Array.from(
          container.querySelectorAll('button, a[role="button"], div[role="button"], [role="button"], div.cursor-pointer')
        );
        for (const btn of buttons) {
          if (!safeIsVisible(btn)) continue;

          // Never click anything in the sidebar
          if (btn.closest('nav, aside, .sidebar, [class*="sidebar"]')) continue;

          const txt = (btn.textContent || '').trim();

          // Never click pure slide numbers
          if (/^\d+(\s*\/\s*\d+)?$/.test(txt)) continue;

          // Never click the "Bài giảng" (Lecture) or "Khóa học" navigation buttons
          if (txt.includes('Bài giảng') && !name.includes('Bài giảng')) continue;
          if (txt.includes('Khóa học') && !name.includes('Khóa học')) continue;

          const title = (btn.getAttribute('title') || '').trim();
          const aria = (btn.getAttribute('aria-label') || '').trim();

          if (
            txt === name ||
            (txt.includes(name) && txt.length <= name.length + 20) ||
            title === name ||
            title.includes(name) ||
            aria === name ||
            aria.includes(name)
          ) {
            if (checkFn(btn)) return btn;
          }
        }
      }
    }

    return null;
  }

  /**
   * Advance to the next slide via dialog button, slide bar, or ArrowRight keyboard event.
   * Matches Playwright: safe_next_slide()
   */
  function safeNextSlide() {
    const dlgBtn = getDialogNextPageButton();
    if (dlgBtn && safeClick(dlgBtn)) return true;

    const nextBtn = findActionButton(['Trang sau'], true);
    if (nextBtn && safeClick(nextBtn)) return true;

    try {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, which: 39, bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, which: 39, bubbles: true }));
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Locate slide answer elements using Playwright's multi-tiered strategy.
   * Matches Playwright: get_answers_locator()
   */
  function getSlideAnswerElements() {
    const notInSidebar = (el) => !el.closest('nav, aside, .sidebar, [class*="sidebar"]');

    // Priority 1: Radiogroup children (div[role='radiogroup'] > div)
    const radiogroupChildren = Array.from(document.querySelectorAll("div[role='radiogroup'] > div")).filter((el) => {
      return safeIsVisible(el) && notInSidebar(el);
    });
    if (radiogroupChildren.length > 0) return radiogroupChildren;

    // Priority 2: Choice cards containing radio button or bold label
    const choiceCards = Array.from(document.querySelectorAll("div.rounded-xl.border-2")).filter((el) => {
      return safeIsVisible(el) && notInSidebar(el) && (el.querySelector("button[role='radio']") || el.querySelector("span.font-bold"));
    });
    if (choiceCards.length > 0) return choiceCards;

    // Priority 3: Direct radio buttons
    const radios = Array.from(document.querySelectorAll("button[role='radio']")).filter((el) => {
      return safeIsVisible(el) && notInSidebar(el);
    });
    if (radios.length > 0) return radios;

    // Priority 4: min-h-[80px] cards
    const minHCards = Array.from(document.querySelectorAll("div.border-2.rounded-xl.min-h-\\[80px\\]")).filter((el) => {
      return safeIsVisible(el) && notInSidebar(el);
    });
    if (minHCards.length > 0) return minHCards;

    // Priority 5: Generic border-2 cursor-pointer
    const pointerCards = Array.from(document.querySelectorAll("div.border-2.cursor-pointer")).filter((el) => {
      if (!safeIsVisible(el) || !notInSidebar(el)) return false;
      const txt = (el.textContent || '').trim();
      const ignore = ['Không có câu hỏi', 'Trả lời trên lớp', 'Kiểm tra', 'Câu tiếp theo', 'Thử lại', 'Trang sau'];
      return !ignore.includes(txt) && txt.length > 0 && txt.length < 500;
    });
    if (pointerCards.length > 0) return pointerCards;

    return [];
  }

  /**
   * Fingerprint answer options when question text cannot be determined.
   * Matches Playwright: answers_fingerprint()
   */
  function answersFingerprint(answerEls) {
    if (!answerEls || answerEls.length === 0) return '';
    try {
      return Array.from(answerEls)
        .map((el) => (el.textContent || '').trim())
        .filter(Boolean)
        .join(' | ')
        .substring(0, 200);
    } catch (e) {
      return '';
    }
  }

  /**
   * Extract question text using Playwright's multi-candidate list.
   * Matches Playwright: get_question_text()
   */
  function getSlideQuestionText(answerEls) {
    const candidates = [
      document.querySelector("div.bg-blue-50.border-blue-500"),
      document.querySelector("[class*='text-blue-800']"),
      document.querySelector("div.bg-blue-50"),
      document.querySelector("p.my-3.text-gray-800.leading-relaxed"),
      document.querySelector("div[role='dialog'] h3"),
      document.querySelector("div[role='dialog'] .font-semibold"),
      document.querySelector("div[role='dialog'] h2")
    ];

    for (const el of candidates) {
      if (el && safeIsVisible(el)) {
        const txt = (el.textContent || '').trim();
        if (txt && txt.length > 3) return txt;
      }
    }

    return answersFingerprint(answerEls) || '?';
  }

  /**
   * Helper to determine if an element has green styling indicating correct answer.
   */
  function isGreenIndicator(el) {
    if (!el) return false;
    try {
      const cls = (el.className && typeof el.className === 'string') ? el.className : '';
      if (
        cls.includes('border-green') ||
        cls.includes('bg-green') ||
        cls.includes('text-green') ||
        cls.includes('border-emerald') ||
        cls.includes('bg-emerald')
      ) {
        if (!cls.includes('border-red') && !cls.includes('bg-red') && !cls.includes('text-red')) {
          return true;
        }
      }

      const style = window.getComputedStyle(el);
      for (const colorStr of [style.borderColor, style.backgroundColor, style.color]) {
        if (!colorStr) continue;
        const match = colorStr.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (match) {
          const r = parseInt(match[1], 10);
          const g = parseInt(match[2], 10);
          const b = parseInt(match[3], 10);
          if (g >= 120 && g > r * 1.25 && g > b * 1.1) {
            return true;
          }
        }
      }
    } catch (e) {}
    return false;
  }

  function isCardMarkedRed(card) {
    if (!card) return false;
    const cls = (card.className && typeof card.className === 'string') ? card.className : '';
    if (cls.includes('border-red') || cls.includes('bg-red') || cls.includes('text-red')) return true;
    const redChild = card.querySelector("[class*='border-red'], [class*='bg-red'], [class*='text-red']");
    if (redChild && safeIsVisible(redChild)) return true;
    try {
      const style = window.getComputedStyle(card);
      for (const colorStr of [style.borderColor, style.backgroundColor]) {
        if (!colorStr) continue;
        const match = colorStr.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (match) {
          const r = parseInt(match[1], 10);
          const g = parseInt(match[2], 10);
          const b = parseInt(match[3], 10);
          if (r >= 150 && r > g * 1.4 && r > b * 1.4) return true;
        }
      }
    } catch (e) {}
    return false;
  }

  function isCardMarkedGreen(card) {
    if (!card) return false;
    if (isGreenIndicator(card)) return true;

    const greenDescendant = card.querySelector(
      "[class*='border-green'], [class*='bg-green'], [class*='text-green'], [class*='border-emerald'], [class*='bg-emerald'], svg.text-green-500, svg[class*='text-green']"
    );
    if (greenDescendant && safeIsVisible(greenDescendant)) {
      const cls = greenDescendant.className || '';
      if (typeof cls === 'string' && !cls.includes('red')) return true;
    }

    const radio = card.querySelector("button[role='radio'], div[role='radio'], input[type='radio']");
    if (radio && isGreenIndicator(radio)) return true;

    return false;
  }

  /**
   * Extract revealed correct answer letter when EDUX displays "Đáp án đúng: X."
   * OR when EDUX highlights the correct answer card in green.
   * Returns zero-based option index (0 for A, 1 for B, etc.)
   * Matches Playwright: extract_revealed_correct_index()
   */
  function extractRevealedCorrectIndex(answerEls = null) {
    // 1. Text search: "Đáp án đúng: X"
    const selectors = [
      "div.text-red-700",
      "[class*='text-red']",
      "div[role='dialog'] div",
      "div[role='dialog'] p",
      "div",
      "p"
    ];

    for (const sel of selectors) {
      try {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          if (!safeIsVisible(el)) continue;
          const text = el.textContent || '';
          if (text.includes('Đáp án đúng:')) {
            const match = text.match(/Đáp án đúng:\s*([A-Za-z])\b/);
            if (match) {
              const letter = match[1].toUpperCase();
              return letter.charCodeAt(0) - 'A'.charCodeAt(0);
            }
          }
        }
      } catch (e) {}
    }

    // 2. Visual card detection: Green card that is not red
    const cards = answerEls && answerEls.length > 0 ? answerEls : getSlideAnswerElements();
    if (cards && cards.length > 0) {
      for (let i = 0; i < cards.length; i++) {
        const card = cards[i];
        if (isCardMarkedRed(card)) continue;
        if (isCardMarkedGreen(card)) {
          return i;
        }
      }
    }

    return null;
  }

  /**
   * Wait until an element becomes hidden or timeout expires.
   */
  async function waitForHidden(el, timeoutMs = 1500) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (!el || !safeIsVisible(el)) break;
      await sleep(100);
    }
  }

  // =========================================================================
  // 4. Slide Brute-force Engine (Ported from quizz_bruteforce.py)
  // =========================================================================

  async function runSlideBruteforceStep() {
    if (!isSlideRunning) return;

    try {
      // =====================================================================
      // STEP 1: Handle Completion / Transitions (High Priority)
      // Matches Playwright BƯỚC 1 (lines 460-547)
      // =====================================================================

      // 1.1: "Trang sau" button in Dialog (quiz completed, green button)
      const dialogNextBtn = getDialogNextPageButton();
      if (dialogNextBtn) {
        logMessage("[Done] Phát hiện nút 'Trang sau' trong popup quiz, đang chuyển slide...", 'success');
        safeClick(dialogNextBtn);
        await waitForHidden(dialogNextBtn, 3000);
        await sleep(300);
        lastProgress = Date.now();
        stallReported = false;
        return scheduleNextStep(config.delayMs);
      }

      // 1.2: "Bỏ qua" button (skip countdown timer 3-5s)
      const skipBtn = getDialogSkipButton();
      if (skipBtn) {
        logMessage("[Done] Bấm nút 'Bỏ qua' (Skip Countdown)...", 'info');
        safeClick(skipBtn);
        await waitForHidden(skipBtn, 1500);
        await sleep(200);

        const dNext = getDialogNextPageButton();
        if (dNext) {
          logMessage("[Done] Bấm tiếp 'Trang sau' sau khi bỏ qua...", 'success');
          safeClick(dNext);
          await waitForHidden(dNext, 3000);
        }
        lastProgress = Date.now();
        stallReported = false;
        return scheduleNextStep(config.delayMs);
      }

      // 1.3: "Câu tiếp theo" button
      const nextQBtn = getDialogNextQuestionButton();
      if (nextQBtn) {
        logMessage("[Done] Chuyển 'Câu tiếp theo'...", 'info');
        safeClick(nextQBtn);
        await waitForHidden(nextQBtn, 3000);
        await sleep(300);
        lastProgress = Date.now();
        stallReported = false;
        return scheduleNextStep(config.delayMs);
      }

      // 1.4: "Thử lại" button (extract revealed answer first!)
      const retryBtn = getDialogRetryButton();
      if (retryBtn) {
        logMessage("[INFO] Phát hiện nút 'Thử lại', chuẩn bị thử lại câu hỏi...", 'warn');
        const currentAnswerList = getSlideAnswerElements();
        const revealedIdx = extractRevealedCorrectIndex(currentAnswerList);
        if (revealedIdx !== null) {
          const qText = getSlideQuestionText(currentAnswerList);
          knownCorrectAnswers[qText] = revealedIdx;
          logMessage(`[Revealed] 🎯 Ghi nhớ đáp án đúng: #${revealedIdx + 1}`, 'success');
        }
        safeClick(retryBtn);
        await waitForHidden(retryBtn, 5000);
        await sleep(300);
        lastProgress = Date.now();
        stallReported = false;
        return scheduleNextStep(config.delayMs);
      }

      // 1.5: Slide has no question ("Không có câu hỏi")
      const noQuestionBtn = findActionButton(['Không có câu hỏi'], false);
      if (noQuestionBtn) {
        logMessage('[INFO] Slide không có câu hỏi -> Chuyển slide tiếp theo', 'info');
        safeNextSlide();
        await waitForHidden(noQuestionBtn, 1500);
        await sleep(300);
        lastProgress = Date.now();
        stallReported = false;
        return scheduleNextStep(config.delayMs);
      }

      // =====================================================================
      // STEP 2: Check Slide Status / Open Quiz Popup
      // Matches Playwright BƯỚC 2 (lines 549-593)
      // =====================================================================
      const answerList = getSlideAnswerElements();
      const answersVisible = answerList.length > 0;

      if (!answersVisible) {
        // 2.1: Open quiz popup if "Trả lời trên lớp" or "Hỏi trên lớp" button exists
        const openBtn = findActionButton(['Trả lời trên lớp', 'Hỏi trên lớp'], true);
        if (openBtn) {
          logMessage('[INFO] Bấm mở popup câu hỏi...', 'info');
          safeClick(openBtn);
          await sleep(500);
          lastProgress = Date.now();
          stallReported = false;
          return scheduleNextStep(config.delayMs);
        }

        // 2.2: Slide is checking ("Đang kiểm tra...")
        const isChecking = Array.from(document.querySelectorAll('span, div, p')).some((el) => {
          return safeIsVisible(el) && (el.textContent || '').includes('Đang kiểm tra...');
        });
        if (isChecking) {
          await sleep(500);
          return scheduleNextStep(300);
        }

        // 2.3: Slide completed or no question: "Trang sau" on slide bar is ENABLED
        if (!getActiveDialog()) {
          const slideNextBtn = findActionButton(['Trang sau'], true);
          if (slideNextBtn) {
            logMessage("[INFO] Bấm 'Trang sau' trên thanh điều khiển slide...", 'info');
            safeClick(slideNextBtn);
            await sleep(500);
            lastProgress = Date.now();
            stallReported = false;
            return scheduleNextStep(config.delayMs);
          }
        }

        // 2.4: Stall Watchdog & Keyboard Recovery
        if (!stallReported && Date.now() - lastProgress > STALL_MS) {
          if (!getActiveDialog()) {
            logMessage('[RECOVERY] Không thấy nút khả dụng, nhấn phím ArrowRight để chuyển slide...', 'warn');
            window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, which: 39, bubbles: true }));
            window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, which: 39, bubbles: true }));
          } else {
            logMessage('[STALL] Đang chờ câu hỏi hoặc kết quả...', 'warn');
          }
          stallReported = true;
          lastProgress = Date.now();
        }

        return scheduleNextStep(400);
      }

      // =====================================================================
      // STEP 3: Answer Question (Answers ARE Visible)
      // Matches Playwright BƯỚC 3 (lines 595-637)
      // =====================================================================
      lastProgress = Date.now();
      stallReported = false;

      const answerCount = answerList.length;
      if (answerCount === 0) return scheduleNextStep(400);

      const questionText = getSlideQuestionText(answerList);
      logMessage(`[Q] ${questionText.substring(0, 60)}...`, 'info');

      // Decide which index to pick
      let nextIndex = 0;
      if (questionText in knownCorrectAnswers && knownCorrectAnswers[questionText] < answerCount) {
        nextIndex = knownCorrectAnswers[questionText];
        logMessage(`[Pick Known Correct] 🎯 #${nextIndex + 1}/${answerCount}`, 'success');
      } else {
        if (!wrongAnswersMap[questionText]) {
          wrongAnswersMap[questionText] = new Set();
        }
        const triedIndices = wrongAnswersMap[questionText];
        if (triedIndices.size >= answerCount) {
          triedIndices.clear();
        }

        for (let i = 0; i < answerCount; i++) {
          if (!triedIndices.has(i)) {
            nextIndex = i;
            break;
          }
        }
        logMessage(`[Pick] #${nextIndex + 1}/${answerCount}`, 'info');
      }

      // Select answer: click option card AND inner radio/checkbox to guarantee event trigger
      const optionCard = answerList[nextIndex];
      const radioInside = optionCard.querySelector("button[role='radio'], div[role='radio'], input[type='radio']");

      safeClick(optionCard);
      if (radioInside) {
        safeClick(radioInside);
      }

      await sleep(150);

      // Check if clicking the option card already triggered instant submission / completion
      let instantAction = getDialogNextPageButton() || getDialogNextQuestionButton() || getDialogRetryButton() || getDialogSkipButton();
      let checkBtn = null;

      if (!instantAction) {
        // Fast auto-wait for "Kiểm tra" button to become ENABLED (up to 400ms)
        for (let w = 0; w < 4; w++) {
          checkBtn = findActionButton(['Kiểm tra'], true);
          if (checkBtn) break;
          instantAction = getDialogNextPageButton() || getDialogNextQuestionButton() || getDialogRetryButton() || getDialogSkipButton();
          if (instantAction) break;
          await sleep(100);
        }

        if (!checkBtn && !instantAction) {
          checkBtn = findActionButton(['Kiểm tra'], false);
        }
      }

      if (checkBtn && !instantAction) {
        logMessage("[INFO] Bấm nút 'Kiểm tra'...", 'info');
        safeClick(checkBtn);
      } else if (!instantAction) {
        // No "Kiểm tra" button found: this quiz submits instantly upon option selection!
        logMessage('[INFO] Trắc nghiệm nộp tức thì, đang xử lý kết quả...', 'info');
      }

      // =====================================================================
      // STEP 4: Immediate Result Handling After Submission
      // Matches Playwright BƯỚC 4 (lines 639-733)
      // =====================================================================
      const waitStart = Date.now();
      let handled = false;

      while (Date.now() - waitStart < 4000 && isSlideRunning) {
        // 4.1: Completion button ("Trang sau" / "Tiếp tục" / "Hoàn thành")
        const curDialogNext = getDialogNextPageButton();
        if (curDialogNext) {
          solvedCount++;
          chrome.storage.local.set({ slideStats: { solved: solvedCount, retries: retryCount } });
          logMessage("[Done] 🎉 Đã hoàn thành quiz trên slide! Bấm 'Trang sau' chuyển tiếp", 'success');
          safeClick(curDialogNext);
          await waitForHidden(curDialogNext, 1500);
          await sleep(150);
          lastProgress = Date.now();
          stallReported = false;
          handled = true;
          break;
        }

        // 4.2: Next Question button
        const curNextQ = getDialogNextQuestionButton();
        if (curNextQ) {
          solvedCount++;
          chrome.storage.local.set({ slideStats: { solved: solvedCount, retries: retryCount } });
          logMessage("[Done] Đã giải đúng! Chuyển 'Câu tiếp theo'", 'success');
          safeClick(curNextQ);
          await waitForHidden(curNextQ, 1500);
          await sleep(150);
          lastProgress = Date.now();
          stallReported = false;
          handled = true;
          break;
        }

        // 4.3: If wrong answer -> "Thử lại" appears
        const curRetry = getDialogRetryButton();
        if (curRetry) {
          retryCount++;
          const curCards = getSlideAnswerElements();
          const revealed = extractRevealedCorrectIndex(curCards);
          if (revealed !== null && revealed < answerCount) {
            knownCorrectAnswers[questionText] = revealed;
            logMessage(`[Revealed] 🎯 Đáp án đúng được hiển thị: #${revealed + 1}`, 'success');
          } else {
            if (!wrongAnswersMap[questionText]) wrongAnswersMap[questionText] = new Set();
            wrongAnswersMap[questionText].add(nextIndex);
            logMessage(`[Wrong] Đã loại đáp án #${nextIndex + 1}`, 'warn');
          }

          chrome.storage.local.set({ slideStats: { solved: solvedCount, retries: retryCount } });
          safeClick(curRetry);
          await waitForHidden(curRetry, 2000);
          await sleep(150);
          lastProgress = Date.now();
          stallReported = false;
          handled = true;
          break;
        }

        // 4.4: Skip Countdown button
        const curSkip = getDialogSkipButton();
        if (curSkip) {
          safeClick(curSkip);
          logMessage("[Done] Đã bấm 'Bỏ qua' đếm ngược", 'info');
          await waitForHidden(curSkip, 1000);
        }

        // 4.5: Next Page button on Slide Bar
        if (!getActiveDialog()) {
          const curSlideNext = findActionButton(['Trang sau'], true);
          if (curSlideNext) {
            solvedCount++;
            chrome.storage.local.set({ slideStats: { solved: solvedCount, retries: retryCount } });
            logMessage("[Done] Bấm 'Trang sau' trên Slide", 'success');
            safeClick(curSlideNext);
            await waitForHidden(curSlideNext, 1500);
            await sleep(150);
            lastProgress = Date.now();
            stallReported = false;
            handled = true;
            break;
          }
        }

        await sleep(100);
      }

      if (!handled) {
        logMessage('[WARN] Chưa thấy nút phản hồi sau Kiểm tra (có thể do lag mạng), thử lại...', 'warn');
      }

      scheduleNextStep(config.delayMs);
    } catch (err) {
      console.error('[EDUX Slayers] Loop Error:', err);
      logMessage(`[WARN] Lỗi tạm thời, tự hồi phục: ${String(err).substring(0, 80)}`, 'warn');
      scheduleNextStep(1000);
    }
  }

  function scheduleNextStep(delay) {
    if (isSlideRunning) {
      slideLoopTimer = setTimeout(runSlideBruteforceStep, delay);
    }
  }

  function startSlideBruteforce(customConfig) {
    if (customConfig) config = { ...config, ...customConfig };
    if (isSlideRunning) return;

    isSlideRunning = true;
    lastProgress = Date.now();
    stallReported = false;
    wrongAnswersMap = {};
    knownCorrectAnswers = {};
    solvedCount = 0;
    retryCount = 0;

    logMessage('▶️ Bắt đầu tự động giải Slide!', 'success');
    notifyPopup('SLIDE_STATUS_CHANGE', { isRunning: true });
    updateWidgetUI('Đang tự động giải Slide...', 'info', true);
    runSlideBruteforceStep();
  }

  function stopSlideBruteforce() {
    isSlideRunning = false;
    if (slideLoopTimer) clearTimeout(slideLoopTimer);
    slideLoopTimer = null;

    logMessage('⏹️ Đã dừng tự động giải Slide.', 'warn');
    notifyPopup('SLIDE_STATUS_CHANGE', { isRunning: false });
    updateWidgetUI('Sẵn sàng', 'idle', false);
  }

  // =========================================================================
  // 5. Test Solver Engine (Ported from test_solver.py)
  // =========================================================================

  const TF_TOKEN_RE = /(\d+)\s*\.\s*(đúng|sai|true|false|d|đ|s|t|f|1|0)/gi;

  function normalizeText(text) {
    return (text || '').toLowerCase().trim().replace(/\s+/g, ' ');
  }

  function parseQuestionIndex(text) {
    const match = (text || '').trim().match(/^Câu\s+(\d+)/);
    return match ? parseInt(match[1]) : null;
  }

  function parseTrueFalseAnswers(answerValue, expectedCount) {
    const normalized = normalizeText(answerValue);
    const result = [];

    TF_TOKEN_RE.lastIndex = 0;
    let match;
    const regexMatches = [];
    while ((match = TF_TOKEN_RE.exec(normalized)) !== null) {
      regexMatches.push(match[2].toLowerCase());
    }

    if (regexMatches.length > 0) {
      for (const token of regexMatches) {
        result.push(['đúng', 'd', 'đ', 'true', 't', '1'].includes(token));
      }
      return result;
    }

    const tokens = normalized.match(/[a-zà-ỹ]+|\d/g) || [];
    for (const token of tokens) {
      if (['đúng', 'd', 'đ', 'true', 't', '1'].includes(token)) {
        result.push(true);
      } else if (['sai', 's', 'false', 'f', '0'].includes(token)) {
        result.push(false);
      }
      if (result.length >= expectedCount) break;
    }
    return result;
  }

  function normalizeAnswersPayload(data) {
    const answers = {};
    if (Array.isArray(data)) {
      data.forEach((item) => {
        if (typeof item !== 'object' || item === null) return;
        const idx = item.so_cau ?? item.soCau ?? item.question ?? item.id;
        const ans = item.dap_an ?? item.dapAn ?? item.answer;
        if (idx == null || ans == null) return;
        const idxInt = parseInt(idx);
        if (isNaN(idxInt)) return;
        if (Array.isArray(ans)) {
          answers[idxInt] = ans.map((x) => String(x)).join(', ');
        } else {
          answers[idxInt] = String(ans).trim();
        }
      });
    } else if (typeof data === 'object' && data !== null) {
      Object.entries(data).forEach(([key, value]) => {
        const idxInt = parseInt(key);
        if (isNaN(idxInt)) return;
        if (Array.isArray(value)) {
          answers[idxInt] = value.map((x) => String(x)).join(', ');
        } else {
          answers[idxInt] = String(value).trim();
        }
      });
    }
    return answers;
  }

  function loadAnswersFromInput(rawText) {
    let line = (rawText || '').trim();
    if (line.charCodeAt(0) === 0xfeff) {
      line = line.substring(1).trim();
    }

    if (line.startsWith('[') || line.startsWith('{')) {
      try {
        let data = JSON.parse(line);
        if (typeof data === 'object' && data !== null && !Array.isArray(data) && 'answers' in data) {
          data = data.answers;
        }
        const parsed = normalizeAnswersPayload(data);
        if (Object.keys(parsed).length > 0) return parsed;
      } catch (e) {}
    }

    const normalizedJson = line.replace(/}\s*{/g, '}\n{');
    const jsonItems = [];
    for (const chunk of normalizedJson.split('\n')) {
      const trimmed = chunk.trim();
      if (!trimmed) continue;
      try {
        jsonItems.push(JSON.parse(trimmed));
      } catch (e) {}
    }
    if (jsonItems.length > 0) {
      const parsed = normalizeAnswersPayload(jsonItems);
      if (Object.keys(parsed).length > 0) return parsed;
    }

    const answers = {};
    const lines = rawText.split('\n');
    lines.forEach((l) => {
      const match = l.trim().match(/^(\d+)\s*[\.:\-\)]\s*(.+)$/);
      if (match) {
        answers[parseInt(match[1])] = match[2].trim();
      }
    });

    return answers;
  }

  /**
   * Set native value on input/textarea with React _valueTracker reset.
   */
  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;

    if (el._valueTracker) {
      el._valueTracker.setValue('');
    }

    if (setter) {
      setter.call(el, value);
    } else {
      el.value = value;
    }

    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  }

  function extractOptionsFromEls(optionEls) {
    return optionEls.map((node) => ({
      node,
      letter: (node.querySelector('span.flex-shrink-0') || {}).textContent?.trim() || '',
      text: (node.querySelector('div.prose p, p') || node).textContent?.trim() || ''
    }));
  }

  async function fillTestAnswers(rawText) {
    const answers = loadAnswersFromInput(rawText);
    const questionIndices = Object.keys(answers);
    if (questionIndices.length === 0) {
      return { success: false, message: 'Không phân tích được danh sách đáp án nào!' };
    }

    logMessage(`Bắt đầu điền ${questionIndices.length} đáp án cho bài kiểm tra...`, 'info', true);
    updateWidgetUI('Đang điền bài kiểm tra...', 'info', true);

    const dialog = getActiveDialog();
    let result;
    if (dialog && safeIsVisible(dialog)) {
      result = await fillTestDialog(dialog, answers);
    } else {
      result = fillTestFullPage(answers);
    }

    updateWidgetUI('Hoàn thành điền bài', 'idle', false);
    return result;
  }

  /**
   * Step-by-step Dialog Mode (Matches test_solver.py lines 483-623)
   */
  async function fillTestDialog(dialog, answers) {
    let filledCount = 0;
    const maxIterations = Object.keys(answers).length + 10;
    let iterations = 0;

    while (iterations < maxIterations) {
      iterations++;

      // 1. Wait for question label "Câu X"
      let labelEl = null;
      for (let wait = 0; wait < 15; wait++) {
        labelEl = findQuestionLabel(dialog);
        if (labelEl) break;
        await sleep(200);
      }
      if (!labelEl) break;

      const labelText = labelEl.textContent.trim();
      const questionIndex = parseQuestionIndex(labelText);
      if (questionIndex === null) break;

      const answerValue = (answers[questionIndex] || '').trim();

      if (!answerValue) {
        logMessage(`[WARN] Không có đáp án cho câu ${questionIndex}, bỏ qua.`, 'warn', true);
      } else {
        // Detect question type:
        // 1. True/False blocks
        const trueFalseBlocks = Array.from(
          dialog.querySelectorAll("div.border.border-gray-200.rounded-lg.p-3.bg-gray-50, div[class*='bg-gray-50']")
        ).filter(safeIsVisible);

        const textareaEl = dialog.querySelector('textarea');
        const inputEl = dialog.querySelector("input[type='text']");

        const optionEls = Array.from(
          dialog.querySelectorAll("div.relative.flex.items-center.space-x-2.p-2.border.rounded-lg.cursor-pointer, div.border.rounded-lg.cursor-pointer")
        ).filter(safeIsVisible);

        if (trueFalseBlocks.length > 0) {
          const tfAnswers = parseTrueFalseAnswers(answerValue, trueFalseBlocks.length);
          logMessage(`[INFO] Câu ${questionIndex}: điền Đúng/Sai`, 'info', true);
          for (let i = 0; i < trueFalseBlocks.length; i++) {
            const block = trueFalseBlocks[i];
            const targetName = (i < tfAnswers.length ? tfAnswers[i] : true) ? 'Đúng' : 'Sai';
            const btn = Array.from(block.querySelectorAll('button')).find(
              (b) => (b.textContent || '').trim() === targetName
            );
            if (btn) safeClick(btn);
          }
          filledCount++;
        } else if (textareaEl && safeIsVisible(textareaEl)) {
          logMessage(`[INFO] Câu ${questionIndex}: điền tự luận`, 'info', true);
          setNativeValue(textareaEl, answerValue);
          filledCount++;
        } else if (inputEl && safeIsVisible(inputEl)) {
          logMessage(`[INFO] Câu ${questionIndex}: điền ô trống`, 'info', true);
          setNativeValue(inputEl, answerValue);
          filledCount++;
        } else {
          // Multiple choice
          let currentOptionEls = optionEls;
          if (currentOptionEls.length === 0) {
            for (let wait = 0; wait < 10; wait++) {
              await sleep(200);
              currentOptionEls = Array.from(
                dialog.querySelectorAll("div.relative.flex.items-center.space-x-2.p-2.border.rounded-lg.cursor-pointer, div.border.rounded-lg.cursor-pointer")
              ).filter(safeIsVisible);
              if (currentOptionEls.length > 0) break;
            }
          }

          if (currentOptionEls.length === 0) {
            logMessage(`[WARN] Câu ${questionIndex}: không tìm thấy lựa chọn đáp án.`, 'warn', true);
          } else {
            logMessage(`[INFO] Câu ${questionIndex}: chọn '${answerValue}'`, 'info', true);
            const options = extractOptionsFromEls(currentOptionEls);
            let chosenIndex = -1;

            if (answerValue.length === 1 && 'ABCD'.includes(answerValue.toUpperCase())) {
              const targetLetter = answerValue.toUpperCase() + '.';
              chosenIndex = options.findIndex((opt) => opt.letter.startsWith(targetLetter));
            } else {
              const target = normalizeText(answerValue);
              if (target) {
                chosenIndex = options.findIndex((opt) => normalizeText(opt.text).includes(target));
              }
            }

            if (chosenIndex === -1) {
              logMessage(`[WARN] Câu ${questionIndex}: Không khớp được lựa chọn.`, 'warn', true);
            } else {
              safeClick(options[chosenIndex].node);
              filledCount++;
            }
          }
        }
      }

      await sleep(200);

      // Check for Submit button or Next Question button
      const submitBtn = findActionButton(['Nộp bài'], true);
      const nextBtn = findActionButton(['Câu tiếp', 'Câu tiếp theo'], true);

      if (submitBtn && !nextBtn) {
        logMessage("[INFO] Đã đến câu cuối bài kiểm tra. Nhấn 'Nộp bài' để hoàn thành.", 'success', true);
        break;
      }

      if (nextBtn) {
        const currentLabel = labelText;
        const progressEl = dialog.querySelector('span.text-gray-700');
        const currentProgress = progressEl ? progressEl.textContent.trim() : '';

        safeClick(nextBtn);

        // Wait for next question to appear
        let changed = false;
        for (let i = 0; i < 50; i++) {
          await sleep(150);
          const newLabelEl = findQuestionLabel(dialog);
          if (newLabelEl && newLabelEl.textContent.trim() !== currentLabel) {
            changed = true;
            break;
          }
          const newProgressEl = dialog.querySelector('span.text-gray-700');
          if (newProgressEl && newProgressEl.textContent.trim() !== currentProgress) {
            changed = true;
            break;
          }
        }

        if (!changed) {
          logMessage('[WARN] Câu tiếp theo chưa hiển thị kịp.', 'warn', true);
          break;
        }
      } else {
        break;
      }
    }

    logMessage(`🎉 Đã điền xong ${filledCount} câu trong bài kiểm tra.`, 'success', true);
    return { success: true, filledCount };
  }

  function fillTestFullPage(answers) {
    let filledCount = 0;
    const questionLabels = Array.from(document.querySelectorAll('p, div, span, h3, h4')).filter((el) => {
      return safeIsVisible(el) && /^Câu\s+\d+/.test((el.textContent || '').trim());
    });

    questionLabels.forEach((labelEl) => {
      const qNum = parseQuestionIndex(labelEl.textContent);
      if (qNum === null) return;

      const targetAns = answers[qNum];
      if (!targetAns) return;

      let container = labelEl.closest('div.border, div.rounded-xl, div.shadow, section, article') || labelEl.parentElement;
      if (!container) return;

      const tfBlocks = Array.from(
        container.querySelectorAll('div.border.border-gray-200.rounded-lg.p-3.bg-gray-50, div[class*="bg-gray-50"]')
      ).filter(safeIsVisible);

      if (tfBlocks.length > 0) {
        const tfAnswers = parseTrueFalseAnswers(targetAns, tfBlocks.length);
        tfBlocks.forEach((block, i) => {
          const shouldBeTrue = i < tfAnswers.length ? tfAnswers[i] : true;
          const btn = Array.from(block.querySelectorAll('button')).find(
            (b) => (b.textContent || '').trim() === (shouldBeTrue ? 'Đúng' : 'Sai')
          );
          if (btn) safeClick(btn);
        });
        filledCount++;
        logMessage(`✓ Câu ${qNum}: đã chọn Đúng/Sai`, 'success', true);
        return;
      }

      const textarea = container.querySelector('textarea');
      if (textarea && safeIsVisible(textarea)) {
        setNativeValue(textarea, targetAns);
        filledCount++;
        logMessage(`✓ Câu ${qNum}: đã điền tự luận`, 'success', true);
        return;
      }

      const input = container.querySelector("input[type='text']");
      if (input && safeIsVisible(input)) {
        setNativeValue(input, targetAns);
        filledCount++;
        logMessage(`✓ Câu ${qNum}: đã điền ô trống`, 'success', true);
        return;
      }

      const optionEls = Array.from(
        container.querySelectorAll('div.relative.flex.items-center.space-x-2.p-2.border.rounded-lg.cursor-pointer, div.cursor-pointer, label')
      ).filter(safeIsVisible);

      for (const opt of optionEls) {
        const optText = (opt.textContent || '').trim();
        const letterSpan = (opt.querySelector('span.flex-shrink-0') || {}).textContent?.trim() || '';
        const targetUpper = targetAns.toUpperCase();

        if (
          letterSpan === targetUpper ||
          letterSpan.startsWith(targetUpper + '.') ||
          optText.startsWith(targetUpper + '.') ||
          (targetAns.length > 1 && normalizeText(optText).includes(normalizeText(targetAns)))
        ) {
          safeClick(opt);
          filledCount++;
          logMessage(`✓ Câu ${qNum}: đã chọn ${targetAns}`, 'success', true);
          break;
        }
      }
    });

    logMessage(`🎉 Đã tự động điền xong ${filledCount} câu hỏi.`, 'success', true);
    return { success: true, filledCount };
  }

  function findQuestionLabel(container) {
    return Array.from(container.querySelectorAll('span, div, p, h3, h4')).find((el) => {
      return safeIsVisible(el) && /^Câu\s+\d+/.test((el.textContent || '').trim());
    }) || null;
  }

  /**
   * Build compact prompt payload matching Playwright's build_compact_prompt_payload().
   */
  function buildCompactPromptPayload(payloadJson) {
    const data = (payloadJson && payloadJson.data) || {};
    const examData = data.exam_data || {};

    const compact = {
      title: data.title || document.title || 'EDUX Exam',
      total_questions: data.total_questions || 0,
      multiple_choice: [],
      fill_in_blank: [],
      essay: [],
      true_false: []
    };

    const mcList = examData.multiple_choice || (Array.isArray(data) ? data : []);
    for (const item of mcList) {
      if (item && item.question) {
        compact.multiple_choice.push({
          id: item.id || item.so_cau,
          question: item.question,
          options: item.options
        });
      }
    }

    for (const item of examData.fill_in_blank || []) {
      compact.fill_in_blank.push({ id: item.id, question: item.question });
    }

    for (const item of examData.essay || []) {
      compact.essay.push({ id: item.id, question: item.question });
    }

    for (const item of examData.true_false || []) {
      const statements = (item.statements || []).map((s) => (typeof s === 'string' ? s : s.text));
      compact.true_false.push({ id: item.id, question: item.question, statements });
    }

    compact.total_questions =
      compact.multiple_choice.length +
      compact.fill_in_blank.length +
      compact.essay.length +
      compact.true_false.length;

    return compact;
  }

  function extractQuestions() {
    // If we intercepted the exact API payload from /start or /exam, format it directly!
    if (lastCapturedExamData) {
      const compact = buildCompactPromptPayload(lastCapturedExamData);
      const promptInstruction =
        'trả về JSONL một dòng duy nhất (không xuống dòng); ' +
        'mỗi phần tử có so_cau và dap_an; ' +
        'dap_an là A/B/C/D hoặc từ/cụm từ/văn bản cần điền; ' +
        'với câu đúng/sai, dap_an là mảng giá trị Đúng/Sai theo thứ tự mệnh đề; ' +
        'không giải thích gì thêm';
      const promptText = JSON.stringify(compact, null, 2) + '\n\n' + promptInstruction + '\n';
      return { questions: compact, promptText };
    }

    // Fallback: Scrape from DOM
    const compact = {
      title: document.title || 'EDUX Exam',
      total_questions: 0,
      multiple_choice: [],
      fill_in_blank: [],
      essay: [],
      true_false: []
    };

    const searchRoot = getActiveDialog() || document;
    const questionLabels = Array.from(searchRoot.querySelectorAll('p, div, span, h3, h4')).filter((el) => {
      return safeIsVisible(el) && /^Câu\s+\d+/.test((el.textContent || '').trim());
    });

    questionLabels.forEach((labelEl) => {
      const qNum = parseQuestionIndex(labelEl.textContent);
      if (qNum === null) return;

      let container = labelEl.closest('div.border, div.rounded-xl, div.shadow, section, article') || labelEl.parentElement;
      if (!container) return;

      const questionText = (container.querySelector('div.prose p, p.text-gray-800') || {}).textContent?.trim() || labelEl.textContent.trim();

      const tfBlocks = Array.from(
        container.querySelectorAll('div.border.border-gray-200.rounded-lg.p-3.bg-gray-50, div[class*="bg-gray-50"]')
      ).filter(safeIsVisible);

      const textarea = container.querySelector('textarea');
      const input = container.querySelector("input[type='text']");
      const optionEls = Array.from(
        container.querySelectorAll('div.relative.flex.items-center.space-x-2.p-2.border.rounded-lg.cursor-pointer, div.border.cursor-pointer')
      ).filter(safeIsVisible);

      if (tfBlocks.length > 0) {
        const statements = tfBlocks.map((b) => (b.querySelector('p, span') || b).textContent?.trim() || '');
        compact.true_false.push({ id: qNum, question: questionText, statements });
      } else if (textarea) {
        compact.essay.push({ id: qNum, question: questionText });
      } else if (input) {
        compact.fill_in_blank.push({ id: qNum, question: questionText });
      } else if (optionEls.length > 0) {
        const options = optionEls.map((opt) => {
          const letter = (opt.querySelector('span.flex-shrink-0') || {}).textContent?.trim() || '';
          const text = (opt.querySelector('div.prose p, p') || opt).textContent?.trim() || '';
          return `${letter} ${text}`.trim();
        });
        compact.multiple_choice.push({ id: qNum, question: questionText, options });
      }
    });

    compact.total_questions =
      compact.multiple_choice.length +
      compact.fill_in_blank.length +
      compact.essay.length +
      compact.true_false.length;

    const promptInstruction =
      'trả về JSONL một dòng duy nhất (không xuống dòng); ' +
      'mỗi phần tử có so_cau và dap_an; ' +
      'dap_an là A/B/C/D hoặc từ/cụm từ/văn bản cần điền; ' +
      'với câu đúng/sai, dap_an là mảng giá trị Đúng/Sai theo thứ tự mệnh đề; ' +
      'không giải thích gì thêm';

    const promptText = JSON.stringify(compact, null, 2) + '\n\n' + promptInstruction + '\n';
    return { questions: compact, promptText };
  }

  // =========================================================================
  // 6. Floating Widget Cleanup (Removed as requested)
  // =========================================================================
  let widgetEl = null;

  function removeFloatingWidget() {
    const existing = document.getElementById('edux-slayers-widget');
    if (existing) existing.remove();
    widgetEl = null;
  }

  function updateWidgetUI(msg, logType = 'info', forceRunning = null) {
    // Floating widget removed; status relayed directly via popup & logs
  }

  // Remove any previously injected widget element immediately
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', removeFloatingWidget);
  } else {
    removeFloatingWidget();
  }

  // =========================================================================
  // 7. Chrome Message Handlers & Init
  // =========================================================================

  chrome.storage.local.get(['delayMs', 'autoNext'], (res) => {
    if (res.delayMs) config.delayMs = res.delayMs;
    if (res.autoNext !== undefined) config.autoNext = res.autoNext;
  });

  chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
    if (req.action === 'START_SLIDE_BRUTEFORCE') {
      startSlideBruteforce(req.config);
      sendResponse({ success: true });
    } else if (req.action === 'STOP_SLIDE_BRUTEFORCE') {
      stopSlideBruteforce();
      sendResponse({ success: true });
    } else if (req.action === 'FILL_TEST_ANSWERS') {
      fillTestAnswers(req.answersText)
        .then((res) => sendResponse(res))
        .catch((err) => sendResponse({ success: false, message: String(err) }));
      return true; // Keep channel open for async response
    } else if (req.action === 'EXTRACT_QUESTIONS') {
      const res = extractQuestions();
      sendResponse(res);
    } else if (req.action === 'GET_STATUS') {
      sendResponse({ isSlideRunning, solvedCount, retryCount });
    } else if (req.action === 'UPDATE_SETTINGS') {
      config = { ...config, ...req.settings };
      sendResponse({ success: true });
    }
    return true;
  });
})();
