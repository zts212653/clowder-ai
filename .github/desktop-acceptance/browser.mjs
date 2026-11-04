import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { assertChecksPassed, collectChecks } from './checks.mjs';
import { waitForInitialPlugins } from './initial-plugins.mjs';
import { waitForRendererDocument } from './renderer-document.mjs';

const [phase, directory, frontendText, apiText, debugText, version] = process.argv.slice(2);
assert.ok(['create', 'restore'].includes(phase));
const ports = [frontendText, apiText, debugText].map((value) => {
  assert.match(value, /^\d+$/);
  const port = Number(value);
  assert.ok(port >= 1024 && port <= 65535 && ![3001, 3002, 3003, 3004, 6399].includes(port));
  return port;
});
assert.equal(new Set(ports).size, 3);
const [frontend, api, debug] = ports;
const base = `http://localhost:${frontend}`;
let target;
const deadline = Date.now() + 180000;
while (Date.now() < deadline) {
  try {
    const targets = await (
      await fetch(`http://127.0.0.1:${debug}/json/list`, { signal: AbortSignal.timeout(3000) })
    ).json();
    target = targets.find((entry) => entry.type === 'page' && entry.url.startsWith(`${base}/`));
    if (target) break;
  } catch {}
  await delay(1000);
}
assert.ok(target, 'Installed Electron did not expose its real application window');
assert.equal(new URL(target.url).searchParams.get('__clowder_desktop_version'), version);
const debuggerUrl = new URL(target.webSocketDebuggerUrl);
assert.equal(debuggerUrl.protocol, 'ws:');
assert.ok(['127.0.0.1', 'localhost'].includes(debuggerUrl.hostname));
assert.equal(debuggerUrl.port, debugText);
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('CDP connection timed out')), 10000);
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
      reject(new Error('CDP connection failed'));
    },
    { once: true },
  );
});
let sequence = 0;
async function call(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.removeEventListener('message', receive);
      reject(new Error(`${method} timed out`));
    }, 30000);
    const receive = (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== id) return;
      clearTimeout(timer);
      socket.removeEventListener('message', receive);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    };
    socket.addEventListener('message', receive);
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const response = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  assert.ok(!response.exceptionDetails, JSON.stringify(response.exceptionDetails));
  return response.result.value;
}
try {
  await waitForRendererDocument({
    read: () => evaluate('({origin:location.origin,readyState:document.readyState,hasBody:!!document.body})'),
    origin: base,
  });
  const healthResponse = await fetch(`http://127.0.0.1:${api}/health`, { signal: AbortSignal.timeout(10000) });
  assert.equal(healthResponse.status, 200);
  const health = await healthResponse.json();
  assert.deepEqual(health.callbackAuth, { backend: 'redis', durability: 'durable' });
  const expectedPath = path.join(directory, 'expected-state.json');
  let expected;
  let reads, capsule, initialPlugins;
  let visibleText = '';
  const baseline = phase === 'create' ? 'state-write' : 'restore-baseline';
  const resultsPath = path.join(directory, `${phase}-checks.json`);
  const result = await collectChecks(
    [baseline, 'persisted-readback', 'default-plugins', 'profile-ui'],
    async (name) => {
      if (name === baseline) {
        if (phase === 'create') {
          const content =
            'F330 installed Windows candidate acceptance. Prefer the conclusion before supporting evidence.';
          const revision = `sha256:${createHash('sha256').update(content).digest('hex')}`;
          expected = await evaluate(`(async () => {
          const session = await fetch('http://localhost:${api}/api/session', { credentials: 'include' });
          if (!session.ok) throw new Error('Browser session bootstrap: HTTP ' + session.status);
          const { csrfToken } = await session.json();
          if (typeof csrfToken !== 'string' || !csrfToken) throw new Error('Browser session CSRF unavailable');
          const request = async (route, options) => {
            const headers = new Headers(options?.headers);
            headers.set('x-csrf-token', csrfToken);
            const response = await fetch('http://localhost:${api}' + route, { credentials: 'include', ...options, headers });
            if (!response.ok) throw new Error(route + ': HTTP ' + response.status);
            return response.json();
          };
          const thread = await request('/api/threads', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'F330 Windows durable acceptance', preferredCats: [], pinned: true }) });
          const capsule = await request('/api/memory/profile/capsule/actions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'replace_content', expectedRevision: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', content: ${JSON.stringify(content)}, requestId: crypto.randomUUID() }) });
          return { thread, capsule, content: ${JSON.stringify(content)} };
        })()`);
          assert.equal(expected.thread.pinned, true);
          assert.equal(expected.capsule.outcome, 'applied');
          assert.equal(expected.capsule.revision, revision);
          fs.writeFileSync(expectedPath, JSON.stringify(expected, null, 2));
        } else expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
        return;
      }
      if (name === 'persisted-readback') {
        if (!expected) return { status: 'not_run', reason: 'state-baseline-unavailable' };
        reads = await evaluate(`(async () => {
        const read = async (route) => {
          const response = await fetch('http://localhost:${api}' + route, { credentials: 'include' });
          if (response.status !== 200) throw new Error(route + ': HTTP ' + response.status);
          return response.json();
        };
        return { thread: await read('/api/threads/' + ${JSON.stringify(expected.thread.id)}), profile: await read('/api/memory/profile') };
      })()`);
        assert.equal(reads.thread.id, expected.thread.id);
        assert.equal(reads.thread.title, expected.thread.title);
        assert.equal(reads.thread.pinned, true);
        capsule = reads.profile.entries.find((entry) => entry.id === 'capsule');
        assert.equal(capsule.content, expected.content);
        assert.equal(capsule.revision, expected.capsule.revision);
        return;
      }
      if (name === 'default-plugins') {
        initialPlugins = await waitForInitialPlugins({
          read: () =>
            evaluate(`(async () => {
          const response = await fetch('http://localhost:${api}/api/plugin-manager/plugins/_local', { credentials: 'include' });
          if (!response.ok) throw new Error('Installed plugins: HTTP ' + response.status);
          return response.json();
        })()`),
          observe: (plugins) =>
            fs.writeFileSync(
              path.join(directory, `${phase}-initial-plugins.json`),
              JSON.stringify({ observedAt: new Date().toISOString(), plugins }, null, 2),
            ),
        });
        return;
      }
      if (!expected) return { status: 'not_run', reason: 'state-baseline-unavailable' };
      await call('Page.navigate', { url: `${base}/memory?__clowder_desktop_version=${version}` });
      visibleText = '';
      for (let index = 0; index < 60; index++) {
        visibleText = await evaluate(`(() => {
          if (!document.body) return '';
          const buttons = [...document.querySelectorAll('button')];
          buttons.find((button) => button.textContent.trim() === '稍后再看')?.click();
          buttons.find((button) => button.textContent.trim() === '画像')?.click();
          return document.body.innerText;
        })()`);
        if (visibleText.includes(expected.content)) break;
        await delay(1000);
      }
      assert.ok(visibleText.includes(expected.content), 'Saved capsule did not appear in the installed application UI');
      const screenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.writeFileSync(path.join(directory, `${phase}.png`), Buffer.from(screenshot.data, 'base64'));
    },
    {
      observe: (checks) =>
        fs.writeFileSync(
          resultsPath,
          JSON.stringify(
            {
              phase,
              status: 'in_progress',
              stateWriteApplied: phase === 'create' && expected?.capsule?.outcome === 'applied' ? true : null,
              checks,
            },
            null,
            2,
          ),
        ),
    },
  );
  fs.writeFileSync(
    resultsPath,
    JSON.stringify(
      {
        phase,
        status: result.status,
        stateWriteApplied: phase === 'create' && expected?.capsule?.outcome === 'applied' ? true : null,
        checks: result.checks,
      },
      null,
      2,
    ),
  );
  assertChecksPassed(result);
  fs.writeFileSync(
    path.join(directory, `${phase}.json`),
    JSON.stringify(
      {
        observedAt: new Date().toISOString(),
        initialWindowUrl: target.url,
        health,
        initialPlugins,
        reads,
        visibleText,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      phase,
      threadId: expected.thread.id,
      capsuleRevision: capsule.revision,
      durableStateRead: true,
      defaultInitialPluginsReady: initialPlugins.defaultInitialPluginsReady,
      actualWindowScreenshot: true,
    }),
  );
} finally {
  socket.close();
}
