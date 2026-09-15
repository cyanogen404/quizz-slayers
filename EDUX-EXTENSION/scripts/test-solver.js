/**
 * EDUX Slayers - Test Solver Engine
 * Auto-fill test answers from text or JSON, and extract questions
 */

(function () {
  'use strict';

  const { sleep, safeIsVisible, safeIsEnabled, safeClick, getActiveDialog, waitForHidden } = window.EduxDOM;

  function logMessage(msg, logType = 'info') {
    console.log('[EDUX Slayers Test] ' + msg);
    try {
      chrome.runtime.sendMessage({
        type: 'TEST_LOG',
        message: msg,
        logType
      });
    } catch (e) {}
  }

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

    const dialog = getActiveDialog();
    let result;
    if (dialog && safeIsVisible(dialog)) {
      result = await fillTestDialog(dialog, answers);
    } else {
      result = fillTestFullPage(answers);
    }

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
  // =========================================================================

  window.EduxTestSolver = {
    fillTestAnswers,
    extractQuestions
  };
})();
