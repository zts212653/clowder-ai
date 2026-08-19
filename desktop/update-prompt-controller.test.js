// F273 — trusted main-frame update result transaction tests

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { describe, test } = require('node:test');

const {
  UpdatePromptController,
  UPDATE_PROMPT_CHANNEL,
  UPDATE_PROMPT_READY_CHANNEL,
  UPDATE_PROMPT_ACTION_CHANNEL,
  UPDATE_PROGRESS_CHANNEL,
  UPDATE_SETTINGS_GET_CHANNEL,
  UPDATE_SETTINGS_SET_AUTO_CHECK_CHANNEL,
} = require('./update-prompt-controller');
const { createManualUpdateHandler } = require('./desktop-update-menu');

function harness(options = {}) {
  const ipcMain = new EventEmitter();
  const handlers = new Map();
  ipcMain.handle = (channel, handler) => handlers.set(channel, handler);
  ipcMain.removeHandler = (channel) => handlers.delete(channel);
  const sent = [];
  const opened = [];
  const logs = [];
  const presentation = [];
  const timers = [];
  const webContents = {
    send(channel, payload) {
      sent.push([channel, payload]);
    },
    isDestroyed: () => false,
  };
  webContents.mainFrame = { url: 'http://localhost:3003/app?tab=updates#latest' };
  let visible = true;
  const window = {
    webContents,
    isDestroyed: () => false,
    isMinimized: () => false,
    isVisible: () => visible,
    hide: () => {
      visible = false;
    },
    restore: () => presentation.push('restore'),
    show: () => {
      visible = true;
      presentation.push('show');
    },
    focus: () => presentation.push('focus'),
  };
  const readyEpochs = [];
  const controller = new UpdatePromptController({
    ipcMain,
    getMainWindow: () => window,
    openExternal: async (url) => opened.push(url),
    dbg: (line) => logs.push(line),
    trustedOrigin: 'http://localhost:3003',
    getUpdateSettings: () => ({ autoCheck: true }),
    setUpdateAutoCheck: (enabled) => ({ autoCheck: enabled }),
    onRendererReady: () => readyEpochs.push('ready'),
    setTimeout: (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      timer.cleared = true;
    },
    ...options,
  });
  const event = { sender: webContents, senderFrame: webContents.mainFrame };
  const payload = {
    kind: 'available',
    version: '0.12.0',
    currentVersion: '0.10.0',
    platform: 'windows',
    assetName: 'ClowderAI-Setup-0.12.0.exe',
    releaseUrl: 'https://github.com/zts212653/clowder-ai/releases/tag/v0.12.0',
    releaseNotes: '# Clowder AI v0.12.0\n\nRelease highlights.',
  };
  return {
    controller,
    ipcMain,
    handlers,
    sent,
    opened,
    logs,
    timers,
    presentation,
    readyEpochs,
    window,
    webContents,
    event,
    payload,
  };
}

function readyRenderer(h, event = h.event) {
  return h.handlers.get(UPDATE_PROMPT_READY_CHANNEL)(event);
}

function act(h, action, version = h.payload.version, event = h.event) {
  h.ipcMain.emit(UPDATE_PROMPT_ACTION_CHANNEL, event, { action, version });
}

describe('UpdatePromptController', () => {
  test('returns a prompt that became pending before trusted renderer readiness', async () => {
    const h = harness();
    let resolved = false;
    const result = h.controller.show(h.payload).then((action) => {
      resolved = true;
      return action;
    });

    assert.deepEqual(h.sent, []);
    assert.deepEqual(h.presentation, []);
    assert.deepEqual(readyRenderer(h), h.payload);
    assert.deepEqual(h.presentation, ['show', 'focus']);
    assert.deepEqual(h.readyEpochs, ['ready']);
    assert.equal(resolved, false);

    act(h, 'later');
    assert.equal(await result, 'later');
    h.controller.dispose();
  });

  test('pushes a later prompt immediately when the trusted renderer is ready', async () => {
    const h = harness();

    assert.equal(readyRenderer(h), null);
    const result = h.controller.show(h.payload);

    assert.deepEqual(h.sent, [[UPDATE_PROMPT_CHANNEL, h.payload]]);
    assert.deepEqual(h.presentation, ['show', 'focus']);
    act(h, 'download');
    assert.equal(await result, 'download');
    h.controller.dispose();
  });

  test('retains a pending prompt across renderer loss without a timer or native fallback', async () => {
    const h = harness();
    readyRenderer(h);
    const result = h.controller.show(h.payload, { presentationTimeoutMs: 15_000 });

    h.controller.markRendererUnavailable();
    assert.equal(h.timers.length, 0, 'ordinary result prompts must reject presentation deadlines');
    assert.deepEqual(h.readyEpochs, ['ready']);
    assert.deepEqual(readyRenderer(h), h.payload);
    assert.deepEqual(h.readyEpochs, ['ready', 'ready']);

    act(h, 'later');
    assert.equal(await result, 'later');
    assert.ok(h.logs.every((line) => !line.includes('did not become ready')));
    h.controller.dispose();
  });

  test('re-presents the pending prompt when a hidden window receives another manual update request', async () => {
    const h = harness();
    readyRenderer(h);
    const result = h.controller.show(h.payload);
    h.window.hide();
    h.presentation.length = 0;
    h.sent.length = 0;
    let checks = 0;
    const onManualUpdate = createManualUpdateHandler({
      getUpdatePrompt: () => h.controller,
      getUpdater: () => ({
        checkForUpdates: () => {
          checks += 1;
        },
      }),
    });

    assert.equal(h.window.isVisible(), false);
    assert.equal(onManualUpdate(), 'presented');
    assert.equal(checks, 0);
    assert.equal(h.window.isVisible(), true);
    assert.deepEqual(h.presentation, ['show', 'focus']);
    assert.deepEqual(h.sent, [[UPDATE_PROMPT_CHANNEL, h.payload]]);

    act(h, 'later');
    assert.equal(await result, 'later');
    assert.equal(h.controller.presentPending(), false);
    h.controller.dispose();
  });

  test('rejects unsupported prompt shapes and admits actions by prompt kind', async () => {
    const h = harness();
    readyRenderer(h);

    await assert.rejects(() => h.controller.show({ ...h.payload, platform: 'linux' }), /Invalid update prompt payload/);
    await assert.rejects(() => h.controller.show({ kind: 'up-to-date', version: '' }), /Invalid update prompt payload/);
    await assert.rejects(
      () => h.controller.show({ kind: 'check-failed', version: '0.11.0', releaseUrl: 'http://example.com' }),
      /Invalid update prompt payload/,
    );
    const lookalikeResult = h.controller
      .show({
        kind: 'check-failed',
        version: '0.11.0',
        releaseUrl: 'https://github.com/zts212653/clowder-ai/releases-evil',
      })
      .then(
        () => null,
        (error) => error,
      );
    const lookalikeOutcome = await Promise.race([
      lookalikeResult,
      new Promise((resolve) => setImmediate(() => resolve('accepted'))),
    ]);
    assert.match(String(lookalikeOutcome), /Invalid update prompt payload/);

    const upToDate = { kind: 'up-to-date', version: '0.11.0' };
    const result = h.controller.show(upToDate);
    act(h, 'download', upToDate.version);
    act(h, 'open-release', upToDate.version);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(h.opened, []);

    act(h, 'dismiss', upToDate.version);
    assert.equal(await result, 'dismiss');
    h.controller.dispose();
  });

  test('opens only the main-owned Releases URL from a failed result and keeps it pending', async () => {
    const h = harness();
    readyRenderer(h);
    const failed = {
      kind: 'check-failed',
      version: '0.11.0',
      releaseUrl: 'https://github.com/zts212653/clowder-ai/releases',
    };
    let resolved = false;
    const result = h.controller.show(failed).then((action) => {
      resolved = true;
      return action;
    });

    act(h, 'open-release', failed.version);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(h.opened, [failed.releaseUrl]);
    assert.equal(resolved, false);

    act(h, 'dismiss', failed.version);
    assert.equal(await result, 'dismiss');
    h.controller.dispose();
  });

  test('admits install only for a ready-to-install prompt', async () => {
    const h = harness();
    readyRenderer(h);
    const ready = {
      kind: 'ready-to-install',
      version: h.payload.version,
      platform: h.payload.platform,
      assetName: h.payload.assetName,
    };
    const result = h.controller.show(ready);

    act(h, 'download');
    act(h, 'open-release');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(h.opened, []);

    act(h, 'install');
    assert.equal(await result, 'install');
    h.controller.dispose();
  });

  test('expires only a ready-to-install prompt when its renderer presentation is lost', async () => {
    const h = harness();
    readyRenderer(h);
    const ready = {
      kind: 'ready-to-install',
      version: h.payload.version,
      platform: h.payload.platform,
      assetName: h.payload.assetName,
    };
    const result = h.controller.show(ready, { presentationTimeoutMs: 15_000 });

    assert.equal(h.timers.length, 0, 'a currently presented install prompt must not race a native dialog');
    h.controller.markRendererUnavailable();
    assert.equal(h.timers.length, 1);
    assert.equal(h.timers[0].delay, 15_000);

    h.timers[0].callback();
    assert.equal(await result, undefined);
    assert.equal(h.timers[0].cleared, true);
    assert.ok(h.logs.some((line) => line.includes('did not remain available')));

    const nextResult = h.controller.show(h.payload);
    assert.equal(h.timers.length, 1, 'ordinary update results must remain timer-free');
    readyRenderer(h);
    act(h, 'later');
    assert.equal(await nextResult, 'later', 'expiry must clear the old install transaction');
    h.controller.dispose();
  });

  test('starts the install presentation deadline when the renderer was already unavailable', async () => {
    const h = harness();
    readyRenderer(h);
    h.controller.markRendererUnavailable();
    const result = h.controller.show(
      {
        kind: 'ready-to-install',
        version: h.payload.version,
        platform: h.payload.platform,
        assetName: h.payload.assetName,
      },
      { presentationTimeoutMs: 15_000 },
    );

    assert.equal(h.timers.length, 1);
    h.timers[0].callback();
    assert.equal(await result, undefined);
    h.controller.dispose();
  });

  test('rejects untrusted readiness and actions from another sender, child frame, origin, or version', async () => {
    const h = harness();
    const result = h.controller.show(h.payload);
    const attacks = [
      { sender: {}, senderFrame: {} },
      { sender: h.webContents, senderFrame: {} },
    ];

    for (const event of attacks) {
      assert.equal(readyRenderer(h, event), null);
      act(h, 'download', h.payload.version, event);
    }
    h.webContents.mainFrame.url = 'http://localhost:3003@attacker.example/update';
    assert.equal(readyRenderer(h), null);
    act(h, 'download');
    h.webContents.mainFrame.url = 'http://localhost:3003/app';
    act(h, 'download', '9.9.9');
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(h.sent, []);
    assert.deepEqual(h.opened, []);
    act(h, 'later');
    assert.equal(await result, 'later');
    h.controller.dispose();
  });

  test('stores download progress and replays it after a renderer reload', () => {
    const h = harness();
    const progress = {
      phase: 'downloading',
      version: '0.12.0',
      assetName: 'ClowderAI-Setup-0.12.0.exe',
      progress: 0.42,
    };

    h.controller.setProgress(progress);
    assert.deepEqual(h.sent, []);
    readyRenderer(h);
    assert.deepEqual(h.sent.at(-1), [UPDATE_PROGRESS_CHANNEL, progress]);

    h.controller.markRendererUnavailable();
    h.controller.setProgress({ ...progress, progress: 0.67 });
    readyRenderer(h);
    assert.deepEqual(h.sent.at(-1), [UPDATE_PROGRESS_CHANNEL, { ...progress, progress: 0.67 }]);

    h.controller.setProgress(null);
    assert.deepEqual(h.sent.at(-1), [UPDATE_PROGRESS_CHANNEL, null]);
    h.controller.dispose();
  });

  test('serves automatic-update preferences only to the trusted main frame', async () => {
    const writes = [];
    const h = harness({
      getUpdateSettings: () => ({ autoCheck: false }),
      setUpdateAutoCheck: (enabled) => {
        writes.push(enabled);
        return { autoCheck: enabled };
      },
    });
    const getSettings = h.handlers.get(UPDATE_SETTINGS_GET_CHANNEL);
    const setAutoCheck = h.handlers.get(UPDATE_SETTINGS_SET_AUTO_CHECK_CHANNEL);

    assert.deepEqual(await getSettings(h.event), { autoCheck: false });
    assert.deepEqual(await setAutoCheck(h.event, true), { autoCheck: true });
    assert.deepEqual(writes, [true]);
    await assert.rejects(() => getSettings({ sender: {}, senderFrame: {} }), /untrusted/i);
    await assert.rejects(() => setAutoCheck(h.event, 'false'), /boolean/i);
    h.controller.dispose();
  });

  test('resolves a prompt at most once and can safely show the next result', async () => {
    const h = harness();
    readyRenderer(h);
    const first = h.controller.show(h.payload);
    act(h, 'download');
    act(h, 'skip');
    assert.equal(await first, 'download');

    const next = { kind: 'up-to-date', version: '0.12.0' };
    const second = h.controller.show(next);
    act(h, 'dismiss', next.version);
    assert.equal(await second, 'dismiss');
    h.controller.dispose();
  });

  test('dispose resolves a pending prompt and removes every IPC surface', async () => {
    const h = harness();
    readyRenderer(h);
    const result = h.controller.show(h.payload);

    h.controller.dispose();

    assert.equal(await result, 'later');
    assert.equal(h.ipcMain.listenerCount(UPDATE_PROMPT_ACTION_CHANNEL), 0);
    assert.equal(h.handlers.has(UPDATE_PROMPT_READY_CHANNEL), false);
    assert.equal(h.handlers.has(UPDATE_SETTINGS_GET_CHANNEL), false);
    assert.equal(h.handlers.has(UPDATE_SETTINGS_SET_AUTO_CHECK_CHANNEL), false);
  });
});
