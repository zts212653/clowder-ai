const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');

const { WorkspaceFileOpenController, WORKSPACE_OPEN_HTML_CHANNEL } = require('./workspace-file-open-controller');

function harness(options = {}) {
  const ipcMain = new EventEmitter();
  const handlers = new Map();
  ipcMain.handle = (channel, handler) => handlers.set(channel, handler);
  ipcMain.removeHandler = (channel) => handlers.delete(channel);
  const requests = [];
  const opened = [];
  const logs = [];
  const webContents = { isDestroyed: () => false };
  webContents.mainFrame = { url: 'http://localhost:3003/thread/thread_abc' };
  const window = {
    webContents,
    isDestroyed: () => false,
  };
  const fetch = async (url, init) => {
    requests.push([url, init]);
    return {
      ok: true,
      status: 200,
      json: async () => ({ absolutePath: '/workspace/AC Claw/reports/index.html' }),
    };
  };
  const controller = new WorkspaceFileOpenController({
    ipcMain,
    getMainWindow: () => window,
    fetch,
    openPath: async (absolutePath) => {
      opened.push(absolutePath);
      return '';
    },
    dbg: (line) => logs.push(line),
    trustedOrigin: 'http://localhost:3003',
    apiOrigin: 'http://localhost:3004',
    ...options,
  });
  return {
    controller,
    handlers,
    requests,
    opened,
    logs,
    webContents,
    event: { sender: webContents, senderFrame: webContents.mainFrame },
  };
}

describe('WorkspaceFileOpenController', () => {
  test('is wired into the desktop lifecycle rather than exposed as a generic renderer URL opener', () => {
    const mainSource = readFileSync(path.join(__dirname, 'main.js'), 'utf8');
    assert.match(mainSource, /new WorkspaceFileOpenController\(\{/);
    assert.match(mainSource, /openPath: \(absolutePath\) => shell\.openPath\(absolutePath\)/);
    assert.match(mainSource, /workspaceFileOpen\?\.dispose\(\)/);
  });

  test('resolves a typed target through the loopback API before opening the canonical HTML path', async () => {
    const h = harness();
    const target = { worktreeId: 'ac-claw', path: '抓包分析/hybrid-report-dogfood/index.html' };

    assert.deepEqual(await h.handlers.get(WORKSPACE_OPEN_HTML_CHANNEL)(h.event, target), { ok: true });
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0][0], 'http://localhost:3004/api/workspace/resolve-openable-file');
    const { signal, ...requestInit } = h.requests[0][1];
    assert.equal(signal.aborted, false);
    assert.deepEqual(requestInit, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-cat-cafe-user': 'default-user',
      },
      body: JSON.stringify(target),
    });
    assert.deepEqual(h.opened, ['/workspace/AC Claw/reports/index.html']);
    h.controller.dispose();
  });

  test('fails closed when the loopback resolver rejects or returns malformed data', async () => {
    for (const fetch of [
      async () => ({ ok: false, status: 403, json: async () => ({ error: 'denied' }) }),
      async () => ({ ok: true, status: 200, json: async () => ({ absolutePath: '/workspace/report.md' }) }),
      async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('invalid JSON');
        },
      }),
    ]) {
      const h = harness({ fetch });
      await assert.rejects(
        () =>
          h.handlers.get(WORKSPACE_OPEN_HTML_CHANNEL)(h.event, {
            worktreeId: 'ac-claw',
            path: 'site/index.html',
          }),
        /could not open|invalid/i,
      );
      assert.equal(h.opened.length, 0);
      h.controller.dispose();
    }
  });

  test('rejects an untrusted frame before resolving or opening a path', async () => {
    const h = harness();
    const untrustedFrame = { url: 'http://localhost:3003/thread/thread_abc' };

    await assert.rejects(
      () =>
        h.handlers.get(WORKSPACE_OPEN_HTML_CHANNEL)(
          { sender: h.webContents, senderFrame: untrustedFrame },
          { worktreeId: 'ac-claw', path: 'site/index.html' },
        ),
      /untrusted/i,
    );
    assert.equal(h.requests.length, 0);
    assert.equal(h.opened.length, 0);
    h.controller.dispose();
  });

  test('rejects malformed targets and invalid resolver responses without opening a path', async () => {
    const h = harness({
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ absolutePath: 'relative/index.html' }),
      }),
    });
    const handler = h.handlers.get(WORKSPACE_OPEN_HTML_CHANNEL);

    await assert.rejects(() => handler(h.event, { worktreeId: 'ac-claw', path: '../index.html' }), /invalid/i);
    await assert.rejects(() => handler(h.event, { worktreeId: 'ac-claw', path: 'site/index.html' }), /invalid/i);
    assert.equal(h.opened.length, 0);
    h.controller.dispose();
  });

  test('surfaces an OS open failure without logging the private filesystem path', async () => {
    const h = harness({ openPath: async () => 'No application is registered' });

    await assert.rejects(
      () =>
        h.handlers.get(WORKSPACE_OPEN_HTML_CHANNEL)(h.event, {
          worktreeId: 'ac-claw',
          path: 'site/index.html',
        }),
      /could not open/i,
    );
    assert.ok(h.logs.every((line) => !line.includes('/workspace/AC Claw')));
    h.controller.dispose();
    assert.equal(h.handlers.has(WORKSPACE_OPEN_HTML_CHANNEL), false);
  });

  test('redacts a thrown OS error before it crosses the IPC boundary', async () => {
    const h = harness({
      openPath: async () => {
        throw new Error('Failed to open /workspace/AC Claw/reports/index.html');
      },
    });

    await assert.rejects(
      () =>
        h.handlers.get(WORKSPACE_OPEN_HTML_CHANNEL)(h.event, {
          worktreeId: 'ac-claw',
          path: 'site/index.html',
        }),
      (error) => error.message === 'Could not open Workspace HTML',
    );
    assert.ok(h.logs.every((line) => !line.includes('/workspace/AC Claw')));
    h.controller.dispose();
  });
});
