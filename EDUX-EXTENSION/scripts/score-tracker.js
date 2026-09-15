/**
 * EDUX Slayers - Exercise Score & Badge Tracker
 * Tracks assignment completion status and injects highest score badges & warning banners
 */

(function () {
  'use strict';

  let cachedSubjectModels = null;
  let cachedSubjectId = null;
  let scoreObserver = null;
  let scoreRenderDebounceTimer = null;

  function getSubjectIdFromUrl() {
    try {
      const url = new URL(window.location.href);
      return url.searchParams.get('id');
    } catch (e) {
      return null;
    }
  }

  function normalizeTitleKey(str) {
    if (!str) return '';
    return str
      .toLowerCase()
      .replace(/[\s\-_.:,()]+/g, '')
      .trim();
  }

  async function fetchSubjectModels(subjectId, force = false) {
    if (!subjectId) return null;
    if (cachedSubjectModels && cachedSubjectId === subjectId && !force) {
      return cachedSubjectModels;
    }

    try {
      const res = await fetch(`/api/subjects/${subjectId}/models`, {
        credentials: 'include'
      });
      if (!res.ok) return null;
      const json = await res.json();
      if (json && Array.isArray(json.data)) {
        cachedSubjectModels = json.data;
        cachedSubjectId = subjectId;
        renderExerciseScoreBadges(cachedSubjectModels);
        return cachedSubjectModels;
      }
    } catch (e) {
      console.warn('[EDUX Slayers] Error fetching subject models:', e);
    }
    return null;
  }

  function renderSubjectOverviewBanner(models, container) {
    if (!models || !models.length || !container) return;

    let existingBanner = document.getElementById('edux-subject-exercise-banner');
    if (!existingBanner) {
      existingBanner = document.createElement('div');
      existingBanner.id = 'edux-subject-exercise-banner';
      existingBanner.className = 'edux-subject-overview-banner';
      container.prepend(existingBanner);
    }

    const examModels = models.filter((m) => m.exist_exam);
    const totalExams = examModels.length;
    const completedExams = examModels.filter((m) => m.highest_score !== null && m.highest_score !== undefined);
    const pendingExams = examModels.filter((m) => m.highest_score === null || m.highest_score === undefined);

    const scores = completedExams
      .map((m) => parseFloat(m.highest_score))
      .filter((s) => !isNaN(s));

    const maxScore = scores.length ? Math.max(...scores).toFixed(2).replace(/\.00$/, '') : '0';
    const avgScore = scores.length ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2).replace(/\.00$/, '') : '0';
    const completionPercent = totalExams > 0 ? Math.round((completedExams.length / totalExams) * 100) : 0;

    let alertHtml = '';
    if (pendingExams.length > 0) {
      alertHtml = `
        <div class="edux-banner-alert">
          <div style="display: flex; align-items: center; gap: 6px;">
            <span>⚠️</span>
            <span>Cảnh báo: Bạn còn <strong>${pendingExams.length}</strong> bài tập chưa làm (chưa có kết quả)!</span>
          </div>
          <button type="button" id="edux-btn-jump-pending" style="background: #e11d48; color: white; border: none; border-radius: 6px; padding: 4px 10px; font-size: 11px; font-weight: 700; cursor: pointer;">
            🎯 Cuộn đến bài chưa làm
          </button>
        </div>
      `;
    } else if (totalExams > 0) {
      alertHtml = `
        <div class="edux-banner-alert all-done">
          <span>🎉 Tuyệt vời! Bạn đã hoàn thành 100% tất cả các bài tập môn học này!</span>
        </div>
      `;
    }

    existingBanner.innerHTML = `
      <div class="edux-banner-header">
        <div class="edux-banner-title">
          <span>⚔️ EDUX Slayers • Trạng Thái Hoàn Thành Bài Tập</span>
        </div>
        <div class="edux-banner-stats">
          <div class="edux-stat-item" title="Số lượng bài tập AI đã có điểm">
            <span>📝 Đã nộp:</span>
            <strong>${completedExams.length}/${totalExams} (${completionPercent}%)</strong>
          </div>
          <div class="edux-stat-item" title="Điểm số cao nhất đạt được trong các bài tập">
            <span>🏆 Cao nhất:</span>
            <strong style="color: #059669;">${maxScore}/10</strong>
          </div>
          <div class="edux-stat-item" title="Điểm trung bình các bài đã nộp">
            <span>⭐ Trung bình:</span>
            <strong style="color: #2563eb;">${avgScore}/10</strong>
          </div>
        </div>
      </div>
      ${alertHtml}
    `;

    const jumpBtn = existingBanner.querySelector('#edux-btn-jump-pending');
    if (jumpBtn) {
      jumpBtn.onclick = () => {
        const firstWarning = document.querySelector('.edux-exercise-badge-warning');
        if (firstWarning) {
          firstWarning.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      };
    }
  }

  function renderExerciseScoreBadges(models) {
    if (!models || !models.length) return;

    // 1. Locate curriculum container for overview banner
    const firstAccordion = document.querySelector('button.w-full.flex.items-center.justify-between');
    const curriculumContainer = firstAccordion
      ? firstAccordion.closest('div.space-y-4, div.flex-1, main, section') || firstAccordion.parentElement
      : null;
    if (curriculumContainer) {
      renderSubjectOverviewBanner(models, curriculumContainer);
    }

    // 2. Build map of models by normalized title for fast lookup
    const modelByTitle = new Map();
    models.forEach((m) => {
      const key = normalizeTitleKey(m.title);
      if (key) modelByTitle.set(key, m);
    });

    // 3. Find all lesson cards/rows
    const actionButtons = Array.from(document.querySelectorAll('button, a')).filter((el) => {
      const text = (el.textContent || '').trim();
      return text.includes('Bài tập AI') || text.includes('Bài giảng AI') || text === 'Bài giảng';
    });

    const cardContainers = new Set();
    actionButtons.forEach((btn) => {
      const btnRow = btn.parentElement;
      if (btnRow) cardContainers.add(btnRow);
    });

    cardContainers.forEach((btnRow) => {
      // Walk up to find the lesson card that contains the h3 title
      let card = btnRow.parentElement;
      while (card && card !== document.body && !card.querySelector('h3, h4, h2')) {
        card = card.parentElement;
      }
      if (!card || card === document.body) return;

      // Extract card title (EDUX puts lesson titles in h3 / h4 tags)
      let titleEl = card.querySelector('h3, h4, h2');
      if (!titleEl) {
        const candidates = Array.from(card.querySelectorAll('p, div, span, button[title]')).filter((el) => {
          const t = (el.getAttribute('title') || el.textContent || '').trim();
          return t && !/^\d+(\.\d+)?%$/.test(t) && t.length > 3 && !t.includes('Bài giảng') && !t.includes('Bài tập');
        });
        titleEl = candidates[0] || null;
      }
      const cardTitle = titleEl ? (titleEl.getAttribute('title') || titleEl.textContent || '').trim() : (card.textContent || '').trim();
      const normCardTitle = normalizeTitleKey(cardTitle);

      // Match model
      let matchedModel = modelByTitle.get(normCardTitle);
      if (!matchedModel) {
        for (const [key, m] of modelByTitle.entries()) {
          if (key && (normCardTitle.includes(key) || key.includes(normCardTitle))) {
            matchedModel = m;
            break;
          }
        }
      }

      if (!matchedModel) return;

      const btBtn = Array.from(btnRow.querySelectorAll('button, a')).find((b) => (b.textContent || '').includes('Bài tập AI'));
      if (!matchedModel.exist_exam && !btBtn) return;

      // Check / create badge element
      let badge = btnRow.querySelector('.edux-exercise-badge');
      if (!badge) {
        badge = document.createElement('div');
        badge.className = 'edux-exercise-badge';
        if (btBtn && btBtn.nextSibling) {
          btnRow.insertBefore(badge, btBtn.nextSibling);
        } else if (btBtn) {
          btnRow.appendChild(badge);
        } else {
          btnRow.appendChild(badge);
        }
      }

      const hasScore = matchedModel.highest_score !== null && matchedModel.highest_score !== undefined;

      if (hasScore) {
        const scoreVal = parseFloat(matchedModel.highest_score);
        const displayScore = isNaN(scoreVal) ? matchedModel.highest_score : scoreVal.toFixed(2).replace(/\.00$/, '');
        badge.className = 'edux-exercise-badge edux-exercise-badge-success';
        badge.innerHTML = `<span>🏆</span><span>Điểm: ${displayScore}/10</span>`;
        badge.title = `Điểm số cao nhất: ${displayScore} / 10`;
      } else {
        badge.className = 'edux-exercise-badge edux-exercise-badge-warning';
        badge.innerHTML = `<span>⚠️</span><span>Chưa làm</span>`;
        badge.title = `Cảnh báo: Bạn chưa hoàn thành bài tập này!`;
      }
    });
  }

  function initExerciseScoreTracker() {
    const subjectId = getSubjectIdFromUrl();
    if (subjectId) {
      fetchSubjectModels(subjectId);
    }

    if (!scoreObserver) {
      scoreObserver = new MutationObserver(() => {
        clearTimeout(scoreRenderDebounceTimer);
        scoreRenderDebounceTimer = setTimeout(() => {
          const currentSubId = getSubjectIdFromUrl();
          if (currentSubId) {
            if (currentSubId !== cachedSubjectId) {
              fetchSubjectModels(currentSubId);
            } else if (cachedSubjectModels) {
              renderExerciseScoreBadges(cachedSubjectModels);
            }
          }
        }, 200);
      });

      scoreObserver.observe(document.body, {
        childList: true,
        subtree: true
      });
    }
  }

  window.__EDUX_RENDER_SCORES__ = () => {
    if (cachedSubjectModels) {
      renderExerciseScoreBadges(cachedSubjectModels);
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initExerciseScoreTracker);
  } else {
    initExerciseScoreTracker();
  }

  // =========================================================================
  // =========================================================================


  window.EduxScoreTracker = {
    init: initExerciseScoreTracker,
    refresh: () => {
      const subjectId = getSubjectIdFromUrl();
      if (subjectId) fetchSubjectModels(subjectId, true);
    },
    setCachedModels: (models) => {
      cachedSubjectModels = models;
      cachedSubjectId = getSubjectIdFromUrl();
      renderExerciseScoreBadges(cachedSubjectModels);
    },
    getScores: async () => {
      const subjectId = getSubjectIdFromUrl();
      if (cachedSubjectModels) {
        return { success: true, subjectId, models: cachedSubjectModels };
      }
      if (subjectId) {
        const models = await fetchSubjectModels(subjectId);
        return { success: true, subjectId, models };
      }
      return { success: false, message: 'Không phải trang môn học EDUX' };
    }
  };
})();
