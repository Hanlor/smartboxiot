/**
 * Toast + Confetti + Helpers — dùng chung cho mọi trang
 */
(function() {
  'use strict';

  // ─── TOAST ───
  if (!document.getElementById('toast-container')) {
    const c = document.createElement('div');
    c.id = 'toast-container';
    document.body.appendChild(c);
  }

  const ICONS = {
    success: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
    error:   '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
    warning: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    info:    '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
  };

  window.showToast = function(message, type = 'info', duration = 3500) {
    const c = document.getElementById('toast-container');
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.innerHTML = `
      <svg class="toast-icon" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">
        ${ICONS[type] || ICONS.info}
      </svg>
      <div style="flex:1;line-height:1.4;">${message}</div>
    `;
    c.appendChild(t);
    setTimeout(() => {
      t.classList.add('removing');
      setTimeout(() => t.remove(), 300);
    }, duration);
  };

  // ─── CONFETTI ───
  window.fireConfetti = function(count = 60) {
    const colors = ['#6366F1', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#06B6D4'];
    for (let i = 0; i < count; i++) {
      const p = document.createElement('div');
      p.className = 'confetti-piece';
      p.style.left = Math.random() * 100 + 'vw';
      p.style.background = colors[Math.floor(Math.random() * colors.length)];
      p.style.animationDelay = Math.random() * 0.6 + 's';
      p.style.animationDuration = (2.5 + Math.random() * 1.5) + 's';
      const shape = Math.random();
      if (shape > 0.6) p.style.borderRadius = '50%';
      else if (shape > 0.3) p.style.width = '8px', p.style.height = '14px';
      document.body.appendChild(p);
      setTimeout(() => p.remove(), 4000);
    }
  };
  // ─── SOUND: phát tiếng "ting" khi OTP đến ───
  window.playNotificationSound = function() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();

      // Tạo 2 nốt: C5 (523Hz) → E5 (659Hz)
      const now = ctx.currentTime;

      [523.25, 659.25].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = 'sine';
        osc.frequency.value = freq;

        gain.gain.setValueAtTime(0, now + i * 0.12);
        gain.gain.linearRampToValueAtTime(0.3, now + i * 0.12 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.12 + 0.35);

        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + i * 0.12);
        osc.stop(now + i * 0.12 + 0.4);
      });

      setTimeout(() => ctx.close(), 800);
    } catch (e) {}
  };

  // ─── VIBRATE: rung điện thoại ───
  window.vibrateNotification = function(pattern) {
    if (navigator.vibrate) {
      navigator.vibrate(pattern || [100, 50, 100, 50, 200]);
    }
  };

  // ─── COMBO: Sound + Rung ───
  window.notifyUser = function() {
    window.playNotificationSound();
    window.vibrateNotification();
  };
  // ─── REPLACE ALERT GLOBALLY (không bắt buộc) ───
  // window.alert = (msg) => window.showToast(msg, 'info');
  // ═══════════════════════════════════════════════════════════
  // HISTORY — Lịch sử đơn hàng (localStorage)
  // ═══════════════════════════════════════════════════════════
  const HISTORY_KEY = 'smartbox_history';
  const HISTORY_MAX = 20;

  window.saveHistory = function(entry) {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      arr.unshift(entry);
      if (arr.length > HISTORY_MAX) arr.length = HISTORY_MAX;
      localStorage.setItem(HISTORY_KEY, JSON.stringify(arr));
      console.log('[History] Saved:', entry);
    } catch (e) {}
  };

  window.getHistory = function() {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
  };

  window.clearHistory = function() {
    try { localStorage.removeItem(HISTORY_KEY); } catch (e) {}
  };  
})();