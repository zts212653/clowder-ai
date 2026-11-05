const { spawn } = require('node:child_process');
const { join } = require('node:path');
const { validApplication } = require('./app-assist-validation.cjs');

// Fixed Host-owned binary; neither plugin nor renderer can choose an executable or arguments.
function createNativeAppAssistSource(onEvent, onLost, { platform = process.platform, spawnProcess = spawn } = {}) {
  if (platform !== 'darwin') return Promise.reject(Object.assign(new Error('Unsupported'), { code: 'unsupported' }));
  return new Promise((resolve, reject) => {
    const child = spawnProcess(join(__dirname, 'native/app-assist'), ['--observe'], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: {},
    });
    let ready = false;
    let closing = false;
    let ended = false;
    let buffer = Buffer.alloc(0);
    let resolveExit;
    const exited = new Promise((done) => {
      resolveExit = done;
    });
    const timer = setTimeout(() => fail(), 3000);
    timer.unref?.();
    function fail() {
      if (ended || closing) return;
      if (!ready) reject(new Error('App-assist source unavailable'));
      else onLost();
      void close();
    }
    async function close() {
      if (!closing && !ended) {
        closing = true;
        clearTimeout(timer);
        child.stdin.end(); // EOF unregisters the observer and exits the owned helper.
        const kill = setTimeout(() => child.kill('SIGTERM'), 1000);
        kill.unref?.();
        try {
          await exited;
        } finally {
          clearTimeout(kill);
        }
      }
      await exited;
    }
    child.once('error', () => {
      clearTimeout(timer);
      ended = true;
      resolveExit();
      if (!ready) reject(new Error('App-assist source unavailable'));
      else if (!closing) onLost();
    });
    child.once('exit', () => {
      clearTimeout(timer);
      ended = true;
      resolveExit();
      if (!ready) reject(new Error('App-assist source unavailable'));
      else if (!closing) onLost();
    });
    child.stdin.on('error', fail);
    child.stdout.on('data', (chunk) => {
      if (closing || ended) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 4096) {
        fail();
        return;
      }
      for (;;) {
        const newline = buffer.indexOf(10);
        if (newline < 0) break;
        const line = buffer.subarray(0, newline);
        buffer = buffer.subarray(newline + 1);
        try {
          const value = JSON.parse(line.toString('utf8'));
          if (!ready) {
            if (Object.keys(value).join(',') !== 'kind' || value.kind !== 'ready') throw new Error('Protocol');
            ready = true;
            clearTimeout(timer);
            resolve({ close });
          } else {
            if (!validApplication(value)) throw new Error('Protocol');
            void Promise.resolve(onEvent(value)).catch(fail);
          }
        } catch {
          fail();
          return;
        }
      }
    });
  });
}
module.exports = { createNativeAppAssistSource };
