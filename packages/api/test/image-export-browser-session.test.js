import assert from 'node:assert/strict';
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
  constructor({ newPageEntered, pendingPage, pid }) {
    super();
    this.connected = true;
    this.newPageEntered = newPageEntered;
    this.pendingPage = pendingPage;
    this.pid = pid;
  }

  isConnected() {
    return this.connected;
  }

  process() {
    return { pid: this.pid };
  }

  async newPage() {
    this.newPageEntered?.resolve();
    if (this.pendingPage) return this.pendingPage.promise;
    return { close: async () => undefined };
  }

  async close() {
    if (!this.connected) return;
    this.connected = false;
    this.emit('disconnected');
    this.pendingPage?.reject(new Error('Connection closed.'));
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
