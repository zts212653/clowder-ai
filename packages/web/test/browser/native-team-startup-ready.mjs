import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

export async function waitForNativeReady(file, pid, options = {}) {
  assert.ok(Number.isInteger(pid) && pid > 0, 'Supply the current owned Electron PID');
  const {
    read = () => fs.readFile(file, 'utf8').then(JSON.parse),
    sleep = delay,
    now = Date.now,
    timeoutMs = 190000,
  } = options;
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    let state;
    try {
      state = await read();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (state?.pid === pid) {
      assert.notEqual(state.phase, 'failed', `Installed startup failed: ${state.message}`);
      if (state.phase === 'ready') return state;
    }
    await sleep(100);
  }
  throw new Error('The current installed app never reported startup ready; do not navigate its loading window');
}
