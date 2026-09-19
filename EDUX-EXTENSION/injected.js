/**
 * EDUX Slayers - Injected Network Interceptor v2.2.0
 * Chạy trong execution context của trang (MAIN world) để bắt toàn bộ API request/response
 * (đặc biệt là request /start và exam questions payload) tương tự Playwright page.expect_response().
 */
(function () {
  if (window.__EDUX_SLAYERS_INTERCEPTOR_ACTIVE__) return;
  window.__EDUX_SLAYERS_INTERCEPTOR_ACTIVE__ = true;

  console.log('⚔️ [EDUX Slayers Interceptor] Đã kích hoạt bộ lắng nghe gói tin mạng.');

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
      console.log(`[EDUX Slayers Interceptor] 📡 Phát sự kiện ${type} từ:`, sourceUrl);
    } catch (e) {
      // Ignore serialization issues
    }
  }

  function broadcastExamPayload(data, sourceUrl) {
    try {
      // Lưu vào sessionStorage để bất kỳ script nào (kể cả Content Script) có thể truy cập tức thì
      sessionStorage.setItem('__EDUX_LAST_EXAM_DATA__', JSON.stringify(data));
      sessionStorage.setItem('__EDUX_LAST_EXAM_URL__', sourceUrl);
      window.__EDUX_LAST_EXAM_DATA__ = data;
      window.__EDUX_LAST_EXAM_URL__ = sourceUrl;
    } catch (e) {}

    broadcastEvent('EDUX_EXAM_DATA_CAPTURED', data, sourceUrl);
  }

  function isExamPayload(data, url) {
    if (!data || typeof data !== 'object') return false;
    const urlLower = (url || '').toLowerCase();

    // Loại trừ các API lịch sử hoặc môn học không phải đề bài
    if (urlLower.includes('/history') || urlLower.includes('/models') || urlLower.includes('/joined')) {
      return false;
    }

    const d = data.data || data;
    if (!d || typeof d !== 'object') return false;

    // Cấu trúc 1: Chứa exam_data (chuẩn của EDUX-TEST-SOLVER)
    const examData = d.exam_data || d;
    if (examData && typeof examData === 'object') {
      const hasMc = Array.isArray(examData.multiple_choice) && examData.multiple_choice.length > 0;
      const hasTf = Array.isArray(examData.true_false) && examData.true_false.length > 0;
      const hasFill = Array.isArray(examData.fill_in_blank) && examData.fill_in_blank.length > 0;
      const hasEssay = Array.isArray(examData.essay) && examData.essay.length > 0;
      const hasQuestions = Array.isArray(examData.questions) && examData.questions.length > 0;
      if (hasMc || hasTf || hasFill || hasEssay || hasQuestions) {
        return true;
      }
    }

    // Cấu trúc 2: Mảng câu hỏi trực tiếp
    if (Array.isArray(d) && d.length > 0 && (d[0].question || d[0].so_cau || d[0].options)) {
      return true;
    }

    // Cấu trúc 3: Endpoint chứa 'start' và có title / số câu
    if (urlLower.includes('start') && (d.title || d.total_questions > 0)) {
      return true;
    }

    return false;
  }

  function checkAndBroadcast(data, url) {
    if (!data || typeof data !== 'object') return;
    const urlLower = (url || '').toLowerCase();

    // 1. Kiểm tra API danh sách môn học đã tham gia
    if (urlLower.includes('/api/subjects/joined')) {
      broadcastEvent('EDUX_SUBJECTS_JOINED_CAPTURED', data, url);
      return;
    }

    // 2. Kiểm tra API danh sách bài học / models môn học
    if (urlLower.includes('/api/subjects/') && urlLower.includes('/models')) {
      broadcastEvent('EDUX_MODELS_DATA_CAPTURED', data, url);
      return;
    }

    // 3. Kiểm tra API lịch sử làm bài
    if (urlLower.includes('/api/exam/history')) {
      broadcastEvent('EDUX_EXAM_HISTORY_CAPTURED', data, url);
      return;
    }

    // 4. Kiểm tra gói tin đề bài tập (/start hoặc payload chứa questions)
    if (isExamPayload(data, url)) {
      console.log('[EDUX Slayers Interceptor] 🎯 ĐÃ BẮT ĐƯỢC GÓI TIN ĐỀ BÀI TẬP từ:', url);
      broadcastExamPayload(data, url);
    }
  }

  // =========================================================================
  // 1. Intercept window.fetch
  // =========================================================================
  const originalFetch = window.fetch;
  if (originalFetch) {
    window.fetch = async function (...args) {
      const response = await originalFetch.apply(this, args);
      try {
        const clone = response.clone();
        const resolvedUrl =
          (response && response.url) ||
          (typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '');

        clone
          .json()
          .then((json) => {
            checkAndBroadcast(json, resolvedUrl);
          })
          .catch(() => {
            // Thử đọc dạng text nếu json() báo lỗi
            clone
              .text()
              .then((text) => {
                try {
                  const parsed = JSON.parse(text);
                  checkAndBroadcast(parsed, resolvedUrl);
                } catch (e) {}
              })
              .catch(() => {});
          });
      } catch (e) {
        // Bỏ qua lỗi stream clone
      }
      return response;
    };
  }

  // =========================================================================
  // 2. Intercept XMLHttpRequest (Hỗ trợ an toàn cho cả responseType = 'json')
  // =========================================================================
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._edux_url = url;
    return originalOpen.apply(this, [method, url, ...rest]);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', function () {
      try {
        const url = this.responseURL || this._edux_url || '';
        let json = null;

        // Nếu responseType là 'json', truy cập responseText sẽ gây DOMException trong Chrome
        if (this.responseType === 'json' && this.response) {
          json = this.response;
        } else if (!this.responseType || this.responseType === 'text') {
          if (this.responseText) {
            json = JSON.parse(this.responseText);
          }
        } else if (this.response && typeof this.response === 'object') {
          json = this.response;
        }

        if (json) {
          checkAndBroadcast(json, url);
        }
      } catch (e) {
        // Parsing error or unsupported type
      }
    });
    return originalSend.apply(this, args);
  };
})();
