/**
 * EDUX Slayers - Test Solver Engine v2.2.0 (Mô phỏng chính xác EDUX-TEST-SOLVER)
 * Tự động trích xuất đề bài tập, chuẩn hóa prompt AI, parse đáp án đa định dạng
 * và tự động điền bài tập từng bước trên giao diện EDUX theo chuẩn Playwright.
 */

(function () {
  'use strict';

  const { sleep, safeIsVisible, safeIsEnabled, safeClick, getActiveDialog } = window.EduxDOM;

  let currentCapturedExamData = null;

  function setCapturedExamData(data) {
    if (data && typeof data === 'object') {
      currentCapturedExamData = data;
      logMessage('📡 Đã ghi nhận dữ liệu đề bài tập từ hệ thống EDUX.', 'info');
    }
  }

  function getCapturedExamData() {
    return currentCapturedExamData;
  }

  function logMessage(msg, logType = 'info') {
    console.log('[EDUX Slayers Bài Tập] ' + msg);
    try {
      chrome.runtime.sendMessage({
        type: 'TEST_LOG',
        message: msg,
        logType
      });
    } catch (e) {}
  }

  const QUESTION_LABEL_RE = /^Câu\s+(\d+)/i;
  const TF_TOKEN_RE = /(\d+)\s*\.\s*(đúng|sai|true|false|d|đ|s|t|f|1|0)/gi;

  function normalizeText(text) {
    return (text || '')
      .replace(/\u00a0/g, ' ')
      .toLowerCase()
      .trim()
      .replace(/\s+/g, ' ');
  }

  function parseQuestionIndex(text) {
    const match = (text || '').trim().match(QUESTION_LABEL_RE);
    return match ? parseInt(match[1], 10) : null;
  }

  /**
   * Mô phỏng sanitize_ai_response() từ EDUX-TEST-SOLVER
   * Xóa markdown code block ```json ... ```
   */
  function sanitizeAiResponse(raw) {
    let text = (raw || '').trim();
    if (text.startsWith('```')) {
      const match = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
      if (match) {
        return match[1].trim();
      }
    }
    return text;
  }

  /**
   * Mô phỏng parse_true_false_answers() từ EDUX-TEST-SOLVER
   */
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

  /**
   * Mô phỏng normalize_answers_payload() từ EDUX-TEST-SOLVER
   */
  function normalizeAnswersPayload(data) {
    const answers = {};
    if (Array.isArray(data)) {
      data.forEach((item) => {
        if (typeof item !== 'object' || item === null) return;
        const idx = item.so_cau ?? item.soCau ?? item.question ?? item.id;
        const ans = item.dap_an ?? item.dapAn ?? item.answer;
        if (idx == null || ans == null) return;
        const idxInt = parseInt(idx, 10);
        if (isNaN(idxInt)) return;
        if (Array.isArray(ans)) {
          answers[idxInt] = ans.map((x) => String(x)).join(', ');
        } else {
          answers[idxInt] = String(ans).trim();
        }
      });
    } else if (typeof data === 'object' && data !== null) {
      Object.entries(data).forEach(([key, value]) => {
        const idxInt = parseInt(key, 10);
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
   * Mô phỏng load_answers_from_jsonl_line() từ EDUX-TEST-SOLVER
   * Hỗ trợ JSONL 1 dòng, JSON Array, JSON Object, concatenated JSON, và văn bản dòng (1. A, 2. B)
   */
  function loadAnswersFromInput(rawText) {
    let clean = sanitizeAiResponse(rawText);
    if (clean.charCodeAt(0) === 0xfeff) {
      clean = clean.substring(1).trim();
    }

    // 1. Thử parse JSON Array hoặc Object trực tiếp
    if (clean.startsWith('[') || clean.startsWith('{')) {
      try {
        let data = JSON.parse(clean);
        if (typeof data === 'object' && data !== null && !Array.isArray(data) && 'answers' in data) {
          data = data.answers;
        }
        const parsed = normalizeAnswersPayload(data);
        if (Object.keys(parsed).length > 0) return parsed;
      } catch (e) {}
    }

    // 2. Thử tách concatenated JSON objects: }{ -> }\n{ (giống hệt test_solver.py)
    const normalizedJson = clean.replace(/}\s*{/g, '}\n{');
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

    // 3. Fallback: Parse từng dòng dạng "1. A", "2: B", "3) Đúng, Sai"
    const answers = {};
    const lines = clean.split('\n');
    lines.forEach((l) => {
      const match = l.trim().match(/^(\d+)\s*[\.:\-\)]\s*(.+)$/);
      if (match) {
        answers[parseInt(match[1], 10)] = match[2].trim();
      }
    });

    return answers;
  }

  /**
   * Cập nhật giá trị input/textarea cho React synthetic events
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

  /**
   * Trích xuất danh sách lựa chọn trong câu hỏi trắc nghiệm
   * Mô phỏng extract_options() từ EDUX-TEST-SOLVER
   */
  function extractOptionsFromEls(optionEls) {
    return optionEls.map((node) => ({
      node,
      letter: (node.querySelector('span.flex-shrink-0')?.textContent || '').trim(),
      text: (node.querySelector('div.prose p, p')?.textContent || node.textContent || '').trim()
    }));
  }

  /**
   * Tìm nút "Làm bài tập" hoặc "Bài tập AI" thông minh & toàn diện
   */
  function findStartButton() {
    // Thu thập tất cả các phần tử có khả năng bấm được
    const allElements = Array.from(document.querySelectorAll('button, [role="button"], a, div, span'));

    // Ưu tiên 1: Tìm chính xác nút "Làm bài tập" (màn hình bắt đầu dạng screen_to_start.png)
    const startMatches = allElements.filter((el) => {
      if (!safeIsVisible(el)) return false;
      if (el.children.length > 5) return false;
      const text = normalizeText(el.textContent);
      return text.includes('làm bài tập');
    });

    if (startMatches.length > 0) {
      const best =
        startMatches.find((el) => {
          return (
            el.tagName === 'BUTTON' ||
            el.getAttribute('role') === 'button' ||
            el.tagName === 'A' ||
            el.classList.contains('cursor-pointer') ||
            (window.getComputedStyle(el) && window.getComputedStyle(el).cursor === 'pointer')
          );
        }) || startMatches[0];

      const clickable =
        best.closest('button, [role="button"], a, div[class*="cursor-pointer"], div[class*="btn"], div[class*="bg-"]') ||
        best;
      return { element: clickable, type: 'start_quiz' };
    }

    // Ưu tiên 2: Tìm nút "Bài tập AI" của các bài học trên trang môn học (/subject?id=...)
    const lessonMatches = allElements.filter((el) => {
      if (!safeIsVisible(el)) return false;
      if (el.children.length > 5) return false;
      const text = normalizeText(el.textContent);
      return text.includes('bài tập ai');
    });

    if (lessonMatches.length > 0) {
      // Ưu tiên bài chưa làm (có badge cảnh báo màu vàng/đỏ)
      const warningBadge = document.querySelector('.edux-exercise-badge-warning');
      if (warningBadge) {
        const row = warningBadge.parentElement;
        const btnInRow = Array.from(row ? row.querySelectorAll('button, a, div[class*="cursor-pointer"]') : []).find(
          (b) => normalizeText(b.textContent).includes('bài tập ai')
        );
        if (btnInRow && safeIsVisible(btnInRow)) {
          return { element: btnInRow, type: 'open_lesson_exercise' };
        }
      }

      const bestLesson =
        lessonMatches.find((el) => {
          return (
            el.tagName === 'BUTTON' ||
            el.getAttribute('role') === 'button' ||
            el.tagName === 'A' ||
            (window.getComputedStyle(el) && window.getComputedStyle(el).cursor === 'pointer')
          );
        }) || lessonMatches[0];

      const clickable = bestLesson.closest('button, [role="button"], a') || bestLesson;
      return { element: clickable, type: 'open_lesson_exercise' };
    }

    return null;
  }

  /**
   * Tìm nhãn "Câu X" trong dialog
   */
  function findQuestionLabel(container) {
    return (
      Array.from(container.querySelectorAll('span, div, p, h3, h4')).find((el) => {
        return safeIsVisible(el) && QUESTION_LABEL_RE.test((el.textContent || '').trim());
      }) || null
    );
  }

  /**
   * Tìm button theo tên/nhãn chữ
   */
  function findButtonByText(names, root = document, mustBeVisible = true) {
    const nameList = Array.isArray(names) ? names : [names];
    const buttons = Array.from(root.querySelectorAll('button, [role="button"], a, div, span'));

    for (const name of nameList) {
      const lowerTarget = normalizeText(name);
      const found = buttons.find((btn) => {
        if (mustBeVisible && !safeIsVisible(btn)) return false;
        const text = normalizeText(btn.textContent);
        return text === lowerTarget || text.includes(lowerTarget);
      });
      if (found) {
        return found.closest('button, [role="button"], a, div[class*="cursor-pointer"]') || found;
      }
    }
    return null;
  }

  /**
   * Mô phỏng build_compact_prompt_payload() từ EDUX-TEST-SOLVER
   */
  function buildCompactPromptPayload(payloadJson) {
    const data = (payloadJson && payloadJson.data) || (payloadJson || {});
    const examData = data.exam_data || (typeof data === 'object' && !data.multiple_choice ? {} : data);

    const compact = {
      title: data.title || document.title || 'Bài tập EDUX',
      total_questions: data.total_questions || 0,
      multiple_choice: [],
      fill_in_blank: [],
      essay: [],
      true_false: []
    };

    for (const item of examData.multiple_choice || (Array.isArray(data) ? data : []) || []) {
      if (item && (item.question || item.options)) {
        compact.multiple_choice.push({
          id: item.id || item.so_cau,
          question: item.question,
          options: item.options
        });
      }
    }

    for (const item of examData.fill_in_blank || []) {
      if (item && item.question) {
        compact.fill_in_blank.push({
          id: item.id || item.so_cau,
          question: item.question
        });
      }
    }

    for (const item of examData.essay || []) {
      if (item && item.question) {
        compact.essay.push({
          id: item.id || item.so_cau,
          question: item.question
        });
      }
    }

    for (const item of examData.true_false || []) {
      if (item && (item.question || item.statements)) {
        const statements = (item.statements || []).map((s) => (typeof s === 'string' ? s : s?.text || ''));
        compact.true_false.push({
          id: item.id || item.so_cau,
          question: item.question,
          statements
        });
      }
    }

    compact.total_questions =
      compact.multiple_choice.length +
      compact.fill_in_blank.length +
      compact.essay.length +
      compact.true_false.length;

    return compact;
  }

  /**
   * Tạo chuỗi prompt hoàn chỉnh chuẩn theo EDUX-TEST-SOLVER
   */
  function generateStandardPromptText(compactPayload) {
    const payloadText = JSON.stringify(compactPayload, null, 2);
    const promptLine =
      'trả về JSONL một dòng duy nhất (không xuống dòng); ' +
      'mỗi phần tử có so_cau và dap_an; ' +
      'dap_an là A/B/C/D hoặc từ/cụm từ/văn bản cần điền; ' +
      'với câu đúng/sai, dap_an là mảng giá trị Đúng/Sai theo thứ tự mệnh đề; ' +
      'không giải thích gì thêm';

    return payloadText.trim() + '\n\n' + promptLine + '\n';
  }

  /**
   * Trích xuất câu hỏi từ dữ liệu intercepted hoặc cào từ DOM
   */
  function extractQuestions(overrideData) {
    let sourceData = overrideData || currentCapturedExamData;

    // Nếu chưa có trong RAM, thử đọc từ sessionStorage (chia sẻ giữa MAIN world & content script)
    if (!sourceData) {
      try {
        const stored = sessionStorage.getItem('__EDUX_LAST_EXAM_DATA__');
        if (stored) {
          sourceData = JSON.parse(stored);
          currentCapturedExamData = sourceData;
        }
      } catch (e) {}
    }

    if (sourceData) {
      const compact = buildCompactPromptPayload(sourceData);
      if (compact.total_questions > 0) {
        const promptText = generateStandardPromptText(compact);
        logMessage(`✓ Đã trích xuất ${compact.total_questions} câu từ dữ liệu bài tập!`, 'success');
        return { questions: compact, promptText, fromApi: true };
      }
    }

    // Fallback: Quét trực tiếp từ DOM nếu dialog bài tập đang mở
    const searchRoot = getActiveDialog() || document;
    const questionLabels = Array.from(searchRoot.querySelectorAll('p, div, span, h3, h4')).filter((el) => {
      return safeIsVisible(el) && QUESTION_LABEL_RE.test((el.textContent || '').trim());
    });

    if (questionLabels.length > 0) {
      const compact = {
        title: document.title || 'Bài tập EDUX',
        total_questions: 0,
        multiple_choice: [],
        fill_in_blank: [],
        essay: [],
        true_false: []
      };

      questionLabels.forEach((labelEl) => {
        const qNum = parseQuestionIndex(labelEl.textContent);
        if (qNum === null) return;

        let container =
          labelEl.closest('div.border, div.rounded-xl, div.shadow, section, article') || labelEl.parentElement;
        if (!container) return;

        const questionText =
          (container.querySelector('div.prose p, p.text-gray-800') || {}).textContent?.trim() ||
          labelEl.textContent.trim();

        const tfBlocks = Array.from(
          container.querySelectorAll("div.border.border-gray-200.rounded-lg.p-3.bg-gray-50, div[class*='bg-gray-50']")
        ).filter(safeIsVisible);

        const textarea = container.querySelector('textarea');
        const input = container.querySelector("input[type='text']");
        const optionEls = Array.from(
          container.querySelectorAll(
            'div.relative.flex.items-center.space-x-2.p-2.border.rounded-lg.cursor-pointer, div.border.rounded-lg.cursor-pointer'
          )
        ).filter(safeIsVisible);

        if (tfBlocks.length > 0) {
          const statements = tfBlocks.map((b) => (b.querySelector('p, span') || b).textContent?.trim() || '');
          compact.true_false.push({ id: qNum, question: questionText, statements });
        } else if (textarea) {
          compact.essay.push({ id: qNum, question: questionText });
        } else if (input) {
          compact.fill_in_blank.push({ id: qNum, question: questionText });
        } else if (optionEls.length > 0) {
          const options = {};
          optionEls.forEach((opt, idx) => {
            const letter =
              (opt.querySelector('span.flex-shrink-0') || {}).textContent?.trim().replace(/\.$/, '') ||
              String.fromCharCode(65 + idx);
            const text = (opt.querySelector('div.prose p, p') || opt).textContent?.trim() || '';
            options[letter] = text;
          });
          compact.multiple_choice.push({ id: qNum, question: questionText, options });
        }
      });

      compact.total_questions =
        compact.multiple_choice.length +
        compact.fill_in_blank.length +
        compact.essay.length +
        compact.true_false.length;

      if (compact.total_questions > 0) {
        const promptText = generateStandardPromptText(compact);
        logMessage(`✓ Đã quét ${compact.total_questions} câu hỏi từ giao diện bài tập.`, 'info');
        return { questions: compact, promptText, fromApi: false };
      }
    }

    logMessage('⚠️ Chưa bắt được gói tin đề bài. Hãy bấm nút "🚀 Mở bài" hoặc F5 tải lại trang để bắt đề!', 'warn');
    return { questions: null, promptText: '', message: 'Chưa bắt được gói tin đề bài tập.' };
  }

  /**
   * Bấm nút "Làm bài tập" hoặc "Bài tập AI" trên trang web
   */
  async function startExercise() {
    // 1. Kiểm tra nếu dialog câu hỏi đã mở sẵn
    const existingDialog = getActiveDialog();
    if (existingDialog && safeIsVisible(existingDialog)) {
      const qLabel = findQuestionLabel(existingDialog);
      logMessage(
        `Cửa sổ bài tập đã được mở sẵn sàng${qLabel ? ' (' + qLabel.textContent.trim() + ')' : ''}.`,
        'success'
      );
      return { success: true, opened: true };
    }

    // 2. Tìm nút bấm phù hợp
    const match = findStartButton();
    if (!match) {
      logMessage(
        "⚠️ Không tìm thấy nút 'Làm bài tập' hoặc 'Bài tập AI' trên trang. Hãy mở bài học trước!",
        'warn'
      );
      return { success: false, message: "Không tìm thấy nút 'Làm bài tập' hoặc 'Bài tập AI' trên trang." };
    }

    if (match.type === 'start_quiz') {
      logMessage("Đã tìm thấy nút 'Làm bài tập'. Đang bấm...", 'info');
      safeClick(match.element);

      // Chờ dialog xuất hiện
      for (let i = 0; i < 30; i++) {
        await sleep(200);
        const dialog = getActiveDialog();
        if (dialog && safeIsVisible(dialog)) {
          logMessage('🎉 Cửa sổ làm bài tập đã mở thành công!', 'success');
          return { success: true, opened: true };
        }
      }
      return { success: true, opened: false, message: "Đã bấm 'Làm bài tập', đang chờ hệ thống tải câu hỏi..." };
    }

    if (match.type === 'open_lesson_exercise') {
      logMessage("Đã tìm thấy bài học. Bấm 'Bài tập AI' để mở...", 'info');
      safeClick(match.element);

      // Chờ màn hình có nút "Làm bài tập" xuất hiện (tối đa 4 giây)
      for (let i = 0; i < 20; i++) {
        await sleep(200);
        const nextMatch = findStartButton();
        if (nextMatch && nextMatch.type === 'start_quiz') {
          logMessage("Đã mở bài tập! Tiếp tục bấm nút 'Làm bài tập'...", 'info');
          safeClick(nextMatch.element);

          // Chờ dialog làm bài xuất hiện
          for (let j = 0; j < 30; j++) {
            await sleep(200);
            const dialog = getActiveDialog();
            if (dialog && safeIsVisible(dialog)) {
              logMessage('🎉 Cửa sổ làm bài tập đã mở thành công!', 'success');
              return { success: true, opened: true };
            }
          }
          return { success: true, opened: true };
        }
      }
      return { success: true, opened: false, message: "Đã mở màn hình bài tập. Hãy bấm 'Làm bài tập' trên trang." };
    }

    return { success: false, message: 'Không thể kích hoạt bài tập.' };
  }

  /**
   * Bắt đầu điền đáp án bài tập
   */
  async function fillTestAnswers(rawText, options = {}) {
    const answers = loadAnswersFromInput(rawText);
    const questionIndices = Object.keys(answers);
    if (questionIndices.length === 0) {
      return { success: false, message: 'Không thể phân tích bất kỳ đáp án hợp lệ nào từ nội dung đã nhập!' };
    }

    logMessage(`🚀 Bắt đầu điền ${questionIndices.length} câu trả lời cho bài tập...`, 'info');

    // Chờ hoặc lấy dialog bài tập
    let dialog = getActiveDialog();
    if (!dialog || !safeIsVisible(dialog)) {
      for (let wait = 0; wait < 10; wait++) {
        await sleep(200);
        dialog = getActiveDialog();
        if (dialog && safeIsVisible(dialog)) break;
      }
    }

    let result;
    if (dialog && safeIsVisible(dialog)) {
      result = await fillTestDialog(dialog, answers, options);
    } else {
      result = fillTestFullPage(answers);
    }

    return result;
  }

  /**
   * Vòng lặp điền bài tập từng bước mô phỏng chính xác test_solver.py lines 483-623
   */
  async function fillTestDialog(dialog, answers, options = {}) {
    let filledCount = 0;
    const autoSubmit = options.autoSubmit !== false;
    const maxIterations = Object.keys(answers).length + 15;
    let iterations = 0;

    while (iterations < maxIterations) {
      iterations++;

      // 1. Chờ label "Câu X" xuất hiện (tối đa 4 giây mỗi câu)
      let labelEl = null;
      for (let wait = 0; wait < 20; wait++) {
        labelEl = findQuestionLabel(dialog);
        if (labelEl) break;
        await sleep(200);
      }

      if (!labelEl) {
        logMessage('[WARN] Không tìm thấy nhãn câu hỏi. Dừng tiến trình.', 'warn');
        break;
      }

      const labelText = labelEl.textContent.trim();
      const questionIndex = parseQuestionIndex(labelText);
      if (questionIndex === null) {
        logMessage(`[WARN] Không parse được số câu từ: "${labelText}"`, 'warn');
        break;
      }

      const answerValue = (answers[questionIndex] || '').trim();

      if (!answerValue) {
        logMessage(`[WARN] Không có đáp án cho câu ${questionIndex}, bỏ qua.`, 'warn');
      } else {
        // Phân loại câu hỏi theo thứ tự ưu tiên của test_solver.py:
        // 1. True/False blocks: div.border.border-gray-200.rounded-lg.p-3.bg-gray-50
        const trueFalseBlocks = Array.from(
          dialog.querySelectorAll("div.border.border-gray-200.rounded-lg.p-3.bg-gray-50, div[class*='bg-gray-50']")
        ).filter(safeIsVisible);

        const textareaEl = dialog.querySelector('textarea');
        const inputEl = dialog.querySelector("input[type='text']");

        const optionEls = Array.from(
          dialog.querySelectorAll(
            "div.relative.flex.items-center.space-x-2.p-2.border.rounded-lg.cursor-pointer, div.border.rounded-lg.cursor-pointer"
          )
        ).filter(safeIsVisible);

        if (trueFalseBlocks.length > 0) {
          const tfAnswers = parseTrueFalseAnswers(answerValue, trueFalseBlocks.length);
          logMessage(`[INFO] Câu ${questionIndex}: điền Đúng/Sai`, 'info');
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
          logMessage(`[INFO] Câu ${questionIndex}: điền tự luận`, 'info');
          setNativeValue(textareaEl, answerValue);
          filledCount++;
        } else if (inputEl && safeIsVisible(inputEl)) {
          logMessage(`[INFO] Câu ${questionIndex}: điền ô trống`, 'info');
          setNativeValue(inputEl, answerValue);
          filledCount++;
        } else {
          // Trắc nghiệm nhiều lựa chọn
          let currentOptionEls = optionEls;
          if (currentOptionEls.length === 0) {
            for (let wait = 0; wait < 15; wait++) {
              await sleep(200);
              currentOptionEls = Array.from(
                dialog.querySelectorAll(
                  "div.relative.flex.items-center.space-x-2.p-2.border.rounded-lg.cursor-pointer, div.border.rounded-lg.cursor-pointer"
                )
              ).filter(safeIsVisible);
              if (currentOptionEls.length > 0) break;
            }
          }

          if (currentOptionEls.length === 0) {
            logMessage(`[WARN] Câu ${questionIndex}: không tìm thấy lựa chọn đáp án.`, 'warn');
          } else {
            logMessage(`[INFO] Câu ${questionIndex}: chọn '${answerValue}'`, 'info');
            const optionsList = extractOptionsFromEls(currentOptionEls);
            let chosenIndex = -1;

            if (answerValue.length === 1 && 'ABCD'.includes(answerValue.toUpperCase())) {
              const targetLetter = answerValue.toUpperCase() + '.';
              for (let i = 0; i < optionsList.length; i++) {
                const optL = optionsList[i].letter;
                if (optL === answerValue.toUpperCase() || optL.startsWith(targetLetter)) {
                  chosenIndex = i;
                  break;
                }
              }
            } else {
              const target = normalizeText(answerValue);
              if (target) {
                for (let i = 0; i < optionsList.length; i++) {
                  const optText = normalizeText(optionsList[i].text);
                  if (optText && optText.includes(target)) {
                    chosenIndex = i;
                    break;
                  }
                }
              }
            }

            if (chosenIndex === -1) {
              logMessage(`[WARN] Câu ${questionIndex}: Không khớp được lựa chọn.`, 'warn');
            } else {
              safeClick(optionsList[chosenIndex].node);
              filledCount++;
            }
          }
        }
      }

      await sleep(250);

      // Kiểm tra nút "Nộp bài" hoặc "Câu tiếp"
      const submitBtn = findButtonByText(['Nộp bài'], dialog, true);
      const nextBtn = findButtonByText(['Câu tiếp', 'Câu tiếp theo'], dialog, true);

      // Nếu thấy nút Nộp bài
      if (submitBtn && !nextBtn) {
        if (autoSubmit) {
          logMessage("🎉 Đã đến câu cuối. Tự động bấm nút 'Nộp bài'...", 'success');
          safeClick(submitBtn);
        } else {
          logMessage("✓ Đã hoàn thành điền câu cuối. Bạn có thể bấm 'Nộp bài'.", 'success');
        }
        break;
      }

      if (nextBtn) {
        const currentLabel = labelText;
        const progressEl = dialog.querySelector('span.text-gray-700');
        const currentProgress = progressEl ? progressEl.textContent.trim() : '';

        safeClick(nextBtn);

        // Chờ câu tiếp theo xuất hiện (label đổi HOẶC progress đổi - mô phỏng test_solver.py lines 602-618)
        let changed = false;
        for (let i = 0; i < 50; i++) {
          await sleep(150);
          const newLabelEl = findQuestionLabel(dialog);
          const newLabel = newLabelEl ? newLabelEl.textContent.trim() : '';
          const newProgressEl = dialog.querySelector('span.text-gray-700');
          const newProgress = newProgressEl ? newProgressEl.textContent.trim() : '';

          if ((newLabel && newLabel !== currentLabel) || (newProgress && newProgress !== currentProgress)) {
            changed = true;
            break;
          }
        }

        if (!changed) {
          logMessage('[WARN] Câu tiếp theo chưa hiển thị kịp hoặc đã đến cuối bài.', 'warn');
          break;
        }
      } else {
        if (submitBtn && autoSubmit) {
          logMessage("🎉 Tự động bấm nút 'Nộp bài'...", 'success');
          safeClick(submitBtn);
        }
        break;
      }
    }

    logMessage(`🎉 Hoàn tất! Đã điền xong ${filledCount} câu trong bài tập.`, 'success');
    return { success: true, filledCount };
  }

  /**
   * Fallback khi bài tập hiển thị cả trang (không phải modal)
   */
  function fillTestFullPage(answers) {
    let filledCount = 0;
    const questionLabels = Array.from(document.querySelectorAll('p, div, span, h3, h4')).filter((el) => {
      return safeIsVisible(el) && QUESTION_LABEL_RE.test((el.textContent || '').trim());
    });

    questionLabels.forEach((labelEl) => {
      const qNum = parseQuestionIndex(labelEl.textContent);
      if (qNum === null) return;

      const targetAns = answers[qNum];
      if (!targetAns) return;

      let container =
        labelEl.closest('div.border, div.rounded-xl, div.shadow, section, article') || labelEl.parentElement;
      if (!container) return;

      const tfBlocks = Array.from(
        container.querySelectorAll("div.border.border-gray-200.rounded-lg.p-3.bg-gray-50, div[class*='bg-gray-50']")
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
        logMessage(`✓ Câu ${qNum}: đã chọn Đúng/Sai`, 'success');
        return;
      }

      const textarea = container.querySelector('textarea');
      if (textarea && safeIsVisible(textarea)) {
        setNativeValue(textarea, targetAns);
        filledCount++;
        logMessage(`✓ Câu ${qNum}: đã điền tự luận`, 'success');
        return;
      }

      const input = container.querySelector("input[type='text']");
      if (input && safeIsVisible(input)) {
        setNativeValue(input, targetAns);
        filledCount++;
        logMessage(`✓ Câu ${qNum}: đã điền ô trống`, 'success');
        return;
      }

      const optionEls = Array.from(
        container.querySelectorAll(
          'div.relative.flex.items-center.space-x-2.p-2.border.rounded-lg.cursor-pointer, div.border.rounded-lg.cursor-pointer, label'
        )
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
          logMessage(`✓ Câu ${qNum}: đã chọn ${targetAns}`, 'success');
          break;
        }
      }
    });

    logMessage(`🎉 Đã tự động điền xong ${filledCount} câu hỏi bài tập.`, 'success');
    return { success: true, filledCount };
  }

  // =========================================================================
  // Xuất API toàn cục cho Extension
  // =========================================================================
  window.EduxTestSolver = {
    fillTestAnswers,
    extractQuestions,
    startExercise,
    setCapturedExamData,
    getCapturedExamData,
    loadAnswersFromInput,
    sanitizeAiResponse,
    buildCompactPromptPayload,
    generateStandardPromptText
  };
})();
