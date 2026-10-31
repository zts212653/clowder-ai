const { randomUUID } = require('node:crypto');

function createCompanionPipe(write) {
  const pending = new Map();
  let ended = false;
  return {
    request(command) {
      if (ended || pending.size >= 16) return Promise.resolve({ kind: 'error', code: 'unavailable' });
      const id = randomUUID();
      const frame = JSON.stringify({ v: 1, type: 'companion', id, command });
      if (Buffer.byteLength(frame) > 1_500_000) return Promise.resolve({ kind: 'error', code: 'invalid_request' });
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve({ kind: 'error', code: 'unavailable' });
        }, 70_000);
        timer.unref();
        pending.set(id, { resolve, timer });
        write(`${frame}\n`, (error) => {
          if (!error) return;
          const request = pending.get(id);
          pending.delete(id);
          clearTimeout(timer);
          request?.resolve({ kind: 'error', code: 'unavailable' });
        });
      });
    },
    accept(frame) {
      if (
        !frame ||
        frame.v !== 1 ||
        frame.type !== 'companion' ||
        Object.keys(frame).sort().join(',') !== 'id,reply,type,v'
      )
        throw new Error('Invalid companion reply');
      const request = pending.get(frame.id);
      if (!request) return; // A late answer to an expired request cannot revive its context.
      pending.delete(frame.id);
      clearTimeout(request.timer);
      request.resolve(frame.reply);
    },
    close() {
      ended = true;
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.resolve({ kind: 'error', code: 'cancelled' });
      }
      pending.clear();
    },
  };
}
module.exports = { createCompanionPipe };
