/**
 * EDUX Slayers Content Script v1.3.1
 * DOM Automation for EDUX (Popup-controlled).
 * Matches Python implementation exactly (quizz_bruteforce.py & test_solver.py).
 */

(function () {
  if (window.__EDUX_SLAYERS_INJECTED__) return;
  window.__EDUX_SLAYERS_INJECTED__ = true;

  console.log('⚔️ EDUX Slayers Extension v1.3.1 loaded.');

  // Global State
  let isSlideRunning = false;
  let slideLoopTimer = null;
  let solvedCount = 0;
  let retryCount = 0;
  let wrongAnswersMap = {}; // { questionKey: Set of tried indexes }

  let config = {
    delayMs: 400,
    autoNext: true
  };

  // --- Helper Utilities ---
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
  }

  /**
   * Safely click an element with full Pointer/Mouse event dispatching.
   * Required for React/Vue synthetic event handlers.
   */
  function safeClickElement(el) {
    if (!el) return false;
    try {
      if (typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
      
      const mouseOpts = { bubbles: true, cancelable: true, view: window };
      el.dispatchEvent(new PointerEvent('pointerdown', mouseOpts));
      el.dispatchEvent(new MouseEvent('mousedown', mouseOpts));
      el.dispatchEvent(new PointerEvent('pointerup', mouseOpts));
      el.dispatchEvent(new MouseEvent('mouseup', mouseOpts));
      
      if (typeof el.click === 'function') {
        el.click();
      } else {
        el.dispatchEvent(new MouseEvent('click', mouseOpts));
      }
      return true;
    } catch (e) {
      console.error('[EDUX Slayers] Click error:', e);
      return false;
    }
  }

  /**
   * Safe visibility check — handles position:fixed, position:sticky, <body>,
   * and elements whose offsetParent is null for non-hidden reasons.
   * Mirrors Playwright's is_visible() logic used by the Python version.
   */
  function safeIsVisible(el) {
    if (!el) return false;
    try {
      // Check basic display/visibility via computed styles
      const style = window.getComputedStyle(el);
      if (style.display === 'none') return false;
      if (style.visibility === 'hidden') return false;
      if (parseFloat(style.opacity) === 0) return false;

      // Check that the element has some dimensions
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return false;

      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Find a visible, enabled <button> by matching its text content.
   * Mirrors Playwright's get_by_role("button", name=...) used by Python.
   * The Python version uses Playwright locators that match by accessible name,
   * which for <button> elements is their textContent.
   */
  function findButtonByText(texts) {
    const buttons = Array.from(document.querySelectorAll('button'));

    for (const target of texts) {
      const found = buttons.find((btn) => {
        if (btn.disabled) return false;
        if (!safeIsVisible(btn)) return false;
        const text = (btn.textContent || '').trim();
        // Exact match or contains with reasonable length tolerance
        return text === target || (text.includes(target) && text.length <= target.length + 15);
      });
      if (found) return found;
    }
    return null;
  }

  /**
   * Locate slide answer elements.
   * 
   * Python uses this Playwright CSS locator:
   *   "div.flex.items-center.space-x-6.p-8.rounded-xl.border-2.transition-colors.cursor-pointer.min-h-\\[80px\\]"
   * 
   * Playwright's CSS selector treats dots as class separators, so the above
   * matches a <div> with ALL of those classes.
   *
   * In browser querySelectorAll the equivalent is the same string, but we
   * need to CSS-escape the brackets in "min-h-[80px]".
   * 
   * We try the exact selector first, then progressively relax.
   */
  function getSlideAnswerElements() {
    // Strategy 1: Exact selector matching the Python Playwright locator.
    // The Tailwind class is literally "min-h-[80px]" in the HTML.
    // In CSS selectors, [ and ] must be escaped with backslash.
    // In a JS string, a single backslash is written as \\.
    let options = Array.from(
      document.querySelectorAll(
        'div.flex.items-center.space-x-6.p-8.rounded-xl.border-2.transition-colors.cursor-pointer.min-h-\\[80px\\]'
      )
    ).filter(safeIsVisible);

    // Strategy 2: Relaxed — any div with border-2 + cursor-pointer + min-h-[80px]
    if (options.length === 0) {
      options = Array.from(
        document.querySelectorAll(
          'div.border-2.cursor-pointer.min-h-\\[80px\\]'
        )
      ).filter(safeIsVisible);
    }

    // Strategy 3: Even more relaxed — div with border-2, cursor-pointer, and
    // some indication it's an answer card (has content, not a button)
    if (options.length === 0) {
      options = Array.from(
        document.querySelectorAll('div.border-2.cursor-pointer')
      ).filter((el) => {
        if (!safeIsVisible(el)) return false;
        const text = (el.textContent || '').trim();
        if (text.length === 0 || text.length > 600) return false;
        // Exclude known non-answer buttons
        const btnTexts = ['Không có câu hỏi', 'Trả lời trên lớp', 'Kiểm tra', 'Câu tiếp theo', 'Thử lại', 'Trang sau'];
        if (btnTexts.includes(text)) return false;
        return true;
      });
    }

    // Strategy 4: Broadest fallback — any clickable div that looks like an answer
    if (options.length === 0) {
      let candidates = Array.from(
        document.querySelectorAll('div.cursor-pointer, label.cursor-pointer')
      ).filter((el) => {
        if (!safeIsVisible(el)) return false;
        const text = (el.textContent || '').trim();
        if (text.length === 0 || text.length > 600) return false;
        const btnTexts = ['Không có câu hỏi', 'Trả lời trên lớp', 'Kiểm tra', 'Câu tiếp theo', 'Thử lại', 'Trang sau'];
        if (btnTexts.includes(text)) return false;
        return true;
      });

      // Remove nested duplicates (keep only leaf-most)
      candidates = candidates.filter((el) => !candidates.some((other) => other !== el && el.contains(other)));
      options = candidates;
    }

    return options;
  }

  /**
   * Fingerprint answer options when question text is missing.
   * Matches Python answers_fingerprint(): joins all answer texts with " | ",
   * truncated to 200 chars.
   */
  function answersFingerprint(answerEls) {
    if (!answerEls || answerEls.length === 0) return '';
    try {
      const texts = Array.from(answerEls)
        .map((el) => (el.textContent || '').trim())
        .filter(Boolean);
      return texts.join(' | ').substring(0, 200);
    } catch (e) {
      return '';
    }
  }

  /**
   * Build a question key for the wrong-answers memory map.
   * Matches Python logic: prefer question heading text, fallback to answer fingerprint.
   */
  function getSlideQuestionKey(answerEls) {
    // Try to find the question text element (Python: p.my-3.text-gray-800.leading-relaxed)
    const questionEl = document.querySelector('p.my-3.text-gray-800.leading-relaxed');
    if (questionEl && safeIsVisible(questionEl)) {
      const text = (questionEl.textContent || '').trim();
      if (text) return text;
    }
    // Fallback: answer fingerprint
    return answersFingerprint(answerEls) || '?';
  }

  // --- Slide Brute-force Engine (matches quizz_bruteforce.py exactly) ---
  let lastProgress = Date.now();
  let stallReported = false;
  const STALL_MS = 8000;

  async function runSlideBruteforceStep() {
    if (!isSlideRunning) return;

    try {
      // --- Step 1: "Không có câu hỏi" visible → click "Trang sau" ---
      // Python line 184: if safe_is_visible(no_question_button): safe_click(next_page_button)
      const noQuestionBtn = findButtonByText(['Không có câu hỏi']);
      if (noQuestionBtn) {
        const nextPageBtn = findButtonByText(['Trang sau']);
        if (nextPageBtn) {
          safeClickElement(nextPageBtn);
          logMessage('[INFO] Next Page (No Question)', 'info');
          await waitForHidden(noQuestionBtn, 1000);
        }
        lastProgress = Date.now();
        stallReported = false;
        return scheduleNextStep(config.delayMs);
      }

      // --- Step 2: Are answer options visible? ---
      // Python line 194: answers_visible = safe_is_visible(answers_locator.first)
      const answerList = getSlideAnswerElements();
      const answersVisible = answerList.length > 0;

      if (!answersVisible) {
        // Python line 198: if safe_is_visible(answer_button): safe_click(answer_button)
        const answerBtn = findButtonByText(['Trả lời trên lớp']);
        if (answerBtn) {
          safeClickElement(answerBtn);
          lastProgress = Date.now();
          stallReported = false;
          return scheduleNextStep(500);
        }

        // Stall watchdog (Python line 203)
        if (!stallReported && Date.now() - lastProgress > STALL_MS) {
          const visibleBtns = [];
          for (const name of ['Không có câu hỏi', 'Trả lời trên lớp', 'Kiểm tra', 'Câu tiếp theo', 'Thử lại', 'Trang sau']) {
            if (findButtonByText([name])) visibleBtns.push(name);
          }
          logMessage(`[STALL] Đang chờ (chưa thấy đáp án). Nút đang hiện: ${visibleBtns.join(', ') || 'không có'} | URL: ${window.location.href}`, 'warn');
          stallReported = true;
        }
        return scheduleNextStep(400);
      }

      // --- Answers are visible: reset watchdog ---
      // Python line 210
      lastProgress = Date.now();
      stallReported = false;

      const answerCount = answerList.length;
      if (answerCount === 0) return scheduleNextStep(400);

      // --- Build question key ---
      // Python lines 218-225
      const questionText = getSlideQuestionKey(answerList);
      logMessage(`[Q] ${questionText.substring(0, 60)}...`, 'info');

      if (!wrongAnswersMap[questionText]) {
        wrongAnswersMap[questionText] = new Set();
      }
      const triedIndices = wrongAnswersMap[questionText];

      // Reset if we tried all (Python line 230-231)
      if (triedIndices.size >= answerCount) {
        triedIndices.clear();
      }

      // Find next untried index (Python line 233)
      let nextIndex = 0;
      for (let i = 0; i < answerCount; i++) {
        if (!triedIndices.has(i)) {
          nextIndex = i;
          break;
        }
      }

      logMessage(`[Pick] #${nextIndex + 1}/${answerCount}`, 'info');

      // Click option (Python line 236)
      if (!safeClickElement(answerList[nextIndex])) {
        return scheduleNextStep(250);
      }

      // Click "Kiểm tra" (Python line 238)
      const checkBtn = findButtonByText(['Kiểm tra']);
      if (!checkBtn || !safeClickElement(checkBtn)) {
        return scheduleNextStep(250);
      }

      // --- Wait for follow-up button ---
      // Python lines 242-276: wait_for_function checks for 'Trang sau', 'Câu tiếp theo', 'Thử lại'
      // with a 10s timeout, then acts on whichever appeared.
      const startTime = Date.now();
      let followUpHandled = false;

      while (Date.now() - startTime < 10000 && isSlideRunning) {
        // Check each follow-up button — same priority order as Python (lines 256-271)
        const curNextPage = findButtonByText(['Trang sau']);
        const curNextQ = findButtonByText(['Câu tiếp theo']);
        const curRetry = findButtonByText(['Thử lại']);

        if (curNextPage) {
          solvedCount++;
          logMessage('[Done] Next Page', 'success');
          chrome.storage.local.set({ slideStats: { solved: solvedCount, retries: retryCount } });
          safeClickElement(curNextPage);
          await waitForHidden(curNextPage, 1000);
          followUpHandled = true;
          break;
        } else if (curNextQ) {
          solvedCount++;
          logMessage('[Done] Next Question', 'success');
          chrome.storage.local.set({ slideStats: { solved: solvedCount, retries: retryCount } });
          safeClickElement(curNextQ);
          await waitForHidden(curNextQ, 1000);
          followUpHandled = true;
          break;
        } else if (curRetry) {
          retryCount++;
          // Python line 267: wrong_answers.setdefault(question_text, set()).add(next_index)
          wrongAnswersMap[questionText] = wrongAnswersMap[questionText] || new Set();
          wrongAnswersMap[questionText].add(nextIndex);
          logMessage(`[Wrong] Index ${nextIndex + 1} marked`, 'warn');
          chrome.storage.local.set({ slideStats: { solved: solvedCount, retries: retryCount } });
          safeClickElement(curRetry);
          await waitForHidden(curRetry, 1000);
          followUpHandled = true;
          break;
        }

        await sleep(250);
      }

      if (!followUpHandled) {
        logMessage('[WARN] Chưa thấy nút tiếp theo (có thể do lag), thử lại...', 'warn');
      }

      scheduleNextStep(config.delayMs);
    } catch (err) {
      console.error('[EDUX Slayers] Loop Error:', err);
      logMessage(`[WARN] Lỗi tạm thời, tự hồi phục: ${String(err).substring(0, 80)}`, 'warn');
      scheduleNextStep(1000);
    }
  }

  /**
   * Wait until an element becomes hidden or timeout.
   * Mirrors Python: button.wait_for(state="hidden", timeout=1000)
   */
  async function waitForHidden(el, timeoutMs = 1000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (!safeIsVisible(el)) break;
      await sleep(100);
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
    solvedCount = 0;
    retryCount = 0;
    logMessage('▶️ Bắt đầu tự động giải Slide!', 'success');
    notifyPopup('SLIDE_STATUS_CHANGE', { isRunning: true });
    runSlideBruteforceStep();
  }

  function stopSlideBruteforce() {
    isSlideRunning = false;
    if (slideLoopTimer) clearTimeout(slideLoopTimer);
    slideLoopTimer = null;
    logMessage('⏹️ Đã dừng tự động giải Slide.', 'warn');
    notifyPopup('SLIDE_STATUS_CHANGE', { isRunning: false });
  }

  // =========================================================================
  // --- Test Solver Engine (matches test_solver.py) ---
  // =========================================================================

  const TF_TOKEN_RE = /(\d+)\s*\.\s*(đúng|sai|true|false|d|đ|s|t|f|1|0)/gi;

  function normalizeText(text) {
    return (text || '').toLowerCase().trim().replace(/\s+/g, ' ');
  }

  function parseQuestionIndex(text) {
    const match = (text || '').trim().match(/^Câu\s+(\d+)/);
    return match ? parseInt(match[1]) : null;
  }

  /**
   * Parse true/false answer value into array of booleans.
   * Matches Python parse_true_false_answers().
   */
  function parseTrueFalseAnswers(answerValue, expectedCount) {
    const normalized = normalizeText(answerValue);
    const result = [];

    // Try structured "1. Đúng 2. Sai" pattern first
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

    // Fallback: scan for individual tokens
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

  /**
   * Normalize an answers payload (array of objects or dict).
   * Matches Python normalize_answers_payload().
   */
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

  /**
   * Parse raw answer text into {questionNumber: answerValue} map.
   * Port of Python load_answers_from_jsonl_line().
   */
  function loadAnswersFromInput(rawText) {
    let line = (rawText || '').trim();
    // Strip BOM
    if (line.charCodeAt(0) === 0xfeff) {
      line = line.substring(1).trim();
    }

    // Try parsing directly as JSON array or object
    if (line.startsWith('[') || line.startsWith('{')) {
      try {
        let data = JSON.parse(line);
        if (typeof data === 'object' && data !== null && !Array.isArray(data) && 'answers' in data) {
          data = data.answers;
        }
        const parsed = normalizeAnswersPayload(data);
        if (Object.keys(parsed).length > 0) return parsed;
      } catch (e) { /* not valid JSON, try next */ }
    }

    // Try to split concatenated JSON objects: }{ -> }\n{
    // Python: re.sub(r"}\s*{", "}\n{", line)
    const normalizedJson = line.replace(/}\s*{/g, '}\n{');
    const jsonItems = [];
    for (const chunk of normalizedJson.split('\n')) {
      const trimmed = chunk.trim();
      if (!trimmed) continue;
      try {
        jsonItems.push(JSON.parse(trimmed));
      } catch (e) { /* skip invalid chunks */ }
    }
    if (jsonItems.length > 0) {
      const parsed = normalizeAnswersPayload(jsonItems);
      if (Object.keys(parsed).length > 0) return parsed;
    }

    // Fallback: parse plain text lines like "1. A", "2. C"
    // Python: ANSWER_LINE_RE = re.compile(r"^(\d+)\.(.*)$")
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
   * Extract multiple-choice options from locator elements.
   * Matches Python extract_options() which uses evaluate_all to get letter + text.
   */
  function extractOptionsFromEls(optionEls) {
    return optionEls.map((node) => ({
      node,
      letter: (node.querySelector('span.flex-shrink-0') || {}).textContent?.trim() || '',
      text: (node.querySelector('div.prose p') || {}).textContent?.trim() || ''
    }));
  }

  /**
   * Fill answers into test questions.
   * Supports dialog mode (step-by-step, matching test_solver.py) and full page mode.
   */
  async function fillTestAnswers(rawText) {
    const answers = loadAnswersFromInput(rawText);
    const questionIndices = Object.keys(answers);
    if (questionIndices.length === 0) {
      return { success: false, message: 'Không phân tích được danh sách đáp án nào!' };
    }

    logMessage(`Bắt đầu điền ${questionIndices.length} đáp án cho bài kiểm tra...`, 'info', true);

    const dialog = document.querySelector("div[role='dialog'][data-slot='dialog-content']");

    if (dialog && safeIsVisible(dialog)) {
      // ===== Dialog mode (step-by-step, matches test_solver.py main loop) =====
      return await fillTestDialog(dialog, answers);
    } else {
      // ===== Full page mode (all questions visible at once) =====
      return fillTestFullPage(answers);
    }
  }

  /**
   * Dialog mode test filling — matches the while loop in test_solver.py test_bruteforce().
   */
  async function fillTestDialog(dialog, answers) {
    let filledCount = 0;
    const maxIterations = Object.keys(answers).length + 5; // Safety limit
    let iterations = 0;

    while (iterations < maxIterations) {
      iterations++;

      // Wait for question label "Câu X" inside dialog
      // Python: page.wait_for_function(...find span starting with "Câu "...)
      let labelEl = null;
      for (let wait = 0; wait < 10; wait++) {
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
        // Determine question type and fill — same order as Python:
        // 1. true_false_blocks, 2. textarea, 3. input, 4. multiple choice options

        const trueFalseBlocks = Array.from(
          dialog.querySelectorAll('div.border.border-gray-200.rounded-lg.p-3.bg-gray-50')
        ).filter(safeIsVisible);

        const textareaEl = dialog.querySelector('textarea');
        const inputEl = dialog.querySelector("input[type='text']");

        // Python: dialog.locator("div.relative.flex.items-center.space-x-2.p-2.border.rounded-lg.cursor-pointer")
        const optionEls = Array.from(
          dialog.querySelectorAll('div.relative.flex.items-center.space-x-2.p-2.border.rounded-lg.cursor-pointer')
        ).filter(safeIsVisible);

        if (trueFalseBlocks.length > 0) {
          // Python lines 524-536: fill true/false
          const tfAnswers = parseTrueFalseAnswers(answerValue, trueFalseBlocks.length);
          if (tfAnswers.length < trueFalseBlocks.length) {
            logMessage(`[WARN] Not enough true/false answers to fill.`, 'warn', true);
          } else {
            logMessage(`[INFO] Câu ${questionIndex}: filling true/false`, 'info', true);
            for (let i = 0; i < trueFalseBlocks.length; i++) {
              const block = trueFalseBlocks[i];
              const targetName = tfAnswers[i] ? 'Đúng' : 'Sai';
              const btn = Array.from(block.querySelectorAll('button')).find(
                (b) => (b.textContent || '').trim() === targetName
              );
              if (btn) safeClickElement(btn);
            }
          }
          filledCount++;
        } else if (textareaEl && safeIsVisible(textareaEl)) {
          // Python line 538-539
          logMessage(`[INFO] Câu ${questionIndex}: filling textarea`, 'info', true);
          setNativeValue(textareaEl, answerValue);
          filledCount++;
        } else if (inputEl && safeIsVisible(inputEl)) {
          // Python line 540-542
          logMessage(`[INFO] Câu ${questionIndex}: filling input`, 'info', true);
          setNativeValue(inputEl, answerValue);
          filledCount++;
        } else {
          // Multiple choice — Python lines 544-572
          // Wait for options to appear
          let currentOptionEls = optionEls;
          if (currentOptionEls.length === 0) {
            for (let wait = 0; wait < 10; wait++) {
              await sleep(200);
              currentOptionEls = Array.from(
                dialog.querySelectorAll('div.relative.flex.items-center.space-x-2.p-2.border.rounded-lg.cursor-pointer')
              ).filter(safeIsVisible);
              if (currentOptionEls.length > 0) break;
            }
          }

          if (currentOptionEls.length === 0) {
            logMessage(`[WARN] Câu ${questionIndex}: không thấy lựa chọn.`, 'warn', true);
          } else {
            logMessage(`[INFO] Câu ${questionIndex}: selecting ${answerValue}`, 'info', true);
            const options = extractOptionsFromEls(currentOptionEls);
            let chosenIndex = -1;

            // Python line 555-560: single letter A/B/C/D → match by letter prefix
            if (answerValue.length === 1 && 'ABCD'.includes(answerValue.toUpperCase())) {
              const targetLetter = answerValue.toUpperCase() + '.';
              chosenIndex = options.findIndex((opt) => opt.letter.startsWith(targetLetter));
            } else {
              // Python line 562-567: match by normalized text substring
              const target = normalizeText(answerValue);
              if (target) {
                chosenIndex = options.findIndex((opt) => {
                  const optionText = normalizeText(opt.text);
                  return target && optionText.includes(target);
                });
              }
            }

            if (chosenIndex === -1) {
              logMessage(`[WARN] No matching option found.`, 'warn', true);
            } else {
              safeClickElement(options[chosenIndex].node);
              filledCount++;
            }
          }
        }
      }

      // Navigation: submit or next question (Python lines 574-622)
      const submitBtn = findButtonByText(['Nộp bài']);
      if (submitBtn) {
        const nextBtn = findButtonByText(['Câu tiếp']);
        if (!nextBtn) {
          // Last question — don't auto-submit, let user confirm
          logMessage("[INFO] Đã đến câu cuối. Nhấn 'Nộp bài' để hoàn thành.", 'success', true);
          break;
        }
      }

      const nextBtn = findButtonByText(['Câu tiếp']);
      if (nextBtn) {
        const currentLabel = labelText;
        // Get current progress text for change detection (Python lines 581-588)
        const progressEl = dialog.querySelector('span.text-gray-700');
        const currentProgress = progressEl ? progressEl.textContent.trim() : '';

        safeClickElement(nextBtn);

        // Wait for the question to actually change (Python lines 599-620)
        let changed = false;
        for (let i = 0; i < 50; i++) {
          await sleep(200);
          const newLabelEl = findQuestionLabel(dialog);
          if (newLabelEl) {
            const newLabel = newLabelEl.textContent.trim();
            if (newLabel !== currentLabel) {
              changed = true;
              break;
            }
          }
          const newProgressEl = dialog.querySelector('span.text-gray-700');
          const newProgress = newProgressEl ? newProgressEl.textContent.trim() : '';
          if (newProgress && newProgress !== currentProgress) {
            changed = true;
            break;
          }
        }
        if (!changed) {
          logMessage('[WARN] Next question did not appear yet.', 'warn', true);
          break;
        }
      } else {
        // No next button visible — we're done or stuck
        break;
      }
    }

    logMessage(`🎉 Đã điền xong ${filledCount} câu trong bài kiểm tra.`, 'success', true);
    return { success: true, filledCount };
  }

  /**
   * Full page mode test filling — all questions visible on page at once.
   */
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

      // 1. True/False
      const tfBlocks = Array.from(
        container.querySelectorAll('div.border.border-gray-200.rounded-lg.p-3.bg-gray-50')
      ).filter(safeIsVisible);

      if (tfBlocks.length > 0) {
        const tfAnswers = parseTrueFalseAnswers(targetAns, tfBlocks.length);
        tfBlocks.forEach((block, i) => {
          const shouldBeTrue = i < tfAnswers.length ? tfAnswers[i] : true;
          const btn = Array.from(block.querySelectorAll('button')).find(
            (b) => (b.textContent || '').trim() === (shouldBeTrue ? 'Đúng' : 'Sai')
          );
          if (btn) safeClickElement(btn);
        });
        filledCount++;
        logMessage(`✓ Câu ${qNum}: đã chọn Đúng/Sai`, 'success', true);
        return;
      }

      // 2. Textarea
      const textarea = container.querySelector('textarea');
      if (textarea && safeIsVisible(textarea)) {
        setNativeValue(textarea, targetAns);
        filledCount++;
        logMessage(`✓ Câu ${qNum}: đã điền tự luận`, 'success', true);
        return;
      }

      // 3. Input
      const input = container.querySelector("input[type='text']");
      if (input && safeIsVisible(input)) {
        setNativeValue(input, targetAns);
        filledCount++;
        logMessage(`✓ Câu ${qNum}: đã điền ô trống`, 'success', true);
        return;
      }

      // 4. Multiple choice
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
          safeClickElement(opt);
          filledCount++;
          logMessage(`✓ Câu ${qNum}: đã chọn ${targetAns}`, 'success', true);
          break;
        }
      }
    });

    logMessage(`🎉 Đã tự động điền xong ${filledCount} câu hỏi.`, 'success', true);
    return { success: true, filledCount };
  }

  /**
   * Find the question label element ("Câu X") inside a container.
   */
  function findQuestionLabel(container) {
    return Array.from(container.querySelectorAll('span')).find((el) => {
      return safeIsVisible(el) && /^Câu\s+\d+/.test((el.textContent || '').trim());
    }) || null;
  }

  /**
   * Set value on an input/textarea using native setter + React-compatible events.
   * React ignores direct .value= assignment because it doesn't go through
   * React's synthetic event system. We use the native setter to bypass this.
   */
  function setNativeValue(el, value) {
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    )?.set;
    const nativeTextareaValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value'
    )?.set;

    const setter = el.tagName === 'TEXTAREA' ? nativeTextareaValueSetter : nativeInputValueSetter;
    if (setter) {
      setter.call(el, value);
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /**
   * Extract questions and build prompt payload.
   * Matches test_solver.py build_compact_prompt_payload().
   */
  function extractQuestions() {
    const compact = {
      title: document.title || 'EDUX Exam',
      total_questions: 0,
      multiple_choice: [],
      fill_in_blank: [],
      essay: [],
      true_false: []
    };

    const searchRoot = document.querySelector("div[role='dialog'][data-slot='dialog-content']") || document;

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
        container.querySelectorAll('div.border.border-gray-200.rounded-lg.p-3.bg-gray-50')
      ).filter(safeIsVisible);

      const textarea = container.querySelector('textarea');
      const input = container.querySelector("input[type='text']");
      const optionEls = Array.from(
        container.querySelectorAll('div.relative.flex.items-center.space-x-2.p-2.border.rounded-lg.cursor-pointer')
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
          const text = (opt.querySelector('div.prose p') || opt).textContent?.trim() || '';
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

    // Build the same prompt as Python test_solver.py
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
  // --- Init & Message Handling ---
  // =========================================================================

  // Load configuration from storage
  chrome.storage.local.get(['delayMs', 'autoNext'], (res) => {
    if (res.delayMs) config.delayMs = res.delayMs;
    if (res.autoNext !== undefined) config.autoNext = res.autoNext;
  });

  // Message listener from Popup & Background
  chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
    if (req.action === 'START_SLIDE_BRUTEFORCE') {
      startSlideBruteforce(req.config);
      sendResponse({ success: true });
    } else if (req.action === 'STOP_SLIDE_BRUTEFORCE') {
      stopSlideBruteforce();
      sendResponse({ success: true });
    } else if (req.action === 'FILL_TEST_ANSWERS') {
      // Async handler — must return true to keep sendResponse channel open
      fillTestAnswers(req.answersText).then((res) => sendResponse(res)).catch((err) => {
        console.error('[EDUX Slayers] fillTestAnswers error:', err);
        sendResponse({ success: false, message: String(err) });
      });
      return true;
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
