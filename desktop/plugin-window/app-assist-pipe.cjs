const { randomUUID } = require('node:crypto');

function createAppAssistOwnerPipe(write) {
  const pending = new Map();
  let ended = false;
  function request(command) {
    if (ended || pending.size >= 4) return Promise.reject(new Error('App-assist owner unavailable'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('App-assist owner unavailable'));
      }, 3000);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      write(`${JSON.stringify({ v: 1, type: 'app_assist', id, command })}\n`, (error) => {
        if (!error || !pending.has(id)) return;
        pending.delete(id);
        clearTimeout(timer);
        reject(new Error('App-assist owner unavailable'));
      });
    });
  }
  return {
    read: () => request({ kind: 'read' }),
    claim: (appKey) => request({ kind: 'claim', appKey }),
    accept(frame) {
      if (
        !frame ||
        frame.v !== 1 ||
        frame.type !== 'app_assist' ||
        Object.keys(frame).sort().join(',') !== 'id,reply,type,v'
      )
        throw new Error('Invalid app-assist owner reply');
      const call = pending.get(frame.id);
      if (!call) return;
      pending.delete(frame.id);
      clearTimeout(call.timer);
      call.resolve(frame.reply);
    },
    close() {
      ended = true;
      for (const call of pending.values()) {
        clearTimeout(call.timer);
        call.reject(new Error('App-assist owner closed'));
      }
      pending.clear();
    },
  };
}
module.exports = { createAppAssistOwnerPipe };
