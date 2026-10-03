/*
  CHANGELOG — multi-gap update
  - Added support for multi-select gaps ([4, 5, 6, 7]) per water arrival entry.
  - Migrated state schema silently on load from legacy `entry.gap` to `entry.gaps: [gap]`.
  - Updated prediction math: when multiple gaps selected, renders date range and window status
    (e.g. "Earliest in 2d", "Window opens TODAY", "In window now", "Overdue"). Single gap selection
    retains byte-for-byte legacy behavior.
  - Multi-select gap chip UI in Log Modal, Edit Modal, and Settings default gap preference.
  - Disabled Save button when zero gap chips are selected.
  - Updated history row gap display to compact pills ("4, 5d gap").
  - Updated average gap and most common gap stats to account for multi-gap frequency counts.
  - Updated "Water didn't come yet (+1d push)" to shift entire expected window forward by 1 day.
*/

// --- GLOBAL STORAGE KEY & DEFAULT STATE ---
const STORAGE_KEY = 'jalcycle.v1';

const DEFAULT_STATE = {
  householdName: 'My Home',
  userName: 'Family Member',
  defaultGaps: [5],
  history: []
};

// --- DATE UTILITIES (Strict Local YYYY-MM-DD Math) ---
const DateUtils = {
  // Returns today's local date string "YYYY-MM-DD"
  getTodayStr() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  },

  // Returns yesterday's local date string "YYYY-MM-DD"
  getYesterdayStr() {
    return this.addDays(this.getTodayStr(), -1);
  },

  // Converts "YYYY-MM-DD" to integer days since UTC epoch
  dateToDays(dateStr) {
    if (!dateStr || typeof dateStr !== 'string') return 0;
    const parts = dateStr.split('-').map(Number);
    if (parts.length !== 3 || parts.some(isNaN)) return 0;
    const [y, m, d] = parts;
    return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
  },

  // Converts integer days since UTC epoch back to "YYYY-MM-DD"
  daysToDateStr(days) {
    const d = new Date(days * 86400000);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  },

  // Adds or subtracts N days from a "YYYY-MM-DD" string
  addDays(dateStr, n) {
    const days = this.dateToDays(dateStr);
    return this.daysToDateStr(days + n);
  },

  // Difference in days: dateStrA - dateStrB
  diffDays(dateStrA, dateStrB) {
    return this.dateToDays(dateStrA) - this.dateToDays(dateStrB);
  },

  // Formats date string to nice reading string: e.g. "Thursday, 9 Oct"
  formatNice(dateStr, includeYear = false) {
    if (!dateStr) return '';
    const parts = dateStr.split('-').map(Number);
    if (parts.length !== 3) return dateStr;
    const [y, m, d] = parts;
    const dateObj = new Date(y, m - 1, d);
    
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    
    const dayName = days[dateObj.getDay()];
    const monthName = months[dateObj.getMonth()];
    
    return includeYear ? `${dayName}, ${d} ${monthName} ${y}` : `${dayName}, ${d} ${monthName}`;
  },

  // Formats short date: e.g. "9 Oct"
  formatShort(dateStr) {
    if (!dateStr) return '';
    const parts = dateStr.split('-').map(Number);
    if (parts.length !== 3) return dateStr;
    const [y, m, d] = parts;
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${d} ${months[m - 1]}`;
  },

  // Returns weekday name
  getWeekday(dateStr) {
    if (!dateStr) return '';
    const parts = dateStr.split('-').map(Number);
    if (parts.length !== 3) return '';
    const [y, m, d] = parts;
    const dateObj = new Date(y, m - 1, d);
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return days[dateObj.getDay()];
  }
};

// --- APPLICATION STATE & STORAGE CONTROLLER ---
class AppState {
  constructor() {
    this.data = this.load();
  }

  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        
        // Migrate defaultGaps / defaultGap
        let defaultGaps = [5];
        if (Array.isArray(parsed.defaultGaps) && parsed.defaultGaps.length > 0) {
          defaultGaps = Array.from(new Set(parsed.defaultGaps.map(Number))).sort((a, b) => a - b);
        } else if (typeof parsed.defaultGap === 'number') {
          defaultGaps = [parsed.defaultGap];
        }

        // Migrate history entries (gap -> gaps)
        const history = (Array.isArray(parsed.history) ? parsed.history : []).map(entry => {
          let gaps = [5];
          if (Array.isArray(entry.gaps) && entry.gaps.length > 0) {
            gaps = Array.from(new Set(entry.gaps.map(Number))).sort((a, b) => a - b);
          } else if (typeof entry.gap === 'number' || typeof entry.gap === 'string') {
            gaps = [parseInt(entry.gap, 10) || 5];
          }
          return {
            ...entry,
            gaps
          };
        });

        return {
          householdName: parsed.householdName || DEFAULT_STATE.householdName,
          userName: parsed.userName || DEFAULT_STATE.userName,
          defaultGaps: defaultGaps,
          history: history
        };
      }
    } catch (e) {
      console.warn('JalCycle: Failed to parse localStorage data, starting fresh.', e);
    }
    return JSON.parse(JSON.stringify(DEFAULT_STATE));
  }

  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
    } catch (e) {
      console.error('JalCycle: Storage save error', e);
    }
  }

  // Get history reverse-chronologically sorted by date
  getSortedHistory() {
    return [...this.data.history].sort((a, b) => {
      const diff = DateUtils.diffDays(b.date, a.date);
      if (diff !== 0) return diff;
      return (b.createdAt || 0) - (a.createdAt || 0);
    });
  }

  addHistoryEntry(entry) {
    let gaps = [5];
    if (Array.isArray(entry.gaps) && entry.gaps.length > 0) {
      gaps = Array.from(new Set(entry.gaps.map(Number))).sort((a, b) => a - b);
    } else if (entry.gap) {
      gaps = [parseInt(entry.gap, 10) || 5];
    } else {
      gaps = [...(this.data.defaultGaps || [5])];
    }

    const newEntry = {
      id: entry.id || 'log_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      date: entry.date,
      gaps: gaps,
      note: entry.note || '',
      loggedBy: entry.loggedBy || this.data.userName || 'Family Member',
      createdAt: Date.now()
    };
    this.data.history.push(newEntry);
    this.save();
    return newEntry;
  }

  updateHistoryEntry(id, updatedFields) {
    const idx = this.data.history.findIndex(item => item.id === id);
    if (idx !== -1) {
      let fieldsToUpdate = { ...updatedFields };
      if (Array.isArray(fieldsToUpdate.gaps) && fieldsToUpdate.gaps.length > 0) {
        fieldsToUpdate.gaps = Array.from(new Set(fieldsToUpdate.gaps.map(Number))).sort((a, b) => a - b);
      }
      this.data.history[idx] = {
        ...this.data.history[idx],
        ...fieldsToUpdate
      };
      this.save();
      return true;
    }
    return false;
  }

  deleteHistoryEntry(id) {
    this.data.history = this.data.history.filter(item => item.id !== id);
    this.save();
  }

  clearAllData() {
    this.data = JSON.parse(JSON.stringify(DEFAULT_STATE));
    this.save();
  }

  // Calculate statistics and predictions
  getPrediction() {
    const history = this.getSortedHistory();
    if (history.length === 0) {
      return { hasData: false };
    }

    const latest = history[0];
    const lastArrivalDate = latest.date;

    const selectedGaps = (Array.isArray(latest.gaps) && latest.gaps.length > 0) 
      ? Array.from(new Set(latest.gaps.map(Number))).sort((a, b) => a - b)
      : [parseInt(latest.gap, 10) || 5];

    const minGap = selectedGaps[0];
    const maxGap = selectedGaps[selectedGaps.length - 1];
    const isRange = selectedGaps.length > 1;

    const earliestExpectedDate = DateUtils.addDays(lastArrivalDate, minGap);
    const latestExpectedDate = DateUtils.addDays(lastArrivalDate, maxGap);

    const likelyStart = DateUtils.addDays(lastArrivalDate, minGap);
    const likelyEnd = DateUtils.addDays(lastArrivalDate, maxGap);

    const todayStr = DateUtils.getTodayStr();
    const daysLeftToEarliest = DateUtils.diffDays(earliestExpectedDate, todayStr);
    const daysLeftToLatest = DateUtils.diffDays(latestExpectedDate, todayStr);
    const daysElapsed = DateUtils.diffDays(todayStr, lastArrivalDate);

    let statusCategory = 'normal'; // normal, today, overdue
    let mainCountdownText = '';
    let subCountdownText = '';
    let expectedDateText = '';

    if (!isRange) {
      // Single Gap logic (BYTE-FOR-BYTE IDENTICAL TO PREVIOUS FLOW)
      expectedDateText = DateUtils.formatNice(earliestExpectedDate);
      if (daysLeftToEarliest > 1) {
        statusCategory = 'normal';
        mainCountdownText = `${daysLeftToEarliest} Days`;
        subCountdownText = 'to go';
      } else if (daysLeftToEarliest === 1) {
        statusCategory = 'normal';
        mainCountdownText = 'Tomorrow';
        subCountdownText = 'expected next';
      } else if (daysLeftToEarliest === 0) {
        statusCategory = 'today';
        mainCountdownText = 'TODAY';
        subCountdownText = 'water expected!';
      } else {
        statusCategory = 'overdue';
        const overdueDays = Math.abs(daysLeftToEarliest);
        mainCountdownText = overdueDays === 1 ? 'Overdue 1 Day' : `Overdue ${overdueDays} Days`;
        subCountdownText = 'expected earlier';
      }
    } else {
      // Multi-Gap Window logic
      const earliestNice = DateUtils.formatNice(earliestExpectedDate);
      const latestNice = DateUtils.formatNice(latestExpectedDate);
      expectedDateText = `${earliestNice} – ${latestNice}`;

      if (daysLeftToEarliest > 1) {
        statusCategory = 'normal';
        mainCountdownText = `Earliest in ${daysLeftToEarliest}d`;
        subCountdownText = `latest in ${daysLeftToLatest} days`;
      } else if (daysLeftToEarliest === 1) {
        statusCategory = 'normal';
        mainCountdownText = 'Earliest Tomorrow';
        subCountdownText = `latest in ${daysLeftToLatest} days`;
      } else if (daysLeftToEarliest === 0) {
        statusCategory = 'today';
        mainCountdownText = 'Window Opens TODAY';
        subCountdownText = `latest on ${DateUtils.formatShort(latestExpectedDate)}`;
      } else if (daysLeftToEarliest < 0 && daysLeftToLatest >= 0) {
        statusCategory = 'today';
        mainCountdownText = 'In Window Now';
        subCountdownText = `until ${DateUtils.formatShort(latestExpectedDate)}`;
      } else { // latestExpectedDate < today
        statusCategory = 'overdue';
        const overdueDays = Math.abs(daysLeftToLatest);
        mainCountdownText = overdueDays === 1 ? 'Overdue 1 Day' : `Overdue ${overdueDays} Days`;
        subCountdownText = `window closed on ${DateUtils.formatShort(latestExpectedDate)}`;
      }
    }

    return {
      hasData: true,
      lastArrivalDate,
      lastLoggedBy: latest.loggedBy,
      selectedGaps,
      isRange,
      minGap,
      maxGap,
      earliestExpectedDate,
      latestExpectedDate,
      nextExpectedDate: earliestExpectedDate,
      likelyStart,
      likelyEnd,
      daysLeft: daysLeftToEarliest,
      daysLeftToEarliest,
      daysLeftToLatest,
      daysElapsed,
      statusCategory,
      mainCountdownText,
      subCountdownText,
      expectedDateText
    };
  }

  // Calculate most frequent gap(s) across history
  getMostCommonGaps() {
    if (this.data.history.length === 0) return [...(this.data.defaultGaps || [5])];
    const counts = {};
    this.data.history.forEach(item => {
      const gaps = item.gaps || [item.gap || 5];
      gaps.forEach(g => {
        const num = parseInt(g, 10) || 5;
        counts[num] = (counts[num] || 0) + 1;
      });
    });

    let maxCount = 0;
    Object.keys(counts).forEach(g => {
      if (counts[g] > maxCount) {
        maxCount = counts[g];
      }
    });

    const mostCommon = Object.keys(counts)
      .filter(g => counts[g] === maxCount)
      .map(Number)
      .sort((a, b) => a - b);

    return mostCommon.length > 0 ? mostCommon : [...(this.data.defaultGaps || [5])];
  }

  // Calculate average gap across history
  getAverageGap() {
    if (this.data.history.length === 0) return 0;
    let sum = 0;
    let count = 0;
    this.data.history.forEach(item => {
      const gaps = item.gaps || [item.gap || 5];
      gaps.forEach(g => {
        sum += (parseInt(g, 10) || 5);
        count++;
      });
    });
    return count > 0 ? (sum / count).toFixed(1) : 0;
  }
}

// Global App State Singleton
const appState = new AppState();

// --- UI CONTROLLER & VIEW RENDERING ---
class UIController {
  constructor() {
    this.currentLogGaps = [...(appState.data.defaultGaps || [5])];
    this.currentEditGaps = [5];
    this.pendingConfirmAction = null;
    this.lastCheckedDate = DateUtils.getTodayStr();
  }

  init() {
    this.bindEvents();
    this.checkUrlHashSync();
    this.renderAll();
    this.setupRolloverTimer();
  }

  bindEvents() {
    // Tab Navigation
    document.querySelectorAll('.nav-item').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const tabId = btn.getAttribute('data-tab');
        this.switchTab(tabId);
      });
    });

    // Primary CTA: Water Came Today
    const btnWaterCame = document.getElementById('btn-water-came');
    if (btnWaterCame) {
      btnWaterCame.addEventListener('click', () => {
        this.openLogModal();
      });
    }

    // Secondary CTA: Water didn't come yet (+1d push)
    const btnWaterNoShow = document.getElementById('btn-water-noshow');
    if (btnWaterNoShow) {
      btnWaterNoShow.addEventListener('click', () => {
        this.handleNoShowPush();
      });
    }

    // Stale Alert actions
    document.getElementById('btn-stale-log')?.addEventListener('click', () => {
      this.openLogModal();
    });
    document.getElementById('btn-stale-dismiss')?.addEventListener('click', () => {
      document.getElementById('stale-alert-banner').style.display = 'none';
    });

    // Help Modal Open / Close
    document.getElementById('btn-open-help')?.addEventListener('click', () => {
      this.openModal('help-modal-overlay');
    });
    document.getElementById('btn-close-help-modal')?.addEventListener('click', () => {
      this.closeModal('help-modal-overlay');
    });
    document.getElementById('btn-help-gotit')?.addEventListener('click', () => {
      this.closeModal('help-modal-overlay');
    });

    // Log Modal Event Handlers
    document.getElementById('btn-close-log-modal')?.addEventListener('click', () => {
      this.closeModal('log-modal-overlay');
    });
    document.getElementById('btn-cancel-log')?.addEventListener('click', () => {
      this.closeModal('log-modal-overlay');
    });

    // Date Preset Pills in Log Modal
    document.getElementById('preset-today')?.addEventListener('click', () => {
      this.setLogDatePreset('today');
    });
    document.getElementById('preset-yesterday')?.addEventListener('click', () => {
      this.setLogDatePreset('yesterday');
    });

    // Multi-select Gap Chips in Log Modal
    document.querySelectorAll('#log-gap-chips .chip-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const gapVal = parseInt(btn.getAttribute('data-gap'), 10);
        if (this.currentLogGaps.includes(gapVal)) {
          this.currentLogGaps = this.currentLogGaps.filter(g => g !== gapVal);
        } else {
          this.currentLogGaps.push(gapVal);
          this.currentLogGaps.sort((a, b) => a - b);
        }
        this.updateLogModalChipUI();
      });
    });

    // Save Log Button
    document.getElementById('btn-save-log')?.addEventListener('click', () => {
      this.saveLogArrival();
    });

    // Edit Modal Handlers
    document.getElementById('btn-close-edit-modal')?.addEventListener('click', () => {
      this.closeModal('edit-modal-overlay');
    });
    document.getElementById('btn-cancel-edit')?.addEventListener('click', () => {
      this.closeModal('edit-modal-overlay');
    });
    document.querySelectorAll('#edit-gap-chips .chip-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const gapVal = parseInt(btn.getAttribute('data-gap'), 10);
        if (this.currentEditGaps.includes(gapVal)) {
          this.currentEditGaps = this.currentEditGaps.filter(g => g !== gapVal);
        } else {
          this.currentEditGaps.push(gapVal);
          this.currentEditGaps.sort((a, b) => a - b);
        }
        this.updateEditModalChipUI();
      });
    });
    document.getElementById('btn-save-edit')?.addEventListener('click', () => {
      this.saveEditArrival();
    });

    // Settings Profile Inputs
    const inputHousehold = document.getElementById('setting-household-name');
    if (inputHousehold) {
      inputHousehold.addEventListener('input', (e) => {
        appState.data.householdName = e.target.value.trim() || 'My Home';
        appState.save();
        document.getElementById('header-household-name').textContent = appState.data.householdName;
      });
    }

    const inputUser = document.getElementById('setting-user-name');
    if (inputUser) {
      inputUser.addEventListener('input', (e) => {
        appState.data.userName = e.target.value.trim() || 'Family Member';
        appState.save();
      });
    }

    // Settings Default Multi-Select Gap Chips
    document.querySelectorAll('#settings-gap-grid .chip-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const gapVal = parseInt(btn.getAttribute('data-gap'), 10);
        let defaults = appState.data.defaultGaps || [5];
        if (defaults.includes(gapVal)) {
          if (defaults.length > 1) {
            defaults = defaults.filter(g => g !== gapVal);
          }
        } else {
          defaults.push(gapVal);
          defaults.sort((a, b) => a - b);
        }
        appState.data.defaultGaps = defaults;
        appState.save();
        this.renderSettingsTab();
        this.showToast(`Default gaps updated: ${defaults.join(', ')} days`);
      });
    });

    // Settings Family Sync & Backup Handlers
    document.getElementById('btn-share-family')?.addEventListener('click', () => {
      this.shareFamilySync();
    });

    document.getElementById('btn-export-json')?.addEventListener('click', () => {
      this.exportJsonBackup();
    });

    const fileInput = document.getElementById('file-import-input');
    document.getElementById('btn-import-json')?.addEventListener('click', () => {
      fileInput.click();
    });
    fileInput?.addEventListener('change', (e) => {
      this.importJsonBackup(e);
    });

    document.getElementById('btn-clear-data')?.addEventListener('click', () => {
      this.promptConfirm(
        'Clear all JalCycle water records and settings? This cannot be undone.',
        () => {
          appState.clearAllData();
          this.renderAll();
          this.showToast('All data cleared');
        }
      );
    });

    // Confirmation Modal Buttons
    document.getElementById('btn-confirm-cancel')?.addEventListener('click', () => {
      this.closeModal('confirm-modal-overlay');
      this.pendingConfirmAction = null;
    });
    document.getElementById('btn-confirm-proceed')?.addEventListener('click', () => {
      if (typeof this.pendingConfirmAction === 'function') {
        this.pendingConfirmAction();
      }
      this.closeModal('confirm-modal-overlay');
      this.pendingConfirmAction = null;
    });

    // Visibility Change Listener for app focus regain
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        this.recheckDateRollover();
      }
    });
  }

  // Midnight rollover & stale check timer
  setupRolloverTimer() {
    setInterval(() => {
      const today = DateUtils.getTodayStr();
      if (today !== this.lastCheckedDate) {
        this.lastCheckedDate = today;
        this.renderAll();
      }
    }, 30000); // Check every 30 seconds
  }

  recheckDateRollover() {
    const today = DateUtils.getTodayStr();
    this.lastCheckedDate = today;
    this.renderAll();
  }

  switchTab(tabId) {
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));

    const navBtn = document.querySelector(`.nav-item[data-tab="${tabId}"]`);
    const panel = document.getElementById(tabId);

    if (navBtn && panel) {
      navBtn.classList.add('active');
      panel.classList.add('active');
      this.renderAll(); // Ensure fresh calculations on tab view
    }
  }

  openModal(overlayId) {
    const overlay = document.getElementById(overlayId);
    if (overlay) overlay.classList.add('active');
  }

  closeModal(overlayId) {
    const overlay = document.getElementById(overlayId);
    if (overlay) overlay.classList.remove('active');
  }

  promptConfirm(msg, onConfirm) {
    document.getElementById('confirm-modal-msg').textContent = msg;
    this.pendingConfirmAction = onConfirm;
    this.openModal('confirm-modal-overlay');
  }

  showToast(message) {
    const container = document.getElementById('toast-container');
    const msgEl = document.getElementById('toast-message');
    if (container && msgEl) {
      msgEl.textContent = message;
      container.classList.add('active');
      setTimeout(() => {
        container.classList.remove('active');
      }, 2600);
    }
  }

  // --- RENDER ALL VIEWS ---
  renderAll() {
    this.renderHeader();
    this.renderHeroCard();
    this.renderStaleAlert();
    this.renderCycleStrip();
    this.renderHistoryTab();
    this.renderSettingsTab();
  }

  renderHeader() {
    document.getElementById('header-household-name').textContent = appState.data.householdName || 'My Home';
  }

  renderHeroCard() {
    const heroCard = document.getElementById('hero-card');
    const emptyCard = document.getElementById('empty-state-card');
    const pred = appState.getPrediction();

    if (!pred.hasData) {
      if (heroCard) heroCard.style.display = 'none';
      if (emptyCard) emptyCard.style.display = 'block';
      return;
    }

    if (heroCard) heroCard.style.display = 'block';
    if (emptyCard) emptyCard.style.display = 'none';

    // Update Hero status classes
    heroCard.className = 'hero-card';
    if (pred.statusCategory === 'today') {
      heroCard.classList.add('is-today');
    } else if (pred.statusCategory === 'overdue') {
      heroCard.classList.add('is-overdue');
    }

    // Hero Badge Text
    const badgeTextEl = document.getElementById('hero-badge-text');
    if (badgeTextEl) {
      if (pred.statusCategory === 'today') {
        badgeTextEl.textContent = pred.isRange ? 'EXPECTED IN WINDOW' : 'WATER EXPECTED TODAY';
      } else if (pred.statusCategory === 'overdue') {
        badgeTextEl.textContent = 'WATER OVERDUE';
      } else {
        badgeTextEl.textContent = 'NEXT WATER EXPECTED';
      }
    }

    // Hero Date & Countdown
    document.getElementById('hero-countdown').textContent = pred.mainCountdownText;
    document.getElementById('hero-countdown-sub').textContent = pred.subCountdownText;
    document.getElementById('hero-expected-date').textContent = pred.expectedDateText;

    // Hero Likely Window Pill
    document.getElementById('hero-window-text').textContent = 
      `Likely window: ${DateUtils.formatShort(pred.likelyStart)} – ${DateUtils.formatShort(pred.likelyEnd)}`;

    // Hero Footer Last Info
    const gapsDisplay = pred.selectedGaps.join(', ');
    document.getElementById('hero-last-info').textContent = 
      `Last arrival: ${DateUtils.formatNice(pred.lastArrivalDate)} · logged by ${pred.lastLoggedBy || 'Family'} (${gapsDisplay}d gap)`;

    // SVG Circular Progress Ring Update (driven off earliest expected date)
    const circle = document.getElementById('gauge-circle');
    if (circle) {
      const radius = 50;
      const circumference = 2 * Math.PI * radius; // ~314.159
      let fraction = 0;
      if (pred.minGap > 0) {
        fraction = Math.min(1.0, Math.max(0, pred.daysElapsed / pred.minGap));
      }
      if (pred.daysLeftToEarliest <= 0) fraction = 1.0;

      const offset = circumference * (1 - fraction);
      circle.style.strokeDasharray = `${circumference}`;
      circle.style.strokeDashoffset = `${offset}`;

      if (pred.statusCategory === 'today') {
        circle.setAttribute('stroke', 'url(#todayGradient)');
      } else if (pred.statusCategory === 'overdue') {
        circle.setAttribute('stroke', 'url(#overdueGradient)');
      } else {
        circle.setAttribute('stroke', 'url(#gaugeGradient)');
      }
    }
  }

  renderStaleAlert() {
    const banner = document.getElementById('stale-alert-banner');
    const pred = appState.getPrediction();

    if (pred.hasData && pred.daysElapsed > (pred.maxGap + 3)) {
      document.getElementById('stale-desc').textContent = 
        `It's been ${pred.daysElapsed} days since water last arrived on ${DateUtils.formatShort(pred.lastArrivalDate)}. Did you forget to record a cycle?`;
      if (banner) banner.style.display = 'flex';
    } else {
      if (banner) banner.style.display = 'none';
    }
  }

  renderCycleStrip() {
    const container = document.getElementById('cycle-strip-container');
    const history = appState.getSortedHistory().slice(0, 6).reverse(); // Last 6 cycles chronologically
    const tag = document.getElementById('cycle-count-tag');

    if (tag) tag.textContent = `History (${appState.data.history.length})`;
    if (!container) return;

    if (history.length === 0) {
      container.innerHTML = '<div style="font-size: 0.8rem; color: var(--text-subtle); text-align: center; width: 100%; padding: 10px 0;">Log water arrivals to view recent cycle patterns.</div>';
      return;
    }

    let html = '';
    history.forEach(item => {
      const gaps = item.gaps || [item.gap || 5];
      const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      const heightPercent = Math.min(100, Math.max(25, (avgGap / 7) * 100));
      const shortDate = DateUtils.formatShort(item.date);
      const gapsStr = gaps.join(',');
      
      html += `
        <div class="strip-bar-col" title="${shortDate}: ${gapsStr} days gap">
          <div class="strip-bar-fill" style="height: ${heightPercent}%;"></div>
          <span class="strip-bar-label">${gapsStr}d</span>
        </div>
      `;
    });
    container.innerHTML = html;
  }

  renderHistoryTab() {
    const history = appState.getSortedHistory();
    
    // Summary Metrics
    document.getElementById('metric-total-logs').textContent = history.length;
    document.getElementById('metric-avg-gap').textContent = history.length > 0 ? `${appState.getAverageGap()}d` : '0d';
    const commonGaps = appState.getMostCommonGaps();
    document.getElementById('metric-common-gap').textContent = history.length > 0 ? `${commonGaps.join(',')}d` : '5d';
    document.getElementById('metric-cycle-num').textContent = `#${history.length + 1}`;

    const listContainer = document.getElementById('history-list-container');
    if (!listContainer) return;

    if (history.length === 0) {
      listContainer.innerHTML = '<div style="text-align: center; padding: 40px 20px; color: var(--text-muted); font-size: 0.88rem;">No arrival logs recorded yet.</div>';
      return;
    }

    let html = '';
    history.forEach((item, index) => {
      const parts = item.date.split('-').map(Number);
      const dayNum = parts[2] || 1;
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const monthStr = months[(parts[1] || 1) - 1];
      const weekday = DateUtils.getWeekday(item.date);
      const gapsStr = (item.gaps || [item.gap || 5]).join(', ');

      // Days elapsed from previous entry in history list
      let elapsedText = '';
      if (index < history.length - 1) {
        const prevItem = history[index + 1];
        const diff = DateUtils.diffDays(item.date, prevItem.date);
        elapsedText = ` · ${diff}d since previous`;
      }

      const noteText = item.note ? `"${item.note}"` : '';

      html += `
        <div class="history-item-card" data-id="${item.id}">
          <div class="history-left">
            <div class="history-date-box">
              <span class="history-date-day">${dayNum}</span>
              <span class="history-date-month">${monthStr}</span>
            </div>
            <div class="history-details">
              <div class="history-title-row">
                <span class="history-weekday">${weekday}</span>
                <span class="history-gap-chip">${gapsStr}d gap</span>
              </div>
              <div class="history-sub-info">
                By ${item.loggedBy || 'Family'}${elapsedText} ${noteText ? ' · ' + noteText : ''}
              </div>
            </div>
          </div>
          <div class="history-actions">
            <button class="action-icon-btn edit-btn" onclick="uiController.openEditModal('${item.id}')" title="Edit">
              <svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <button class="action-icon-btn delete-btn" onclick="uiController.promptDelete('${item.id}')" title="Delete">
              <svg viewBox="0 0 24 24" fill="none" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </button>
          </div>
        </div>
      `;
    });

    listContainer.innerHTML = html;
  }

  renderSettingsTab() {
    document.getElementById('setting-household-name').value = appState.data.householdName || '';
    document.getElementById('setting-user-name').value = appState.data.userName || '';

    // Selected multi-gap chips for default settings
    const defGaps = appState.data.defaultGaps || [5];
    document.querySelectorAll('#settings-gap-grid .chip-btn').forEach(btn => {
      const g = parseInt(btn.getAttribute('data-gap'), 10);
      btn.classList.toggle('selected', defGaps.includes(g));
    });
  }

  // --- LOG MODAL LOGIC ---
  openLogModal() {
    const today = DateUtils.getTodayStr();
    const dateInput = document.getElementById('log-input-date');
    if (dateInput) {
      dateInput.value = today;
      dateInput.max = today; // Block future dates
    }
    this.setLogDatePreset('today');

    // Pre-select most common gaps from history (or default gaps)
    const recGaps = appState.getMostCommonGaps();
    this.currentLogGaps = [...recGaps];
    this.updateLogModalChipUI();

    document.getElementById('log-input-name').value = appState.data.userName || '';
    document.getElementById('log-input-note').value = '';

    this.openModal('log-modal-overlay');
  }

  updateLogModalChipUI() {
    const btnSave = document.getElementById('btn-save-log');
    if (btnSave) {
      btnSave.disabled = (this.currentLogGaps.length === 0);
    }

    const recGaps = appState.getMostCommonGaps();

    document.querySelectorAll('#log-gap-chips .chip-btn').forEach(btn => {
      const g = parseInt(btn.getAttribute('data-gap'), 10);
      const isSelected = this.currentLogGaps.includes(g);
      btn.classList.toggle('selected', isSelected);

      // Recommended dot
      btn.querySelectorAll('.chip-recommended-dot').forEach(d => d.remove());
      if (recGaps.includes(g) && appState.data.history.length > 0) {
        const dot = document.createElement('div');
        dot.className = 'chip-recommended-dot';
        dot.title = 'Most frequent cycle gap';
        btn.appendChild(dot);
      }
    });
  }

  setLogDatePreset(preset) {
    const btnToday = document.getElementById('preset-today');
    const btnYesterday = document.getElementById('preset-yesterday');
    const dateInput = document.getElementById('log-input-date');

    if (preset === 'today') {
      btnToday?.classList.add('active');
      btnYesterday?.classList.remove('active');
      if (dateInput) dateInput.value = DateUtils.getTodayStr();
    } else {
      btnToday?.classList.remove('active');
      btnYesterday?.classList.add('active');
      if (dateInput) dateInput.value = DateUtils.getYesterdayStr();
    }
  }

  saveLogArrival() {
    if (this.currentLogGaps.length === 0) {
      this.showToast('Please select at least one possible gap day!');
      return;
    }

    const dateVal = document.getElementById('log-input-date').value;
    const nameVal = document.getElementById('log-input-name').value.trim() || appState.data.userName || 'Family Member';
    const noteVal = document.getElementById('log-input-note').value.trim();
    const today = DateUtils.getTodayStr();

    if (!dateVal) {
      this.showToast('Please select a valid arrival date');
      return;
    }

    if (DateUtils.diffDays(dateVal, today) > 0) {
      this.showToast('Arrival date cannot be in the future!');
      return;
    }

    // Save history entry with deduplicated gaps array
    appState.addHistoryEntry({
      date: dateVal,
      gaps: this.currentLogGaps,
      note: noteVal,
      loggedBy: nameVal
    });

    // Save updated user name if changed
    appState.data.userName = nameVal;
    appState.save();

    this.triggerDropletParticle();
    this.closeModal('log-modal-overlay');
    this.renderAll();
    this.showToast('💧 Water arrival recorded!');
  }

  // --- "WATER DIDN'T COME YET (+1D PUSH)" ACTION ---
  handleNoShowPush() {
    const history = appState.getSortedHistory();
    if (history.length === 0) {
      this.showToast('No history records to update. Tap "Water Came Today" first.');
      return;
    }

    const latest = history[0];
    const currentGaps = (Array.isArray(latest.gaps) && latest.gaps.length > 0) 
      ? latest.gaps 
      : [parseInt(latest.gap, 10) || 5];

    // Shift entire window forward by +1 day
    const newGaps = currentGaps.map(g => g + 1);

    appState.updateHistoryEntry(latest.id, {
      gaps: newGaps,
      note: latest.note ? `${latest.note} (Delayed +1d)` : 'Delayed +1d push'
    });

    this.renderAll();
    const pred = appState.getPrediction();
    this.showToast(`Pushed expected window forward by +1 day`);
  }

  // --- EDIT MODAL LOGIC ---
  openEditModal(id) {
    const entry = appState.data.history.find(item => item.id === id);
    if (!entry) return;

    document.getElementById('edit-entry-id').value = entry.id;
    const dateInput = document.getElementById('edit-input-date');
    if (dateInput) {
      dateInput.value = entry.date;
      dateInput.max = DateUtils.getTodayStr();
    }

    this.currentEditGaps = (Array.isArray(entry.gaps) && entry.gaps.length > 0) 
      ? [...entry.gaps] 
      : [parseInt(entry.gap, 10) || 5];

    this.updateEditModalChipUI();

    document.getElementById('edit-input-name').value = entry.loggedBy || '';
    document.getElementById('edit-input-note').value = entry.note || '';

    this.openModal('edit-modal-overlay');
  }

  updateEditModalChipUI() {
    const btnSave = document.getElementById('btn-save-edit');
    if (btnSave) {
      btnSave.disabled = (this.currentEditGaps.length === 0);
    }

    document.querySelectorAll('#edit-gap-chips .chip-btn').forEach(btn => {
      const g = parseInt(btn.getAttribute('data-gap'), 10);
      btn.classList.toggle('selected', this.currentEditGaps.includes(g));
    });
  }

  saveEditArrival() {
    if (this.currentEditGaps.length === 0) {
      this.showToast('Please select at least one gap day!');
      return;
    }

    const id = document.getElementById('edit-entry-id').value;
    const dateVal = document.getElementById('edit-input-date').value;
    const nameVal = document.getElementById('edit-input-name').value.trim();
    const noteVal = document.getElementById('edit-input-note').value.trim();
    const today = DateUtils.getTodayStr();

    if (!dateVal) {
      this.showToast('Please select a valid date');
      return;
    }
    if (DateUtils.diffDays(dateVal, today) > 0) {
      this.showToast('Arrival date cannot be in the future!');
      return;
    }

    appState.updateHistoryEntry(id, {
      date: dateVal,
      gaps: this.currentEditGaps,
      loggedBy: nameVal,
      note: noteVal
    });

    this.closeModal('edit-modal-overlay');
    this.renderAll();
    this.showToast('Record updated successfully');
  }

  promptDelete(id) {
    this.promptConfirm('Delete this water arrival record?', () => {
      appState.deleteHistoryEntry(id);
      this.renderAll();
      this.showToast('Record deleted');
    });
  }

  // --- FAMILY SYNC & BACKUP ---
  shareFamilySync() {
    const payload = {
      v: 1,
      hName: appState.data.householdName,
      uName: appState.data.userName,
      history: appState.data.history
    };
    const jsonStr = JSON.stringify(payload);
    const b64 = btoa(encodeURIComponent(jsonStr));
    const shareUrl = `${window.location.origin}${window.location.pathname}#sync=${b64}`;

    const text = `💧 *JalCycle Family Water Log Sync*\nHousehold: ${appState.data.householdName}\nTap this link to sync water arrival logs on your phone:\n${shareUrl}`;

    if (navigator.share) {
      navigator.share({
        title: 'JalCycle Family Sync',
        text: text,
        url: shareUrl
      }).catch(() => {
        this.fallbackCopyLink(shareUrl);
      });
    } else {
      this.fallbackCopyLink(shareUrl);
    }
  }

  fallbackCopyLink(shareUrl) {
    navigator.clipboard.writeText(shareUrl).then(() => {
      this.showToast('Family sync link copied to clipboard!');
    }).catch(() => {
      window.prompt('Copy this sync link to send to family:', shareUrl);
    });
  }

  checkUrlHashSync() {
    const hash = window.location.hash;
    if (hash && hash.startsWith('#sync=')) {
      try {
        const b64 = hash.substring(6);
        const jsonStr = decodeURIComponent(atob(b64));
        const payload = JSON.parse(jsonStr);
        if (payload && Array.isArray(payload.history) && payload.history.length > 0) {
          setTimeout(() => {
            this.promptConfirm(
              `Import ${payload.history.length} family water log(s) shared by ${payload.uName || 'Family'} (${payload.hName || 'Household'})?`,
              () => {
                let importedCount = 0;
                payload.history.forEach(newItem => {
                  let newGaps = Array.isArray(newItem.gaps) ? newItem.gaps : [newItem.gap || 5];
                  const exists = appState.data.history.some(existing => {
                    const existingGaps = Array.isArray(existing.gaps) ? existing.gaps : [existing.gap || 5];
                    return existing.id === newItem.id || (existing.date === newItem.date && existingGaps.join(',') === newGaps.join(','));
                  });
                  if (!exists) {
                    appState.data.history.push({
                      ...newItem,
                      gaps: newGaps
                    });
                    importedCount++;
                  }
                });

                if (payload.hName) appState.data.householdName = payload.hName;
                appState.save();

                window.location.hash = ''; // Clear hash
                this.renderAll();
                this.showToast(`Merged ${importedCount} family log(s)!`);
              }
            );
          }, 400);
        }
      } catch (e) {
        console.warn('JalCycle: Invalid URL sync hash', e);
      }
    }
  }

  exportJsonBackup() {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(appState.data, null, 2));
    const downloadAnchor = document.createElement('a');
    const dateTag = DateUtils.getTodayStr();
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", `jalcycle-backup-${dateTag}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
    this.showToast('Backup JSON exported');
  }

  importJsonBackup(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const parsed = JSON.parse(e.target.result);
        if (parsed && Array.isArray(parsed.history)) {
          const migratedHistory = parsed.history.map(item => ({
            ...item,
            gaps: Array.isArray(item.gaps) ? item.gaps : [parseInt(item.gap, 10) || 5]
          }));

          appState.data = {
            householdName: parsed.householdName || appState.data.householdName,
            userName: parsed.userName || appState.data.userName,
            defaultGaps: Array.isArray(parsed.defaultGaps) ? parsed.defaultGaps : [parsed.defaultGap || 5],
            history: migratedHistory
          };
          appState.save();
          this.renderAll();
          this.showToast('Backup data imported successfully!');
        } else {
          this.showToast('Invalid JalCycle backup JSON file');
        }
      } catch (err) {
        this.showToast('Failed to parse JSON file');
      }
    };
    reader.readAsText(file);
    event.target.value = ''; // Reset input
  }

  // Visual Droplet Splash Particle Interaction
  triggerDropletParticle() {
    const overlay = document.getElementById('ripple-overlay');
    if (!overlay) return;

    for (let i = 0; i < 6; i++) {
      const particle = document.createElement('div');
      particle.className = 'droplet-particle';
      particle.style.left = `${50 + (Math.random() * 40 - 20)}%`;
      particle.style.top = `${60 + (Math.random() * 20 - 10)}%`;
      particle.style.animationDelay = `${i * 0.08}s`;
      overlay.appendChild(particle);

      setTimeout(() => particle.remove(), 1000);
    }
  }
}

// Global UI Controller Singleton Instance
let uiController;

document.addEventListener('DOMContentLoaded', () => {
  uiController = new UIController();
  uiController.init();
});
