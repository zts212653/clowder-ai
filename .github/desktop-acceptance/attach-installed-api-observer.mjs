import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { installApiObserverBridge } from './installed-api-observer-bridge.mjs';

export function verifyInspectorOwner(port, expectedPid, run = execFileSync) {
  assert.ok(Number.isSafeInteger(port) && port >= 1024 && port <= 65535);
  assert.ok(Number.isSafeInteger(expectedPid) && expectedPid > 0);
  const options = { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024, windowsHide: true };
  const owners =
    process.platform === 'win32'
      ? run(path.join(process.env.SystemRoot, 'System32/netstat.exe'), ['-ano', '-p', 'tcp'], options)
          .split(/\r?\n/)
          .map((line) => line.trim().split(/\s+/))
          .filter((fields) => fields[0] === 'TCP' && fields[1] === `127.0.0.1:${port}` && fields[3] === 'LISTENING')
          .map((fields) => Number(fields[4]))
      : run('/usr/sbin/lsof', ['-nP', '-a', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], options)
          .split(/\r?\n/)
          .filter((line) => /^p\d+$/.test(line))
          .map((line) => Number(line.slice(1)));
  assert.deepEqual([...new Set(owners)], [expectedPid], 'Inspector listener is not the owned main process');
}

export async function attachInstalledApiObserver(config) {
  const port = config.inspectorPort;
  assert.ok(Number.isSafeInteger(port) && port >= 1024 && port <= 65535);
  assert.ok(![3001, 3002, 3003, 3004, 6397, 6398, 6399].includes(port));
  let target;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(300) });
      assert.ok(response.ok);
      const targets = await response.json();
      assert.ok(Array.isArray(targets) && targets.length === 1);
      target = targets[0];
      break;
    } catch {
      await delay(100);
    }
  }
  assert.ok(target, 'Owned Electron main inspector did not become available');
  verifyInspectorOwner(port, config.expectedPid);
  const url = new URL(target.webSocketDebuggerUrl);
  assert.equal(url.protocol, 'ws:');
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.port, String(port));
  const socket = new WebSocket(url);
  const pending = new Map();
  let sequence = 0;
  let pauseResolve;
  let pauseTimer;
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Debugger.paused') pauseResolve?.(message.params);
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    clearTimeout(call.timer);
    if (message.error) call.reject(new Error(`${call.method}: inspector error`));
    else call.resolve(message.result);
  });
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method}: inspector deadline exceeded`));
      }, 5000);
      pending.set(id, { method, timer, resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Inspector connection timed out')), 5000);
      socket.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new Error('Inspector connection failed'));
        },
        { once: true },
      );
    });
    await call('Runtime.enable');
    await call('Debugger.enable');
    const paused = new Promise((resolve, reject) => {
      pauseTimer = setTimeout(() => reject(new Error('Main entry did not pause')), 5000);
      pauseResolve = (value) => {
        clearTimeout(pauseTimer);
        resolve(value);
      };
    });
    await call('Runtime.runIfWaitingForDebugger');
    const pause = await paused;
    assert.equal(pause.reason, 'Break on start');
    // The OS listener owner was checked first. JavaScript process globals only
    // become available at the first main-script pause; check them before injection.
    const identity = await call('Runtime.evaluate', {
      expression: '({pid:process.pid,type:process.type,executable:process.execPath})',
      returnByValue: true,
    });
    assert.ok(!identity.exceptionDetails);
    assert.equal(identity.result.value.pid, config.expectedPid);
    assert.equal(identity.result.value.type, 'browser');
    const canonical = (value) =>
      process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
    assert.equal(canonical(identity.result.value.executable), canonical(config.executable));
    const installed = await call('Runtime.evaluate', {
      expression: `(${installApiObserverBridge.toString()})(${JSON.stringify(config)})`,
      returnByValue: true,
    });
    if (installed.exceptionDetails) {
      const failure = new Error('Owned API observer bridge admission failed');
      failure.cause = installed.exceptionDetails.exception?.description ?? installed.exceptionDetails.text;
      throw failure;
    }
    assert.deepEqual(installed.result.value, { installed: true, mainPid: config.expectedPid, expectedApiSpawns: 1 });
    await call('Debugger.resume');
    return installed.result.value;
  } finally {
    clearTimeout(pauseTimer);
    pauseResolve = undefined;
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error('Inspector connection closed'));
    }
    pending.clear();
    socket.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 3);
  const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const result = await attachInstalledApiObserver(config);
  console.log(JSON.stringify(result));
}
