import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import puppeteer from 'puppeteer-core';
import { ImageExportBrowserSession } from '../dist/services/image-export-browser-session.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

class FakeBrowser extends EventEmitter {
  constructor({ browserProcess, closeGate, closeNeverSettles = false, newPageEntered, pendingPage, pid }) {
    super();
    this.connected = true;
    this.closeCalls = 0;
    this.closeGate = closeGate;
    this.closeNeverSettles = closeNeverSettles;
    this.newPageEntered = newPageEntered;
    this.pendingPage = pendingPage;
    this.browserProcess = browserProcess === undefined ? new FakeBrowserProcess(pid) : browserProcess;
  }

  isConnected() {
    return this.connected;
  }

  process() {
    return this.browserProcess;
  }

  async newPage() {
    this.newPageEntered?.resolve();
    if (this.pendingPage) return this.pendingPage.promise;
    return { close: async () => undefined };
  }

  disconnectTransport() {
    if (!this.connected) return;
    this.connected = false;
    this.emit('disconnected');
    this.pendingPage?.reject(new Error('Connection closed.'));
  }

  async close() {
    this.closeCalls += 1;
    this.disconnectTransport();
    if (this.closeNeverSettles) return new Promise(() => undefined);
    await this.closeGate?.promise;
    this.browserProcess.exit?.(0, null);
  }
}

class FakeBrowserProcess extends EventEmitter {
  constructor(pid) {
    super();
    this.exitCode = null;
    this.pid = pid;
    this.signalCode = null;
  }

  exit(code, signal) {
    if (this.exitCode !== null) return;
    if (this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
}

async function waitFor(predicate, message, timeoutMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw error;
  }
}

async function closeSessionIgnoringError(session) {
  try {
    await session.close();
  } catch {
    // A failing cleanup assertion must not hide the primary test failure.
  }
}

test('close prevents an in-flight openPage from relaunching a replacement browser', async () => {
  const previousChromePath = process.env.CHROME_EXECUTABLE_PATH;
  const originalLaunch = puppeteer.launch;
  const firstPageEntered = deferred();
  const firstPage = deferred();
  const firstBrowser = new FakeBrowser({ newPageEntered: firstPageEntered, pendingPage: firstPage, pid: 101 });
  let replacementBrowser;
  let launchCount = 0;
  const session = new ImageExportBrowserSession();

  process.env.CHROME_EXECUTABLE_PATH = process.execPath;
  puppeteer.launch = async () => {
    launchCount += 1;
    if (launchCount === 1) return firstBrowser;
    replacementBrowser = new FakeBrowser({ pid: 202 });
    return replacementBrowser;
  };

  try {
    const openingPage = session.openPage();
    await firstPageEntered.promise;

    await session.close();

    await assert.rejects(openingPage, /closed/i);
    assert.equal(launchCount, 1, 'the in-flight request must not launch a replacement after close starts');
    assert.equal(session.browser, null);
    assert.equal(replacementBrowser, undefined);
  } finally {
    await session.close();
    await replacementBrowser?.close();
    puppeteer.launch = originalLaunch;
    if (previousChromePath === undefined) {
      delete process.env.CHROME_EXECUTABLE_PATH;
    } else {
      process.env.CHROME_EXECUTABLE_PATH = previousChromePath;
    }
  }
});

test('close consumes a browser launch that completes during shutdown', async () => {
  const previousChromePath = process.env.CHROME_EXECUTABLE_PATH;
  const originalLaunch = puppeteer.launch;
  const launchStarted = deferred();
  const launchResult = deferred();
  const launchedBrowser = new FakeBrowser({ pid: 303 });
  let launchCount = 0;
  const session = new ImageExportBrowserSession();

  process.env.CHROME_EXECUTABLE_PATH = process.execPath;
  puppeteer.launch = async () => {
    launchCount += 1;
    launchStarted.resolve();
    return launchResult.promise;
  };

  try {
    const openingPage = session.openPage();
    await launchStarted.promise;

    const closing = session.close();
    launchResult.resolve(launchedBrowser);

    await closing;
    await assert.rejects(openingPage, /closed/i);
    assert.equal(launchCount, 1);
    assert.equal(session.browser, null);
    assert.equal(launchedBrowser.isConnected(), false);
  } finally {
    launchResult.resolve(launchedBrowser);
    await session.close();
    await launchedBrowser.close();
    puppeteer.launch = originalLaunch;
    if (previousChromePath === undefined) {
      delete process.env.CHROME_EXECUTABLE_PATH;
    } else {
      process.env.CHROME_EXECUTABLE_PATH = previousChromePath;
    }
  }
});

test('openPage after close fails without launching a browser', async () => {
  const previousChromePath = process.env.CHROME_EXECUTABLE_PATH;
  const originalLaunch = puppeteer.launch;
  let launchCount = 0;
  const session = new ImageExportBrowserSession();

  process.env.CHROME_EXECUTABLE_PATH = process.execPath;
  puppeteer.launch = async () => {
    launchCount += 1;
    return new FakeBrowser({ pid: 404 });
  };

  try {
    await session.close();
    await assert.rejects(session.openPage(), /closed/i);
    assert.equal(launchCount, 0);
    assert.equal(session.browser, null);
  } finally {
    await session.close();
    puppeteer.launch = originalLaunch;
    if (previousChromePath === undefined) {
      delete process.env.CHROME_EXECUTABLE_PATH;
    } else {
      process.env.CHROME_EXECUTABLE_PATH = previousChromePath;
    }
  }
});

test('transport disconnect drains the owned browser and permits one replacement', async () => {
  const previousChromePath = process.env.CHROME_EXECUTABLE_PATH;
  const originalLaunch = puppeteer.launch;
  const firstBrowser = new FakeBrowser({ pid: 505 });
  const replacementBrowser = new FakeBrowser({ pid: 606 });
  let launchCount = 0;
  const session = new ImageExportBrowserSession();

  process.env.CHROME_EXECUTABLE_PATH = process.execPath;
  puppeteer.launch = async () => {
    launchCount += 1;
    return launchCount === 1 ? firstBrowser : replacementBrowser;
  };

  try {
    await session.openPage();
    firstBrowser.disconnectTransport();

    assert.equal(session.browser, null, 'a disconnected browser must stop being reusable immediately');
    await waitFor(
      () => firstBrowser.closeCalls === 1,
      'the session must close a still-owned browser after its transport disconnects',
    );
    assert.equal(firstBrowser.process().exitCode, 0, 'the disconnected owned process must actually exit');

    await session.openPage();
    assert.equal(launchCount, 2, 'the next page request must launch exactly one replacement browser');
    assert.equal(session.browser, replacementBrowser);

    await session.close();
    assert.equal(replacementBrowser.closeCalls, 1, 'session shutdown must drain the replacement browser');
    assert.equal(replacementBrowser.process().exitCode, 0);
  } finally {
    await session.close();
    await firstBrowser.close();
    await replacementBrowser.close();
    puppeteer.launch = originalLaunch;
    if (previousChromePath === undefined) {
      delete process.env.CHROME_EXECUTABLE_PATH;
    } else {
      process.env.CHROME_EXECUTABLE_PATH = previousChromePath;
    }
  }
});

test('shutdown joins a retiring disconnected browser and the current replacement', async () => {
  const previousChromePath = process.env.CHROME_EXECUTABLE_PATH;
  const originalLaunch = puppeteer.launch;
  const firstCloseGate = deferred();
  const firstBrowser = new FakeBrowser({ closeGate: firstCloseGate, pid: 707 });
  const replacementBrowser = new FakeBrowser({ pid: 808 });
  let launchCount = 0;
  const session = new ImageExportBrowserSession();

  process.env.CHROME_EXECUTABLE_PATH = process.execPath;
  puppeteer.launch = async () => {
    launchCount += 1;
    return launchCount === 1 ? firstBrowser : replacementBrowser;
  };

  try {
    await session.openPage();
    firstBrowser.disconnectTransport();
    await waitFor(() => firstBrowser.closeCalls === 1, 'the disconnected browser must begin retiring');
    await session.openPage();

    const closing = session.close();
    await waitFor(() => replacementBrowser.closeCalls === 1, 'shutdown must also close the current replacement');
    firstCloseGate.resolve();
    await closing;

    assert.equal(firstBrowser.process().exitCode, 0);
    assert.equal(replacementBrowser.process().exitCode, 0);
    assert.equal(session.browser, null);
  } finally {
    firstCloseGate.resolve();
    await closeSessionIgnoringError(session);
    await firstBrowser.close();
    await replacementBrowser.close();
    puppeteer.launch = originalLaunch;
    if (previousChromePath === undefined) delete process.env.CHROME_EXECUTABLE_PATH;
    else process.env.CHROME_EXECUTABLE_PATH = previousChromePath;
  }
});

test('close force-kills only its exact owned process when browser close never settles', async () => {
  const previousChromePath = process.env.CHROME_EXECUTABLE_PATH;
  const originalLaunch = puppeteer.launch;
  const ownedProcess = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1_000)'], {
    detached: process.platform !== 'win32',
    stdio: 'ignore',
  });
  const ownedProcessReady = deferred();
  ownedProcess.once('spawn', ownedProcessReady.resolve);
  ownedProcess.once('error', ownedProcessReady.reject);
  await ownedProcessReady.promise;
  assert.ok(ownedProcess.pid, 'the fixture must expose its exact owned process pid');

  const browser = new FakeBrowser({ browserProcess: ownedProcess, closeNeverSettles: true });
  const session = new ImageExportBrowserSession();
  process.env.CHROME_EXECUTABLE_PATH = process.execPath;
  puppeteer.launch = async () => browser;

  try {
    await session.openPage();
    const startedAt = Date.now();
    await session.close();
    const closeElapsedMs = Date.now() - startedAt;

    assert.equal(browser.closeCalls, 1);
    assert.equal(isProcessAlive(ownedProcess.pid), false, 'bounded close must leave no owned process survivor');
    assert.ok(closeElapsedMs >= 4_500, `the force-kill path must follow the close grace (${closeElapsedMs}ms)`);
    assert.ok(closeElapsedMs < 8_000, `session close must stay bounded (${closeElapsedMs}ms)`);
  } finally {
    if (isProcessAlive(ownedProcess.pid)) ownedProcess.kill('SIGKILL');
    await closeSessionIgnoringError(session);
    puppeteer.launch = originalLaunch;
    if (previousChromePath === undefined) {
      delete process.env.CHROME_EXECUTABLE_PATH;
    } else {
      process.env.CHROME_EXECUTABLE_PATH = previousChromePath;
    }
  }
});
