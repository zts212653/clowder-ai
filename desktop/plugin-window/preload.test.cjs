const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

test('isolated preload derives activation itself and exposes no raw IPC or credentials', async () => {
  const calls = [];
  let surface;
  const activation = { isActive: false };
  vm.runInNewContext(readFileSync(join(__dirname, 'preload.cjs'), 'utf8'), {
    navigator: { userActivation: activation },
    require: () => ({
      contextBridge: {
        exposeInMainWorld: (_name, value) => {
          surface = value;
        },
      },
      ipcRenderer: {
        invoke: async (...args) => {
          calls.push(args);
          return { kind: 'ok' };
        },
        on() {},
        removeListener() {},
      },
    }),
  });
  await surface.request({ kind: 'prepare' }, true);
  assert.equal(calls[0][2], false, 'extra caller arguments cannot forge a trusted activation');
  activation.isActive = true;
  await surface.request({ kind: 'prepare' }, false);
  assert.equal(calls[1][2], true);
  assert.deepEqual(Object.keys(surface), ['request', 'subscribe']);
});
