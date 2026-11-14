const { randomUUID } = require('node:crypto');

/** Same shape as the app-assist owner pipe; an add may run an action, so it gets more time than a read. */
const DESK_OWNER_TIMEOUT_MS = 15_000;

function createDeskOwnerPipe(write, { timeoutMs = DESK_OWNER_TIMEOUT_MS } = {}) {
  const pending = new Map();
  let ended = false;
  function request(command) {
    if (ended || pending.size >= 4) return Promise.reject(new Error('Desk owner unavailable'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('Desk owner unavailable'));
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      write(`${JSON.stringify({ v: 1, type: 'desk', id, command })}\n`, (error) => {
        if (!error || !pending.has(id)) return;
        pending.delete(id);
        clearTimeout(timer);
        reject(new Error('Desk owner unavailable'));
      });
    });
  }
  return {
    next: (returning) => request({ kind: 'next', returning: returning === true }),
    settle: (settle) => request({ kind: 'settle', settle }),
    avatar: (catId) => request({ kind: 'avatar', catId }),
    accept(frame) {
      if (!frame || frame.v !== 1 || frame.type !== 'desk' || Object.keys(frame).sort().join(',') !== 'id,reply,type,v')
        throw new Error('Invalid desk owner reply');
      const call = pending.get(frame.id);
      if (!call) return;
      pending.delete(frame.id);
      clearTimeout(call.timer);
      if (frame.reply === 'unavailable') call.reject(new Error('Desk owner unavailable'));
      else call.resolve(frame.reply);
    },
    close() {
      ended = true;
      for (const call of pending.values()) {
        clearTimeout(call.timer);
        call.reject(new Error('Desk owner closed'));
      }
      pending.clear();
    },
  };
}
module.exports = { createDeskOwnerPipe, DESK_OWNER_TIMEOUT_MS };
