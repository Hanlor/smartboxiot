/**
 * GAMIFICATION — Loyalty Points + Lucky Wheel + Badges
 * Lưu state vào localStorage, không cần backend.
 */
(function() {
  'use strict';

  const KEY = 'smartbox_gamification';
  const DEFAULT_STATE = {
    points: 0,
    totalTransactions: 0,
    spinTickets: 0,      // số lượt quay chưa dùng
    history: [],         // log hành động
    nickname: '',
  };

  // ═══════════════════════════════════════════════════════
  // STATE MANAGEMENT
  // ═══════════════════════════════════════════════════════
  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? { ...DEFAULT_STATE, ...JSON.parse(raw) } : { ...DEFAULT_STATE };
    } catch (e) {
      return { ...DEFAULT_STATE };
    }
  }

  function save(state) {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
      window.dispatchEvent(new CustomEvent('gamification:update', { detail: state }));
    } catch (e) {}
  }

  let state = load();

  // ═══════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════
  window.Gamification = {
    getState: () => ({ ...state }),

    // Ghi điểm khi giao dịch thành công
    addTransaction: function(type) {
      state.totalTransactions += 1;
      state.points += 10;
      state.spinTickets += 1;

      state.history.unshift({
        type: 'transaction',
        subType: type, // 'send' | 'receive'
        at: Date.now(),
        points: 10,
      });
      if (state.history.length > 30) state.history.length = 30;

      save(state);
      return state;
    },

    // Quay số — trả về kết quả
    spin: function() {
      if (state.spinTickets <= 0) return null;

      const PRIZES = [
        { label: '+5 điểm',   points: 5,   weight: 50, color: '#94A3B8' },
        { label: '+20 điểm',  points: 20,  weight: 30, color: '#3B82F6' },
        { label: '+50 điểm',  points: 50,  weight: 15, color: '#8B5CF6' },
        { label: '+100 điểm', points: 100, weight: 5,  color: '#F59E0B' },
      ];

      // Weighted random
      const total = PRIZES.reduce((s, p) => s + p.weight, 0);
      let r = Math.random() * total;
      let prize = PRIZES[0];
      for (const p of PRIZES) {
        if (r < p.weight) { prize = p; break; }
        r -= p.weight;
      }

      state.points += prize.points;
      state.spinTickets -= 1;
      state.history.unshift({
        type: 'spin',
        at: Date.now(),
        points: prize.points,
        label: prize.label,
      });
      if (state.history.length > 30) state.history.length = 30;

      save(state);
      return prize;
    },

    getPrizes: () => [
      { label: '+5',   points: 5,   weight: 50, color: '#94A3B8' },
      { label: '+20',  points: 20,  weight: 30, color: '#3B82F6' },
      { label: '+50',  points: 50,  weight: 15, color: '#8B5CF6' },
      { label: '+100', points: 100, weight: 5,  color: '#F59E0B' },
    ],

    // Level
    getLevel: function() {
      const p = state.points;
      if (p >= 300) return { name: 'Gold',   color: '#F59E0B', next: null,      progress: 100 };
      if (p >= 100) return { name: 'Silver', color: '#94A3B8', next: 300,       progress: ((p - 100) / 200) * 100 };
      return            { name: 'Bronze', color: '#B45309', next: 100,       progress: (p / 100) * 100 };
    },

    // Milestone
    getNextMilestone: function() {
      const p = state.points;
      if (p < 50)  return { at: 50,  reward: 'Giảm 50% lần gửi tiếp',  remaining: 50 - p };
      if (p < 100) return { at: 100, reward: 'MIỄN PHÍ 1 lần gửi',     remaining: 100 - p };
      if (p < 200) return { at: 200, reward: 'Tủ VIP 1 tháng',         remaining: 200 - p };
      if (p < 500) return { at: 500, reward: 'Voucher 100k + VIP',     remaining: 500 - p };
      return null;
    },

    reset: function() {
      state = { ...DEFAULT_STATE };
      save(state);
    },
  };

  // ═══════════════════════════════════════════════════════
  // UI HELPERS — Toast + Confetti nhỏ khi thắng
  // ═══════════════════════════════════════════════════════
  window.showPrizeToast = function(prize) {
    if (!window.showToast) return;
    window.showToast(
      `🎉 Chúc mừng! Bạn nhận <b style="color:#F59E0B">${prize.label}</b>`,
      'success',
      4500
    );
  };

  console.log('[Gamification] Loaded. Points:', state.points, 'Tickets:', state.spinTickets);
})();