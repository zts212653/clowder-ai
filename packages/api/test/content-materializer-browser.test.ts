import assert from 'node:assert/strict';
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runContainedMaterializer } from '../src/domains/plugin/content-materializer-runtime/browser-runner.js';

const echo = Buffer.from('self.onmessage = e => { self.postMessage(e.data); self.close(); };');

test('a real failed browser launch removes its private profile and rejects the operation', async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), 'f309-failed-browser-'));
  const executable = join(scratch, 'failed-chromium');
  const profileRecord = join(scratch, 'profile');
  await writeFile(
    executable,
    '#!/bin/sh\nfor arg in "$@"; do\ncase "$arg" in\n--user-data-dir=*) printf "%s" "${arg#--user-data-dir=}" > "$(dirname "$0")/profile";;\nesac\ndone\nexit 73\n',
  );
  await chmod(executable, 0o700);
  const previous = process.env.CHROME_EXECUTABLE_PATH;
  process.env.CHROME_EXECUTABLE_PATH = executable;
  t.after(async () => {
    if (previous === undefined) delete process.env.CHROME_EXECUTABLE_PATH;
    else process.env.CHROME_EXECUTABLE_PATH = previous;
    await rm(scratch, { recursive: true, force: true });
  });
  await assert.rejects(
    runContainedMaterializer({ module: echo, requestJson: '{}', signal: new AbortController().signal }),
    /launch|exited|closed|73/i,
  );
  const profile = await readFile(profileRecord, 'utf8');
  assert.match(profile, /clowder-materializer-/);
  await assert.rejects(access(profile), { code: 'ENOENT' });
});

test('a private sandboxed worker returns bounded data and is disposed', async () => {
  const result = await runContainedMaterializer({
    module: echo,
    requestJson: '{"value":"private"}',
    signal: new AbortController().signal,
  });
  assert.deepEqual(JSON.parse(result.json), { value: 'private' });
  assert.ok(result.metrics.peakRssBytes > 0);
  assert.ok(result.metrics.cpuSeconds >= 0);
  assert.ok(result.metrics.durationMs > 0);
  assert.equal(result.metrics.disposed, true);
  assert.equal(result.metrics.externalRequests, 0);
});

test('worker CSP and request boundary deny egress, imports, nested workers and ambient Host access', async (t) => {
  let hits = 0;
  const forbidden = createServer((_req, res) => {
    hits++;
    res.end('forbidden');
  });
  await new Promise<void>((resolve) => forbidden.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => forbidden.close(() => resolve())));
  const address = forbidden.address();
  assert.ok(address && typeof address !== 'string');
  const target = `http://127.0.0.1:${address.port}`;
  const module = Buffer.from(`self.onmessage = async () => {
    const denied = async (work) => { try { await work(); return false; } catch { return true; } };
    const socketDenied = () => new Promise(resolve => { try { const s = new WebSocket(${JSON.stringify(target.replace('http:', 'ws:'))}); s.onerror = () => resolve(true); s.onopen = () => { s.close(); resolve(false); }; } catch { resolve(true); } });
    const eventsDenied = () => new Promise(resolve => { try { const s = new EventSource(${JSON.stringify(target)}); s.onerror = () => { s.close(); resolve(true); }; s.onopen = () => { s.close(); resolve(false); }; } catch { resolve(true); } });
    self.postMessage({
      fetch: await denied(() => fetch(${JSON.stringify(target)})),
      file: await denied(() => fetch('file:///etc/passwd')),
      module: await denied(() => import(${JSON.stringify(target + '/module.js')})),
      nested: await denied(() => new Worker(${JSON.stringify(target + '/nested.js')})),
      socket: await socketDenied(), events: await eventsDenied(),
      hostAbsent: typeof process === 'undefined' && typeof window === 'undefined' && typeof require === 'undefined' && typeof electronAPI === 'undefined'
    });
  };`);
  const result = await runContainedMaterializer({ module, requestJson: '{}', signal: new AbortController().signal });
  assert.deepEqual(JSON.parse(result.json), {
    fetch: true,
    file: true,
    module: true,
    nested: true,
    socket: true,
    events: true,
    hostAbsent: true,
  });
  assert.equal(hits, 0);
  await assert.rejects(
    runContainedMaterializer({
      module: Buffer.from(
        'self.onmessage = async () => { const value = await import("data:text/javascript,export default 1"); self.postMessage(value.default); };',
      ),
      requestJson: '{}',
      signal: new AbortController().signal,
    }),
    /undeclared script request/,
  );
});

test('infinite execution and revocation cannot return a late result', async () => {
  await assert.rejects(
    runContainedMaterializer({
      module: Buffer.from('self.onmessage = () => { while(true) {} };'),
      requestJson: '{}',
      signal: new AbortController().signal,
      timeoutMs: 2000,
    }),
    /deadline|resource/i,
  );
  const controller = new AbortController();
  const work = runContainedMaterializer({
    module: Buffer.from('self.onmessage = () => setTimeout(() => self.postMessage({late:true}), 10000);'),
    requestJson: '{}',
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 1000);
  await assert.rejects(work, /abort|revoked/i);
});

test('invalid or oversized request and oversized output fail closed', async () => {
  await assert.rejects(
    runContainedMaterializer({ module: echo, requestJson: '{}', signal: AbortSignal.abort(), timeoutMs: 100 }),
    /abort/i,
  );
  await assert.rejects(
    runContainedMaterializer({
      module: echo,
      requestJson: '{}',
      signal: new AbortController().signal,
      timeoutMs: Number.NaN,
    }),
    /invalid materializer deadline/,
  );
  await assert.rejects(
    runContainedMaterializer({
      module: echo,
      requestJson: 'x'.repeat(12 * 1024 * 1024 + 1),
      signal: new AbortController().signal,
    }),
    /budget/i,
  );
  await assert.rejects(
    runContainedMaterializer({ module: echo, requestJson: 'invalid json', signal: new AbortController().signal }),
    /JSON/i,
  );
  await assert.rejects(
    runContainedMaterializer({
      module: Buffer.from('self.onmessage = () => self.postMessage("x".repeat(12 * 1024 * 1024 + 1));'),
      requestJson: '{}',
      signal: new AbortController().signal,
    }),
    /output budget/i,
  );
});

test('allocation pressure cannot return a document or leave a live worker behind', async () => {
  const module = Buffer.from(
    'self.onmessage = () => { const chunks=[]; while(true) { const block=new Uint8Array(64*1024*1024); block.fill(1); chunks.push(block); } };',
  );
  await assert.rejects(
    runContainedMaterializer({ module, requestJson: '{}', signal: new AbortController().signal, timeoutMs: 5000 }),
    /budget|deadline|closed|crash|exited/i,
  );
});
