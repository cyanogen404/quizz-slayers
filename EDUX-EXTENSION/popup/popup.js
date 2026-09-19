/**
 * EDUX Slayers - Popup Controller v2.2.0
 * Điều khiển giao diện Extension, giải Slide, giải Bài tập (mô phỏng EDUX-TEST-SOLVER)
 * và theo dõi điểm số môn học.
 */

document.addEventListener('DOMContentLoaded', async () => {
  // Ordered content scripts for tab re-injection
  const CONTENT_SCRIPTS = [
    'scripts/dom-utils.js',
    'scripts/slide-solver.js',
    'scripts/test-solver.js',
    'scripts/score-tracker.js',
    'content.js'
  ];

  // =========================================================================
  // 1. UI Elements Mapping
  // =========================================================================
  const UI = {
    tabs: document.querySelectorAll('.tab-btn'),
    tabContents: document.querySelectorAll('.tab-content'),
    globalStatus: document.getElementById('globalStatus'),

    // Slide Solver UI
    btnStartSlide: document.getElementById('btnStartSlide'),
    btnStopSlide: document.getElementById('btnStopSlide'),
    slideCount: document.getElementById('slideCount'),
    retryCount: document.getElementById('retryCount'),
    slideLog: document.getElementById('slideLog'),

    // Test Solver (Bài tập) UI
    examInfoBox: document.getElementById('examInfoBox'),
    examInfoText: document.getElementById('examInfoText'),
    examStatusDot: document.getElementById('examStatusDot'),
    btnStartExercise: document.getElementById('btnStartExercise'),
    btnExtractQuestions: document.getElementById('btnExtractQuestions'),
    btnSolveAI: document.getElementById('btnSolveAI'),
    promptPreviewCard: document.getElementById('promptPreviewCard'),
    promptPreviewBox: document.getElementById('promptPreviewBox'),
    btnHidePrompt: document.getElementById('btnHidePrompt'),
    btnTogglePrompt: document.getElementById('btnTogglePrompt'),
    btnPasteClipboard: document.getElementById('btnPasteClipboard'),
    answerInput: document.getElementById('answerInput'),
    btnFillAnswers: document.getElementById('btnFillAnswers'),
    testLog: document.getElementById('testLog'),

    // Exercise Scores UI
    scoresSubjectTitle: document.getElementById('scoresSubjectTitle'),
    scoresCompleted: document.getElementById('scoresCompleted'),
    scoresHighest: document.getElementById('scoresHighest'),
    scoresAlertBox: document.getElementById('scoresAlertBox'),
    btnRefreshScores: document.getElementById('btnRefreshScores'),
    scoresList: document.getElementById('scoresList'),

    // Settings UI
    settingDelay: document.getElementById('settingDelay'),
    settingAutoNext: document.getElementById('settingAutoNext'),
    settingAutoSubmit: document.getElementById('settingAutoSubmit'),
    settingApiKey: document.getElementById('settingApiKey'),
    settingModel: document.getElementById('settingModel'),
    btnSaveSettings: document.getElementById('btnSaveSettings')
  };

  // =========================================================================
  // 2. Logging & Status Helpers
  // =========================================================================
  function addLog(container, message, type = 'info') {
    if (!container) return;
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    const timeStr = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    entry.textContent = `[${timeStr}] ${message}`;
    container.appendChild(entry);
    container.scrollTop = container.scrollHeight;
  }

  function setStatus(text, state = 'idle') {
    if (!UI.globalStatus) return;
    UI.globalStatus.className = `status-indicator ${state}`;
    const textEl = UI.globalStatus.querySelector('.status-text');
    if (textEl) textEl.textContent = text;
  }

  function updateExamInfoUI(data) {
    if (!UI.examInfoBox || !UI.examInfoText) return;
    if (data && typeof data === 'object') {
      const payloadData = data.data || data;
      const title = payloadData.title || data.title || 'Bài tập phát hiện';
      const qCount =
        payloadData.total_questions ||
        data.total_questions ||
        payloadData.exam_data?.multiple_choice?.length ||
        data.exam_data?.multiple_choice?.length ||
        '?';
      UI.examInfoBox.classList.add('active');
      UI.examInfoText.textContent = `🎯 ${title} (${qCount} câu)`;
      UI.examInfoText.title = title;
    } else {
      UI.examInfoBox.classList.remove('active');
      UI.examInfoText.textContent = "Chưa bắt được đề. Mở hoặc bấm 'Làm bài tập'.";
      UI.examInfoText.title = '';
    }
  }

  // =========================================================================
  // 3. Tab Communication
  // =========================================================================
  async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }

  async function sendTabMessage(tabId, message) {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (err) {
      // Content script not loaded or tab disconnected: inject required scripts
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: CONTENT_SCRIPTS
        });
        await chrome.scripting.insertCSS({
          target: { tabId },
          files: ['content.css']
        });
        await new Promise((r) => setTimeout(r, 200));
        return await chrome.tabs.sendMessage(tabId, message);
      } catch (injectErr) {
        throw err;
      }
    }
  }

  // =========================================================================
  // 4. Tab Navigation
  // =========================================================================
  UI.tabs.forEach((btn) => {
    btn.addEventListener('click', () => {
      const tabId = btn.getAttribute('data-tab');
      UI.tabs.forEach((b) => b.classList.remove('active'));
      UI.tabContents.forEach((c) => c.classList.remove('active'));

      btn.classList.add('active');
      const targetContent = document.getElementById(tabId);
      if (targetContent) targetContent.classList.add('active');

      if (tabId === 'tab-scores') {
        loadExerciseScores();
      }
    });
  });

  // =========================================================================
  // 5. Load Stored Configuration & Initial State
  // =========================================================================
  const settings = await chrome.storage.local.get([
    'delayMs',
    'autoNext',
    'autoSubmit',
    'savedAnswers',
    'slideStats',
    'lastExamData',
    'apiKey',
    'apiModel'
  ]);

  UI.settingDelay.value = settings.delayMs !== undefined ? settings.delayMs : 100;
  UI.settingAutoNext.checked = settings.autoNext !== undefined ? settings.autoNext : true;
  if (UI.settingAutoSubmit) UI.settingAutoSubmit.checked = settings.autoSubmit !== undefined ? settings.autoSubmit : true;
  if (UI.settingApiKey && settings.apiKey) UI.settingApiKey.value = settings.apiKey;
  if (UI.settingModel && settings.apiModel) UI.settingModel.value = settings.apiModel;

  if (settings.savedAnswers) UI.answerInput.value = settings.savedAnswers;
  if (settings.slideStats) {
    UI.slideCount.textContent = settings.slideStats.solved || 0;
    UI.retryCount.textContent = settings.slideStats.retries || 0;
  }

  if (settings.lastExamData) {
    updateExamInfoUI(settings.lastExamData);
  }

  // Check state from content script on popup open
  const activeTab = await getActiveTab();
  if (activeTab && activeTab.url && (activeTab.url.includes('cmcu.edu.vn') || activeTab.url.includes('edux'))) {
    try {
      const response = await sendTabMessage(activeTab.id, { action: 'GET_STATUS' });
      if (response && response.isSlideRunning) {
        UI.btnStartSlide.classList.add('hidden');
        UI.btnStopSlide.classList.remove('hidden');
        setStatus('Đang giải Slide...', 'running');
      }
    } catch (e) {
      addLog(UI.slideLog, 'Mở slide hoặc bài tập để bắt đầu.', 'info');
    }
  } else {
    addLog(UI.slideLog, 'Vui lòng chuyển sang trang EDUX để sử dụng.', 'warn');
  }

  // Listen for progress updates from content script
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'SLIDE_LOG') {
      addLog(UI.slideLog, msg.message, msg.logType || 'info');
      if (msg.solvedCount !== undefined) UI.slideCount.textContent = msg.solvedCount;
      if (msg.retryCount !== undefined) UI.retryCount.textContent = msg.retryCount;
    } else if (msg.type === 'TEST_LOG') {
      addLog(UI.testLog, msg.message, msg.logType || 'info');
    } else if (msg.type === 'EXAM_DATA_READY') {
      updateExamInfoUI(msg.payload);
      addLog(UI.testLog, '📡 Đã bắt được đề bài tập từ hệ thống!', 'success');
    } else if (msg.type === 'SLIDE_STATUS_CHANGE') {
      if (msg.isRunning) {
        UI.btnStartSlide.classList.add('hidden');
        UI.btnStopSlide.classList.remove('hidden');
        setStatus('Đang giải Slide...', 'running');
      } else {
        UI.btnStartSlide.classList.remove('hidden');
        UI.btnStopSlide.classList.add('hidden');
        setStatus('Sẵn sàng', 'idle');
      }
    }
  });

  // =========================================================================
  // 6. Slide Brute-force Actions
  // =========================================================================
  UI.btnStartSlide.addEventListener('click', async () => {
    const tab = await getActiveTab();
    if (!tab) return;
    try {
      await sendTabMessage(tab.id, {
        action: 'START_SLIDE_BRUTEFORCE',
        config: {
          delayMs: parseInt(UI.settingDelay.value, 10) || 100,
          autoNext: UI.settingAutoNext.checked
        }
      });
      UI.btnStartSlide.classList.add('hidden');
      UI.btnStopSlide.classList.remove('hidden');
      setStatus('Đang giải Slide...', 'running');
      addLog(UI.slideLog, 'Đã kích hoạt giải Slide tự động.', 'success');
    } catch (err) {
      addLog(UI.slideLog, 'Lỗi kết nối với trang EDUX: ' + err.message, 'error');
    }
  });

  UI.btnStopSlide.addEventListener('click', async () => {
    const tab = await getActiveTab();
    if (!tab) return;
    try {
      await sendTabMessage(tab.id, { action: 'STOP_SLIDE_BRUTEFORCE' });
      UI.btnStartSlide.classList.remove('hidden');
      UI.btnStopSlide.classList.add('hidden');
      setStatus('Đã dừng', 'stopped');
      addLog(UI.slideLog, 'Đã dừng giải Slide.', 'warn');
    } catch (err) {
      addLog(UI.slideLog, 'Không thể dừng tiến trình.', 'error');
    }
  });

  // =========================================================================
  // 7. AI Solver Service (Mô phỏng get_answers_via_litellm từ EDUX-TEST-SOLVER)
  // =========================================================================
  async function solveWithAI(promptContent, apiKey, model) {
    const key = (apiKey || '').trim();
    if (!key) {
      throw new Error('Chưa cấu hình API Key. Vui lòng vào tab Cài đặt để nhập key.');
    }

    const rawModel = (model || '').trim();
    const isGemini = key.startsWith('AIza') || rawModel.toLowerCase().includes('gemini') || !rawModel;

    let responseText = '';

    if (isGemini) {
      const geminiModel = rawModel ? rawModel.replace(/^gemini\//i, '') : 'gemini-2.0-flash';
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${encodeURIComponent(key)}`;

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: promptContent }] }],
          generationConfig: { temperature: 0 }
        })
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(`Lỗi Gemini API (${res.status}): ${errJson.error?.message || res.statusText}`);
      }

      const resJson = await res.json();
      responseText = resJson?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    } else {
      // OpenAI hoặc Compatible endpoint
      const openAiModel = rawModel || 'gpt-4o-mini';
      const endpoint = 'https://api.openai.com/v1/chat/completions';

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`
        },
        body: JSON.stringify({
          model: openAiModel,
          messages: [{ role: 'user', content: promptContent }],
          temperature: 0
        })
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(`Lỗi OpenAI API (${res.status}): ${errJson.error?.message || res.statusText}`);
      }

      const resJson = await res.json();
      responseText = resJson?.choices?.[0]?.message?.content || '';
    }

    // Mô phỏng sanitize_ai_response()
    let cleaned = responseText.trim();
    if (cleaned.startsWith('```')) {
      const match = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
      if (match) {
        cleaned = match[1].trim();
      }
    }
    return cleaned;
  }

  // =========================================================================
  // 8. Test Solver Actions (Bài tập)
  // =========================================================================

  // Nút 1: Mở bài tập (Bấm "Làm bài tập" trên trang)
  if (UI.btnStartExercise) {
    UI.btnStartExercise.addEventListener('click', async () => {
      const tab = await getActiveTab();
      if (!tab) return;
      try {
        addLog(UI.testLog, "Đang tìm nút 'Làm bài tập' trên trang...", 'info');
        const res = await sendTabMessage(tab.id, { action: 'START_EXERCISE' });
        if (res && res.success) {
          addLog(UI.testLog, res.opened ? 'Cửa sổ bài tập đã sẵn sàng!' : 'Đã bấm nút làm bài tập.', 'success');
        } else {
          addLog(UI.testLog, res?.message || 'Không tìm thấy nút làm bài tập.', 'warn');
        }
      } catch (err) {
        addLog(UI.testLog, 'Lỗi: ' + err.message, 'error');
      }
    });
  }

  // Nút 2: Copy Prompt câu hỏi chuẩn theo EDUX-TEST-SOLVER
  UI.btnExtractQuestions.addEventListener('click', async () => {
    const tab = await getActiveTab();
    if (!tab) return;

    try {
      addLog(UI.testLog, 'Đang trích xuất đề bài tập...', 'info');
      const res = await sendTabMessage(tab.id, { action: 'EXTRACT_QUESTIONS' });
      if (res && res.promptText) {
        await navigator.clipboard.writeText(res.promptText);
        if (UI.promptPreviewBox) UI.promptPreviewBox.value = res.promptText;
        if (UI.promptPreviewCard) UI.promptPreviewCard.style.display = 'flex';
        updateExamInfoUI(res.questions);
        addLog(
          UI.testLog,
          `Thành công! Đã copy Prompt (${res.questions?.total_questions || 0} câu) vào Clipboard.`,
          'success'
        );
      } else {
        addLog(UI.testLog, 'Chưa tìm thấy câu hỏi bài tập nào trên trang.', 'warn');
      }
    } catch (err) {
      addLog(UI.testLog, 'Lỗi trích xuất câu hỏi: ' + err.message, 'error');
    }
  });

  // Nút 3: Giải tự động bằng AI (API Key)
  if (UI.btnSolveAI) {
    UI.btnSolveAI.addEventListener('click', async () => {
      const tab = await getActiveTab();
      if (!tab) return;

      const apiKey = (UI.settingApiKey?.value || '').trim();
      const model = (UI.settingModel?.value || '').trim();

      if (!apiKey) {
        addLog(UI.testLog, '⚠️ Chưa có API Key! Đang chuyển sang tab Cài đặt để nhập key...', 'warn');
        const settingsTabBtn = document.querySelector('.tab-btn[data-tab="tab-settings"]');
        if (settingsTabBtn) settingsTabBtn.click();
        return;
      }

      try {
        addLog(UI.testLog, 'Đang trích xuất đề bài tập...', 'info');
        const extRes = await sendTabMessage(tab.id, { action: 'EXTRACT_QUESTIONS' });
        if (!extRes || !extRes.promptText) {
          addLog(UI.testLog, "Không tìm thấy đề bài tập. Hãy mở hoặc bấm 'Mở bài' trước!", 'warn');
          return;
        }

        const qCount = extRes.questions?.total_questions || 0;
        updateExamInfoUI(extRes.questions);
        addLog(UI.testLog, `Đang gửi ${qCount} câu tới AI (${model || 'Gemini'})...`, 'info');
        setStatus('AI đang giải bài...', 'running');

        const aiAnswers = await solveWithAI(extRes.promptText, apiKey, model);
        UI.answerInput.value = aiAnswers;
        await chrome.storage.local.set({ savedAnswers: aiAnswers });

        addLog(UI.testLog, '✓ AI đã giải xong! Bắt đầu tự động điền đáp án...', 'success');

        const fillRes = await sendTabMessage(tab.id, {
          action: 'FILL_TEST_ANSWERS',
          answersText: aiAnswers,
          options: { autoSubmit: UI.settingAutoSubmit ? UI.settingAutoSubmit.checked : true }
        });

        setStatus('Sẵn sàng', 'idle');
        if (fillRes && fillRes.success) {
          addLog(UI.testLog, `🎉 Hoàn tất! Đã điền xong ${fillRes.filledCount} câu bài tập.`, 'success');
        } else {
          addLog(UI.testLog, `Thông báo: ${fillRes?.message || 'Không thể điền bài.'}`, 'warn');
        }
      } catch (err) {
        setStatus('Sẵn sàng', 'idle');
        addLog(UI.testLog, 'Lỗi giải AI: ' + err.message, 'error');
      }
    });
  }

  // Nút 4: Dán đáp án từ Clipboard
  if (UI.btnPasteClipboard) {
    UI.btnPasteClipboard.addEventListener('click', async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (!text || !text.trim()) {
          addLog(UI.testLog, 'Clipboard đang trống!', 'warn');
          return;
        }
        UI.answerInput.value = text.trim();
        await chrome.storage.local.set({ savedAnswers: text.trim() });
        addLog(UI.testLog, '✓ Đã dán đáp án từ Clipboard.', 'success');
      } catch (e) {
        addLog(UI.testLog, 'Không thể đọc Clipboard: ' + e.message, 'error');
      }
    });
  }

  // Nút 5: Xem/ẩn Prompt xem trước
  if (UI.btnTogglePrompt) {
    UI.btnTogglePrompt.addEventListener('click', async () => {
      if (!UI.promptPreviewCard) return;
      if (UI.promptPreviewCard.style.display === 'none') {
        if (!UI.promptPreviewBox.value.trim()) {
          const tab = await getActiveTab();
          if (tab) {
            const res = await sendTabMessage(tab.id, { action: 'EXTRACT_QUESTIONS' });
            if (res && res.promptText) {
              UI.promptPreviewBox.value = res.promptText;
              updateExamInfoUI(res.questions);
            }
          }
        }
        UI.promptPreviewCard.style.display = 'flex';
      } else {
        UI.promptPreviewCard.style.display = 'none';
      }
    });
  }

  if (UI.btnHidePrompt) {
    UI.btnHidePrompt.addEventListener('click', () => {
      if (UI.promptPreviewCard) UI.promptPreviewCard.style.display = 'none';
    });
  }

  // Nút 6: Bắt đầu điền bài tập
  UI.btnFillAnswers.addEventListener('click', async () => {
    const rawAnswers = UI.answerInput.value.trim();
    if (!rawAnswers) {
      addLog(UI.testLog, 'Vui lòng nhập hoặc dán danh sách đáp án trước!', 'warn');
      return;
    }

    await chrome.storage.local.set({ savedAnswers: rawAnswers });

    const tab = await getActiveTab();
    if (!tab) return;

    try {
      addLog(UI.testLog, 'Đang gửi đáp án tới trang bài tập...', 'info');
      const res = await sendTabMessage(tab.id, {
        action: 'FILL_TEST_ANSWERS',
        answersText: rawAnswers,
        options: { autoSubmit: UI.settingAutoSubmit ? UI.settingAutoSubmit.checked : true }
      });
      if (res && res.success) {
        addLog(UI.testLog, `Hoàn tất! Đã điền ${res.filledCount} câu bài tập.`, 'success');
      } else {
        addLog(UI.testLog, `Thông báo: ${res?.message || 'Không thể điền bài tập.'}`, 'warn');
      }
    } catch (err) {
      addLog(UI.testLog, 'Lỗi: Không tìm thấy trang bài tập EDUX.', 'error');
    }
  });

  // =========================================================================
  // 9. Settings Actions
  // =========================================================================
  UI.btnSaveSettings.addEventListener('click', async () => {
    const newSettings = {
      delayMs: parseInt(UI.settingDelay.value, 10) || 100,
      autoNext: UI.settingAutoNext.checked,
      autoSubmit: UI.settingAutoSubmit ? UI.settingAutoSubmit.checked : true,
      apiKey: UI.settingApiKey ? UI.settingApiKey.value.trim() : '',
      apiModel: UI.settingModel ? UI.settingModel.value.trim() : 'gemini-2.0-flash'
    };

    await chrome.storage.local.set(newSettings);

    const tab = await getActiveTab();
    if (tab) {
      sendTabMessage(tab.id, {
        action: 'UPDATE_SETTINGS',
        settings: newSettings
      }).catch(() => {});
    }

    addLog(UI.slideLog, 'Đã lưu cấu hình mới!', 'success');
    addLog(UI.testLog, 'Đã cập nhật cấu hình bài tập & AI!', 'success');
  });

  // =========================================================================
  // 10. Exercise Scores Actions
  // =========================================================================
  async function loadExerciseScores() {
    const tab = await getActiveTab();
    if (!tab || !tab.url || !tab.url.includes('cmcu.edu.vn')) {
      if (UI.scoresSubjectTitle) UI.scoresSubjectTitle.textContent = 'Vui lòng mở trang EDUX';
      return;
    }

    const isStudentDashboard = tab.url.includes('/student') && !tab.url.includes('id=');

    try {
      if (UI.scoresSubjectTitle) UI.scoresSubjectTitle.textContent = 'Đang quét dữ liệu tiến độ...';

      if (isStudentDashboard) {
        // Load all subjects progress
        const res = await sendTabMessage(tab.id, { action: 'GET_ALL_SUBJECTS_PROGRESS' });
        if (!res || !res.success || !Array.isArray(res.subjects)) {
          if (UI.scoresSubjectTitle) UI.scoresSubjectTitle.textContent = 'Không thể lấy dữ liệu học phần.';
          return;
        }

        const subjects = res.subjects;
        let totalDoneExams = 0;
        let totalExams = 0;
        let totalDoneSlides = 0;
        let totalSlides = 0;
        let totalPendingExams = 0;

        subjects.forEach((s) => {
          totalDoneExams += s.doneExams || 0;
          totalExams += s.totalExams || 0;
          totalDoneSlides += s.doneSlides || 0;
          totalSlides += s.totalSlides || 0;
          totalPendingExams += s.pendingExams || 0;
        });

        if (UI.scoresSubjectTitle) {
          UI.scoresSubjectTitle.textContent = `Tổng quan: ${subjects.length} Học phần`;
        }
        if (UI.scoresCompleted) {
          UI.scoresCompleted.textContent = `${totalDoneExams}/${totalExams} bài`;
        }
        if (UI.scoresHighest) {
          UI.scoresHighest.textContent = `${totalDoneSlides}/${totalSlides} slide`;
        }

        if (UI.scoresAlertBox) {
          if (totalPendingExams > 0) {
            UI.scoresAlertBox.style.display = 'block';
            UI.scoresAlertBox.className = 'log-entry warn';
            UI.scoresAlertBox.innerHTML = `⚠️ Toàn bộ học phần: Còn <strong>${totalPendingExams}</strong> bài tập AI chưa làm!`;
          } else {
            UI.scoresAlertBox.style.display = 'block';
            UI.scoresAlertBox.className = 'log-entry success';
            UI.scoresAlertBox.innerHTML = `🎉 Tuyệt vời! Bạn đã hoàn thành 100% bài tập của tất cả môn học!`;
          }
        }

        if (UI.scoresList) {
          UI.scoresList.innerHTML = '';
          subjects.forEach((s) => {
            const item = document.createElement('div');
            const isDone = s.isAllDone;
            item.className = `log-entry ${isDone ? 'success' : s.pendingExams > 0 ? 'warn' : 'info'}`;
            item.style.display = 'flex';
            item.style.flexDirection = 'column';
            item.style.gap = '4px';
            item.style.padding = '8px 10px';

            const badgeText = isDone
              ? '<span style="color: #059669; font-weight: bold;">✓ 100%</span>'
              : s.pendingExams > 0
              ? `<span style="color: #e11d48; font-weight: bold;">⚠️ Còn ${s.pendingExams} bài</span>`
              : `<span style="color: #d97706; font-weight: bold;">📖 Còn ${s.pendingSlides} slide</span>`;

            item.innerHTML = `
              <div style="display: flex; justify-content: space-between; align-items: center;">
                <strong style="color: #0f172a; font-size: 12px;" title="${s.name}">
                  ${s.code ? `[${s.code}] ` : ''}${s.name}
                </strong>
                ${badgeText}
              </div>
              <div style="display: flex; gap: 12px; font-size: 11px; color: #475569;">
                <span>🖥️ Slide: <strong>${s.doneSlides}/${s.totalSlides}</strong> (${s.slidePercent}%)</span>
                <span>📝 Bài tập: <strong>${s.doneExams}/${s.totalExams}</strong> (${s.examPercent}%)</span>
              </div>
            `;
            UI.scoresList.appendChild(item);
          });
        }
        return;
      }

      // Single subject page logic
      const res = await sendTabMessage(tab.id, { action: 'GET_EXERCISE_SCORES' });
      if (!res || !res.success || !Array.isArray(res.models)) {
        if (UI.scoresSubjectTitle) UI.scoresSubjectTitle.textContent = res?.message || 'Không tìm thấy dữ liệu bài tập.';
        return;
      }

      const models = res.models;
      const examModels = models.filter((m) => m.exist_exam);
      const totalExams = examModels.length;
      const completedExams = examModels.filter((m) => m.highest_score !== null && m.highest_score !== undefined);
      const pendingExams = examModels.filter((m) => m.highest_score === null || m.highest_score === undefined);

      const scores = completedExams
        .map((m) => parseFloat(m.highest_score))
        .filter((s) => !isNaN(s));
      const maxScore = scores.length ? Math.max(...scores).toFixed(2).replace(/\.00$/, '') : '--';

      if (UI.scoresSubjectTitle) {
        UI.scoresSubjectTitle.textContent = `Môn học: ${res.subjectId ? res.subjectId.slice(0, 8) + '...' : 'Hiện tại'}`;
      }
      if (UI.scoresCompleted) UI.scoresCompleted.textContent = `${completedExams.length}/${totalExams}`;
      if (UI.scoresHighest) UI.scoresHighest.textContent = maxScore !== '--' ? `${maxScore}/10` : '--';

      // Alert box
      if (UI.scoresAlertBox) {
        if (pendingExams.length > 0) {
          UI.scoresAlertBox.style.display = 'block';
          UI.scoresAlertBox.className = 'log-entry warn';
          UI.scoresAlertBox.innerHTML = `⚠️ Cảnh báo: Bạn còn <strong>${pendingExams.length}</strong> bài tập chưa có điểm!`;
        } else if (totalExams > 0) {
          UI.scoresAlertBox.style.display = 'block';
          UI.scoresAlertBox.className = 'log-entry success';
          UI.scoresAlertBox.innerHTML = `🎉 Xuất sắc! Đã hoàn thành 100% bài tập môn này!`;
        } else {
          UI.scoresAlertBox.style.display = 'none';
        }
      }

      // Render exercise list
      if (UI.scoresList) {
        UI.scoresList.innerHTML = '';
        examModels.forEach((m) => {
          const item = document.createElement('div');
          const hasScore = m.highest_score !== null && m.highest_score !== undefined;
          item.className = `log-entry ${hasScore ? 'success' : 'warn'}`;
          item.style.display = 'flex';
          item.style.justifyContent = 'space-between';
          item.style.alignItems = 'center';
          item.style.gap = '8px';

          const scoreVal = hasScore ? parseFloat(m.highest_score) : null;
          const scoreDisplay =
            scoreVal !== null && !isNaN(scoreVal) ? scoreVal.toFixed(2).replace(/\.00$/, '') : m.highest_score;
          const scoreText = hasScore
            ? `<strong style="color: #10b981;">🏆 ${scoreDisplay}/10</strong>`
            : `<span style="color: #f59e0b; font-weight: bold;">⚠️ Chưa làm</span>`;

          item.innerHTML = `
            <span style="flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${m.title}">
              ${m.title}
            </span>
            <span>${scoreText}</span>
          `;
          UI.scoresList.appendChild(item);
        });

        if (examModels.length === 0) {
          UI.scoresList.innerHTML = '<div class="log-entry info">Môn học này không có bài tập AI.</div>';
        }
      }
    } catch (err) {
      if (UI.scoresSubjectTitle) UI.scoresSubjectTitle.textContent = 'Lỗi kết nối trang EDUX';
      if (UI.scoresList) UI.scoresList.innerHTML = `<div class="log-entry error">Không thể lấy điểm số: ${err.message}</div>`;
    }
  }

  if (UI.btnRefreshScores) {
    UI.btnRefreshScores.addEventListener('click', loadExerciseScores);
  }
});
