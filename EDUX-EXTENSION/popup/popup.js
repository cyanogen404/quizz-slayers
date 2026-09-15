/**
 * EDUX Slayers - Popup Controller
 * Manages extension UI tabs, configuration, slide solver controls,
 * test auto-fill actions, and exercise score statistics.
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

    // Test Solver UI
    answerInput: document.getElementById('answerInput'),
    btnFillAnswers: document.getElementById('btnFillAnswers'),
    btnExtractQuestions: document.getElementById('btnExtractQuestions'),
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
    'savedAnswers',
    'slideStats'
  ]);

  UI.settingDelay.value = settings.delayMs !== undefined ? settings.delayMs : 100;
  UI.settingAutoNext.checked = settings.autoNext !== undefined ? settings.autoNext : true;
  if (settings.savedAnswers) UI.answerInput.value = settings.savedAnswers;
  if (settings.slideStats) {
    UI.slideCount.textContent = settings.slideStats.solved || 0;
    UI.retryCount.textContent = settings.slideStats.retries || 0;
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
      addLog(UI.slideLog, 'Mở slide hoặc đề thi để bắt đầu.', 'info');
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
          delayMs: parseInt(UI.settingDelay.value) || 100,
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
  // 7. Test Solver Actions
  // =========================================================================
  UI.btnFillAnswers.addEventListener('click', async () => {
    const rawAnswers = UI.answerInput.value.trim();
    if (!rawAnswers) {
      addLog(UI.testLog, 'Vui lòng nhập danh sách đáp án trước!', 'warn');
      return;
    }

    await chrome.storage.local.set({ savedAnswers: rawAnswers });

    const tab = await getActiveTab();
    if (!tab) return;

    try {
      addLog(UI.testLog, 'Đang gửi đáp án tới trang kiểm tra...', 'info');
      const res = await sendTabMessage(tab.id, {
        action: 'FILL_TEST_ANSWERS',
        answersText: rawAnswers
      });
      if (res && res.success) {
        addLog(UI.testLog, `Hoàn tất! Đã điền ${res.filledCount} câu hỏi.`, 'success');
      } else {
        addLog(UI.testLog, `Thông báo: ${res?.message || 'Không thể điền bài.'}`, 'warn');
      }
    } catch (err) {
      addLog(UI.testLog, 'Lỗi: Không tìm thấy trang bài kiểm tra EDUX.', 'error');
    }
  });

  UI.btnExtractQuestions.addEventListener('click', async () => {
    const tab = await getActiveTab();
    if (!tab) return;

    try {
      addLog(UI.testLog, 'Đang quét danh sách câu hỏi...', 'info');
      const res = await sendTabMessage(tab.id, { action: 'EXTRACT_QUESTIONS' });
      if (res && (res.promptText || res.questions)) {
        const textToCopy = res.promptText || JSON.stringify(res.questions, null, 2);
        await navigator.clipboard.writeText(textToCopy);
        addLog(UI.testLog, 'Thành công! Đã sao chép prompt câu hỏi vào Clipboard.', 'success');
      } else {
        addLog(UI.testLog, 'Không tìm thấy câu hỏi nào trên trang.', 'warn');
      }
    } catch (err) {
      addLog(UI.testLog, 'Lỗi trích xuất câu hỏi: ' + err.message, 'error');
    }
  });

  // =========================================================================
  // 8. Settings Actions
  // =========================================================================
  UI.btnSaveSettings.addEventListener('click', async () => {
    const newSettings = {
      delayMs: parseInt(UI.settingDelay.value) || 100,
      autoNext: UI.settingAutoNext.checked
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
  });

  // =========================================================================
  // 9. Exercise Scores Actions
  // =========================================================================
  async function loadExerciseScores() {
    const tab = await getActiveTab();
    if (!tab || !tab.url || !tab.url.includes('cmcu.edu.vn')) {
      if (UI.scoresSubjectTitle) UI.scoresSubjectTitle.textContent = 'Vui lòng mở trang môn học EDUX';
      return;
    }

    try {
      if (UI.scoresSubjectTitle) UI.scoresSubjectTitle.textContent = 'Đang quét dữ liệu bài tập...';
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
          const scoreDisplay = scoreVal !== null && !isNaN(scoreVal) ? scoreVal.toFixed(2).replace(/\.00$/, '') : m.highest_score;
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

