export function wireFixture({ holdFirstTurn = false } = {}) {
  const queue = [];
  let waiting;
  let closed = false;
  const writes = [];
  let starts = 0;
  const push = (value) => {
    if (waiting) {
      const resolve = waiting;
      waiting = undefined;
      resolve({ value, done: false });
    } else queue.push(value);
  };
  const completed = (id, threadId = 'native') => ({
    method: 'turn/completed',
    params: { threadId, turn: { id, status: 'completed' } },
  });
  return {
    writes,
    push,
    completed,
    wire: {
      read: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () =>
            queue.length
              ? Promise.resolve({ value: queue.shift(), done: false })
              : closed
                ? Promise.resolve({ done: true })
                : new Promise((resolve) => {
                    waiting = resolve;
                  }),
        }),
      }),
      write: async (message) => {
        writes.push(message);
        if (message.method === 'config/read')
          push({ id: message.id, result: { config: { mcp_servers: { unapproved: { command: 'external' } } } } });
        if (message.method === 'initialize') push({ id: message.id, result: {} });
        if (message.method === 'thread/start') push({ id: message.id, result: { thread: { id: 'native' } } });
        if (message.method === 'thread/turns/list') push({ id: message.id, result: { data: [], nextCursor: null } });
        if (message.method === 'turn/start') {
          const id = ++starts === 1 ? 'first' : `turn-${starts}`;
          push({ id: message.id, result: { turn: { id } } });
          if (!holdFirstTurn || starts !== 1) push(completed(id));
        }
        if (message.method === 'turn/steer')
          push({ id: message.id, result: { turnId: message.params.expectedTurnId } });
        if (message.method === 'thread/realtime/appendText') push({ id: message.id, result: {} });
      },
      close: async () => {
        closed = true;
        waiting?.({ done: true });
      },
    },
  };
}
