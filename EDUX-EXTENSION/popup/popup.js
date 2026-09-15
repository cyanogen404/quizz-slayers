document.addEventListener('DOMContentLoaded', async () => {
  // Tab switching logic
  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');

  tabBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const tabId = btn.getAttribute('data-tab');
      tabBtns.forEach((b) => b.classList.remove('active'));
      tabContents.forEach((c) => c.classList.remove('active'));

      btn.classList.add('active');
      document.getElementById(tabId).classList.add('active');
    });
  });

  // UI Elements
  const globalStatus = document.getElementById('globalStatus');
  const btnStartSlide = document.getElementById('btnStartSlide');
  const btnStopSlide = document.getElementById('btnStopSlide');
  const slideCount = document.getElementById('slideCount');
  const retryCount = document.getElementById('retryCount');
  const slideLog = document.getElementById('slideLog');

  const answerInput = document.getElementById('answerInput');
  const btnFillAnswers = document.getElementById('btnFillAnswers');
  const btnExtractQuestions = document.getElementById('btnExtractQuestions');
  const btnAiSolve = document.getElementById('btnAiSolve');
  const testLog = document.getElementById('testLog');

  const settingDelay = document.getElementById('settingDelay');
  const settingAutoNext = document.getElementById('settingAutoNext');
  const settingOllamaUrl = document.getElementById('settingOllamaUrl');
  const settingOllamaModel = document.getElementById('settingOllamaModel');
  const btnSaveSettings = document.getElementById('btnSaveSettings');

  // Helper: Append log line
  function addLog(container, message, type = 'info') {
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    const timeStr = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    entry.textContent = `[${timeStr}] ${message}`;
    container.appendChild(entry);
    container.scrollTop = container.scrollHeight;
  }

  // Helper: Update status badge
  function setStatus(text, state = 'idle') {
    globalStatus.className = `status-indicator ${state}`;
    globalStatus.querySelector('.status-text').textContent = text;
  }

  // Load saved settings
  const settings = await chrome.storage.local.get([
    'delayMs',
    'autoNext',
    'ollamaUrl',
    'ollamaModel',
    'savedAnswers',
    'slideStats'
  ]);

  if (settings.delayMs) settingDelay.value = settings.delayMs;
  else settingDelay.value = 100;
  if (settings.autoNext !== undefined) settingAutoNext.checked = settings.autoNext;
  if (settings.ollamaUrl) settingOllamaUrl.value = settings.ollamaUrl;
  if (settings.ollamaModel && settingOllamaModel) settingOllamaModel.value = settings.ollamaModel;
  if (settings.savedAnswers) answerInput.value = settings.savedAnswers;
  if (settings.slideStats) {
    slideCount.textContent = settings.slideStats.solved || 0;
    retryCount.textContent = settings.slideStats.retries || 0;
  }

  // Get active tab
  async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }

  /**
   * Resilient message sender: auto-injects content script if tab was disconnected
   */
  async function sendTabMessage(tabId, message) {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (err) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['content.js']
        });
        await chrome.scripting.insertCSS({
          target: { tabId },
          files: ['content.css']
        });
        await new Promise((r) => setTimeout(r, 250));
        return await chrome.tabs.sendMessage(tabId, message);
      } catch (injectErr) {
        throw err;
      }
    }
  }

  // Check state from content script on popup open
  const activeTab = await getActiveTab();
  if (activeTab && activeTab.url && (activeTab.url.includes('cmcu.edu.vn') || activeTab.url.includes('edux'))) {
    try {
      const response = await sendTabMessage(activeTab.id, { action: 'GET_STATUS' });
      if (response && response.isSlideRunning) {
        btnStartSlide.classList.add('hidden');
        btnStopSlide.classList.remove('hidden');
        setStatus('Đang giải Slide...', 'running');
      }
    } catch (e) {
      addLog(slideLog, 'Mở slide hoặc đề thi để bắt đầu.', 'info');
    }
  } else {
    addLog(slideLog, 'Vui lòng chuyển sang trang EDUX để sử dụng.', 'warn');
  }

  // Listen for progress updates from content script
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'SLIDE_LOG') {
      addLog(slideLog, msg.message, msg.logType || 'info');
      if (msg.solvedCount !== undefined) slideCount.textContent = msg.solvedCount;
      if (msg.retryCount !== undefined) retryCount.textContent = msg.retryCount;
    } else if (msg.type === 'TEST_LOG') {
      addLog(testLog, msg.message, msg.logType || 'info');
    } else if (msg.type === 'SLIDE_STATUS_CHANGE') {
      if (msg.isRunning) {
        btnStartSlide.classList.add('hidden');
        btnStopSlide.classList.remove('hidden');
        setStatus('Đang giải Slide...', 'running');
      } else {
        btnStartSlide.classList.remove('hidden');
        btnStopSlide.classList.add('hidden');
        setStatus('Sẵn sàng', 'idle');
      }
    }
  });

  // Action: Start Slide Brute-force
  btnStartSlide.addEventListener('click', async () => {
    const tab = await getActiveTab();
    if (!tab) return;
    try {
      await sendTabMessage(tab.id, {
        action: 'START_SLIDE_BRUTEFORCE',
        config: {
          delayMs: parseInt(settingDelay.value) || 100,
          autoNext: settingAutoNext.checked
        }
      });
      btnStartSlide.classList.add('hidden');
      btnStopSlide.classList.remove('hidden');
      setStatus('Đang giải Slide...', 'running');
      addLog(slideLog, 'Đã kích hoạt giải Slide tự động.', 'success');
    } catch (err) {
      addLog(slideLog, 'Lỗi kết nối với trang EDUX: ' + err.message, 'error');
    }
  });

  // Action: Stop Slide Brute-force
  btnStopSlide.addEventListener('click', async () => {
    const tab = await getActiveTab();
    if (!tab) return;
    try {
      await sendTabMessage(tab.id, { action: 'STOP_SLIDE_BRUTEFORCE' });
      btnStartSlide.classList.remove('hidden');
      btnStopSlide.classList.add('hidden');
      setStatus('Đã dừng', 'stopped');
      addLog(slideLog, 'Đã dừng giải Slide.', 'warn');
    } catch (err) {
      addLog(slideLog, 'Không thể dừng tiến trình.', 'error');
    }
  });

  // Action: Auto Fill Test Answers
  btnFillAnswers.addEventListener('click', async () => {
    const rawAnswers = answerInput.value.trim();
    if (!rawAnswers) {
      addLog(testLog, 'Vui lòng nhập danh sách đáp án trước!', 'warn');
      return;
    }

    await chrome.storage.local.set({ savedAnswers: rawAnswers });

    const tab = await getActiveTab();
    if (!tab) return;

    try {
      addLog(testLog, 'Đang gửi đáp án tới trang kiểm tra...', 'info');
      const res = await sendTabMessage(tab.id, {
        action: 'FILL_TEST_ANSWERS',
        answersText: rawAnswers
      });
      if (res && res.success) {
        addLog(testLog, `Hoàn tất! Đã điền ${res.filledCount} câu hỏi.`, 'success');
      } else {
        addLog(testLog, `Thông báo: ${res?.message || 'Không thể điền bài.'}`, 'warn');
      }
    } catch (err) {
      addLog(testLog, 'Lỗi: Không tìm thấy trang bài kiểm tra EDUX.', 'error');
    }
  });

  // Action: Extract Questions to Clipboard
  btnExtractQuestions.addEventListener('click', async () => {
    const tab = await getActiveTab();
    if (!tab) return;

    try {
      addLog(testLog, 'Đang quét danh sách câu hỏi...', 'info');
      const res = await sendTabMessage(tab.id, { action: 'EXTRACT_QUESTIONS' });
      if (res && (res.promptText || res.questions)) {
        const textToCopy = res.promptText || JSON.stringify(res.questions, null, 2);
        await navigator.clipboard.writeText(textToCopy);
        addLog(testLog, 'Thành công! Đã sao chép prompt câu hỏi vào Clipboard.', 'success');
      } else {
        addLog(testLog, 'Không tìm thấy câu hỏi nào trên trang.', 'warn');
      }
    } catch (err) {
      addLog(testLog, 'Lỗi trích xuất câu hỏi: ' + err.message, 'error');
    }
  });

  // Action: AI Solve via Ollama & Auto-Fill
  if (btnAiSolve) {
    btnAiSolve.addEventListener('click', async () => {
      const tab = await getActiveTab();
      if (!tab) return;

      try {
        addLog(testLog, 'Đang trích xuất câu hỏi từ đề thi...', 'info');
        const res = await sendTabMessage(tab.id, { action: 'EXTRACT_QUESTIONS' });
        if (!res || !res.promptText) {
          addLog(testLog, 'Không trích xuất được câu hỏi từ trang này.', 'warn');
          return;
        }

        const promptText = res.promptText;
        const ollamaUrl = settingOllamaUrl.value.trim() || 'http://localhost:11434';
        const ollamaModel = (settingOllamaModel && settingOllamaModel.value.trim()) || 'hf.co/arcee-ai/Arcee-VyLinh-GGUF:Q8_0';

        addLog(testLog, `Đang gửi đề thi tới Ollama (${ollamaModel}). Vui lòng chờ...`, 'info');

        chrome.runtime.sendMessage(
          {
            action: 'FETCH_OLLAMA',
            url: ollamaUrl,
            model: ollamaModel,
            prompt: promptText
          },
          async (ollamaRes) => {
            if (!ollamaRes || !ollamaRes.success) {
              addLog(testLog, `Lỗi kết nối Ollama: ${ollamaRes?.error || 'Không phản hồi'}. Đã lưu prompt vào Clipboard để bạn tự dán vào AI bên ngoài.`, 'warn');
              await navigator.clipboard.writeText(promptText);
              return;
            }

            const rawAiResponse = (ollamaRes.data && (ollamaRes.data.response || ollamaRes.data.content)) || '';
            if (!rawAiResponse) {
              addLog(testLog, 'Ollama trả về nội dung rỗng.', 'warn');
              return;
            }

            addLog(testLog, 'Đã nhận đáp án từ AI! Đang tiến hành điền vào bài...', 'success');
            answerInput.value = rawAiResponse;
            await chrome.storage.local.set({ savedAnswers: rawAiResponse });

            // Automatically trigger filling
            const fillRes = await sendTabMessage(tab.id, {
              action: 'FILL_TEST_ANSWERS',
              answersText: rawAiResponse
            });

            if (fillRes && fillRes.success) {
              addLog(testLog, `🎉 Hoàn tất! AI đã giải và điền ${fillRes.filledCount} câu hỏi!`, 'success');
            } else {
              addLog(testLog, `Đã nhận đáp án từ AI. Vui lòng kiểm tra ô đáp án và nhấn Điền thủ công nếu cần.`, 'info');
            }
          }
        );
      } catch (err) {
        addLog(testLog, 'Lỗi tiến trình AI: ' + err.message, 'error');
      }
    });
  }

  // Action: Save Settings
  btnSaveSettings.addEventListener('click', async () => {
    await chrome.storage.local.set({
      delayMs: parseInt(settingDelay.value) || 100,
      autoNext: settingAutoNext.checked,
      ollamaUrl: settingOllamaUrl.value.trim(),
      ollamaModel: settingOllamaModel ? settingOllamaModel.value.trim() : 'hf.co/arcee-ai/Arcee-VyLinh-GGUF:Q8_0'
    });

    const tab = await getActiveTab();
    if (tab) {
      sendTabMessage(tab.id, {
        action: 'UPDATE_SETTINGS',
        settings: {
          delayMs: parseInt(settingDelay.value) || 100,
          autoNext: settingAutoNext.checked
        }
      }).catch(() => {});
    }

    addLog(slideLog, 'Đã lưu cấu hình mới!', 'success');
  });
});
