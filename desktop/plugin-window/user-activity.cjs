'use strict';

/**
 * F335 交付三：「人回来了」。Host 私有，不进合同、不对插件开放。
 *
 * 只用两样：锁屏 / 休眠生命周期，和系统闲置秒数（距最近一次键盘或鼠标输入）。不采按键、窗口标题、屏幕内容。
 * - 不在：锁屏、休眠，或闲置满 `awayIdleSeconds`。
 * - 回来：不在之后，未锁屏、且出现了新的输入（闲置秒数降到 `activeIdleSeconds` 以内）。
 * - 唤醒（resume / DarkWake）本身不算：唤醒后 `resumeGraceMs` 内读到的「刚有输入」不认，之后的输入才算。
 * - 猫窗口自己抢到焦点不是输入，闲置秒数不变，所以不算。
 * - 读不到（没有 powerMonitor、返回 unknown 或抛错）就当不在；东西留着等下一次确定的回来。
 */
const DEFAULTS = {
  awayIdleSeconds: 5 * 60,
  activeIdleSeconds: 5,
  resumeGraceMs: 5000,
  pollMs: 2000,
};

function createUserActivity({
  powerMonitor,
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onChange = () => {},
  ...options
}) {
  const config = { ...DEFAULTS, ...options };
  let presence = 'unknown';
  let locked = false;
  let asleep = false;
  let resumedAt = null;
  let timer = null;
  let started = false;

  function readIdle() {
    if (!powerMonitor || typeof powerMonitor.getSystemIdleTime !== 'function') return null;
    try {
      const state =
        typeof powerMonitor.getSystemIdleState === 'function'
          ? powerMonitor.getSystemIdleState(config.awayIdleSeconds)
          : 'active';
      if (state === 'unknown') return null;
      if (state === 'locked') return { locked: true, idle: Number.POSITIVE_INFINITY };
      const idle = powerMonitor.getSystemIdleTime();
      return Number.isFinite(idle) && idle >= 0 ? { locked: false, idle } : null;
    } catch {
      return null;
    }
  }

  function set(next, returned) {
    if (next === presence && !returned) return;
    presence = next;
    onChange({ presence, returned });
  }

  function freshInput(idleSeconds) {
    if (idleSeconds > config.activeIdleSeconds) return false;
    if (resumedAt === null) return true;
    // The input must have happened after the grace window that follows a wake.
    return idleSeconds * 1000 < now() - resumedAt - config.resumeGraceMs;
  }

  function evaluate() {
    if (asleep) {
      set('away', false);
      return;
    }
    const read = readIdle();
    if (!read) {
      // Lost the signal: from then on we cannot tell, so they count as away until a clear return.
      if (presence !== 'unknown') set('away', false);
      return;
    }
    if (read.locked || locked || read.idle >= config.awayIdleSeconds) {
      set('away', false);
      return;
    }
    if (presence === 'present') return;
    if (presence === 'unknown') {
      // First reading after start: somebody is here, but they did not just come back.
      set('present', false);
      return;
    }
    if (freshInput(read.idle)) {
      resumedAt = null;
      set('present', true);
    }
  }

  function schedule() {
    if (!started) return;
    timer = setTimer(() => {
      timer = null;
      evaluate();
      schedule();
    }, config.pollMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  const listeners = {
    'lock-screen': () => {
      locked = true;
      set('away', false);
    },
    'unlock-screen': () => {
      locked = false;
      evaluate();
    },
    suspend: () => {
      asleep = true;
      set('away', false);
    },
    resume: () => {
      asleep = false;
      resumedAt = now();
      if (presence !== 'away') set('away', false);
    },
  };

  return {
    start() {
      if (started) return;
      started = true;
      if (powerMonitor && typeof powerMonitor.on === 'function') {
        for (const [event, listener] of Object.entries(listeners)) powerMonitor.on(event, listener);
      }
      evaluate();
      schedule();
    },
    stop() {
      if (!started) return;
      started = false;
      if (timer) clearTimer(timer);
      timer = null;
      if (powerMonitor && typeof powerMonitor.off === 'function') {
        for (const [event, listener] of Object.entries(listeners)) powerMonitor.off(event, listener);
      }
    },
    /** present | away | unknown. Anything but present means: do not bring things now. */
    presence: () => presence,
    /** Re-read now (tests, and the Host right after something new arrived). */
    check: evaluate,
  };
}

module.exports = { createUserActivity, USER_ACTIVITY_DEFAULTS: DEFAULTS };
