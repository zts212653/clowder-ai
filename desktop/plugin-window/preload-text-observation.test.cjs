const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');

test('fixed Host preload stamps text submission before IPC, independent of renderer-nominated timing', async () => {
  let bridge;
  const calls = [];
  vm.runInNewContext(fs.readFileSync(require.resolve('./preload.cjs'), 'utf8'), {
    require: () => ({
      contextBridge: {
        exposeInMainWorld: (_name, value) => {
          bridge = value;
        },
      },
      ipcRenderer: {
        on() {},
        invoke: (...args) => {
          calls.push(args);
          return Promise.resolve({ kind: 'ok' });
        },
      },
    }),
    navigator: { userActivation: { isActive: true } },
    Date: { now: () => 123456789 },
  });
  await bridge.request({ kind: 'text', text: 'Compare the reports', clientMessageId: 'request', observedAt: 1 });
  assert.equal(
    calls[0][3],
    123456789,
    'the private timestamp is produced by Host code, not taken from the public command',
  );
  await bridge.request({ kind: 'settings.read' });
  assert.equal(calls[1][3], undefined, 'non-text commands cannot fabricate a text submission');
});
