import assert from 'node:assert/strict';
import { constants as fsConstants } from 'node:fs';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import puppeteer from 'puppeteer-core';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const apiRoot = join(scriptDirectory, '..');
const extensionRoot = join(apiRoot, 'src/plugins/cloud-cat-personal-host/extension');
const fixturePath = join(apiRoot, 'test/fixtures/f247-chatgpt-conversation.html');

function chromeExecutableCandidates(platform, env) {
  const overrides = [env.F247_CHROME_PATH, env.PUPPETEER_EXECUTABLE_PATH, env.CHROME_PATH];
  const platformDefaults =
    platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
        ]
      : platform === 'linux'
        ? ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
        : platform === 'win32'
          ? [
              env.PROGRAMFILES && join(env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'),
              env['PROGRAMFILES(X86)'] && join(env['PROGRAMFILES(X86)'], 'Google/Chrome/Application/chrome.exe'),
              env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
            ]
          : [];
  return [...new Set([...overrides, ...platformDefaults].filter(Boolean))];
}

export async function resolveChromeExecutable({
  platform = process.platform,
  env = process.env,
  accessExecutable = (candidate) => access(candidate, fsConstants.X_OK),
} = {}) {
  const candidates = chromeExecutableCandidates(platform, env);
  for (const candidate of candidates) {
    try {
      await accessExecutable(candidate);
      return candidate;
    } catch {
      // Try the next explicit or platform-native candidate.
    }
  }
  throw new Error(`Chrome executable unavailable for ${platform}; set F247_CHROME_PATH`);
}

function appendRequest(requestId) {
  return {
    v: 2,
    kind: 'append_message_v2',
    requestId,
    conversationId: 'conversation-7',
    text: 'F247_BACKGROUND_TAB_NONCE',
    idempotencyKey: 'source-message-background-proof',
    expectedRevisions: {
      helper: 'isolated-spike-helper',
      extension: '0.2.5',
      pageAdapter: '2026-08-27.1',
    },
  };
}

async function waitForExtensionWorker(browser) {
  const existing = browser
    .targets()
    .find((target) => target.type() === 'service_worker' && target.url().startsWith('chrome-extension://'));
  const target =
    existing ??
    (await browser.waitForTarget(
      (candidate) => candidate.type() === 'service_worker' && candidate.url().startsWith('chrome-extension://'),
      { timeout: 10_000 },
    ));
  const worker = await target.worker();
  if (!worker) throw new Error('extension service worker target has no worker context');
  return worker;
}

export async function closeIsolatedBrowser(browser, { timeoutMs = 5_000 } = {}) {
  if (!browser) return 'not_started';
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error('close timeout must be a positive integer');
  const browserProcess = browser.process?.();
  let timer;
  const outcome = await Promise.race([
    Promise.resolve()
      .then(() => browser.close())
      .then(
        () => 'closed',
        () => 'failed',
      ),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve('timed_out'), timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  if (outcome === 'closed') return outcome;
  browser.disconnect?.();
  browserProcess?.kill('SIGKILL');
  return 'forced';
}

export async function runPersonalChromeHostSpike({ chromePath, denyRuntimeModuleFetch = false } = {}) {
  const executablePath = chromePath ?? (await resolveChromeExecutable());
  await access(executablePath, fsConstants.X_OK);
  const fixtureHtml = await readFile(fixturePath, 'utf8');
  const userDataDir = await mkdtemp(join(tmpdir(), 'cat-cafe-f247-chrome-profile-'));
  let browser;
  let runtimeModuleFetchCount = 0;
  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      userDataDir,
      enableExtensions: [extensionRoot],
      pipe: true,
      dumpio: process.env.F247_CHROME_DUMPIO === '1',
      args: [
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-default-apps',
        '--no-first-run',
        '--no-default-browser-check',
      ],
    });
    const pages = await browser.pages();
    const controlPage = pages[0] ?? (await browser.newPage());
    await controlPage.goto('data:text/html,<title>F247 control tab</title><h1>control</h1>');

    const conversationPage = await browser.newPage();
    if (process.env.F247_CHROME_DUMPIO === '1') {
      conversationPage.on('console', (message) => process.stderr.write(`[fixture console] ${message.text()}\n`));
      conversationPage.on('pageerror', (error) => process.stderr.write(`[fixture error] ${error.message}\n`));
    }
    await conversationPage.setRequestInterception(true);
    conversationPage.on('request', (request) => {
      if (request.url() === 'https://chatgpt.com/c/conversation-7') {
        void request.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: fixtureHtml });
        return;
      }
      if (request.url().startsWith('chrome-extension://')) {
        if (request.url().endsWith('.mjs')) {
          runtimeModuleFetchCount += 1;
          if (denyRuntimeModuleFetch) {
            void request.abort();
            return;
          }
        }
        void request.continue();
        return;
      }
      void request.abort();
    });
    await conversationPage.goto('https://chatgpt.com/c/conversation-7', { waitUntil: 'domcontentloaded' });
    await conversationPage.waitForSelector('#prompt-textarea');
    await controlPage.bringToFront();

    const worker = await waitForExtensionWorker(browser);
    const activeBefore = await worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return tab?.id ?? null;
    });
    const deliverDomFixture = (request) =>
      worker.evaluate(async (payload) => {
        const tabs = await chrome.tabs.query({ url: `https://chatgpt.com/c/${payload.conversationId}*` });
        if (tabs.length !== 1 || typeof tabs[0].id !== 'number')
          throw new Error('fixture conversation tab unavailable');
        let lastError;
        for (let attempt = 0; attempt < 50; attempt += 1) {
          try {
            return await chrome.tabs.sendMessage(tabs[0].id, payload);
          } catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        }
        throw lastError;
      }, request);

    const first = await deliverDomFixture(appendRequest('browser-request-1'));
    const retry = await deliverDomFixture(appendRequest('browser-request-2'));
    const activeAfter = await worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return tab?.id ?? null;
    });
    const sendCount = await conversationPage.evaluate(() => window.__f247SendCount);

    assert.equal(first.status, 'host_observed');
    assert.equal(first.hostMessageId, 'fixture-host-message-1');
    assert.equal(retry.hostMessageId, first.hostMessageId);
    assert.equal(sendCount, 1);
    assert.equal(activeAfter, activeBefore);

    return {
      status: 'pass',
      coverage: 'dom-fixture-only',
      nativeMessagingFullSeam: 'covered-by-personal-chrome-native-messaging-integration.test.js',
      profile: 'isolated-temporary',
      target: 'intercepted-chatgpt-origin-fixture',
      activeTabPreserved: true,
      hostMessageId: first.hostMessageId,
      retryHostMessageId: retry.hostMessageId,
      sendCount,
      runtimeModuleFetchCount,
    };
  } finally {
    await closeIsolatedBrowser(browser);
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runPersonalChromeHostSpike({ denyRuntimeModuleFetch: true })
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(
        `F247 personal Chrome host spike failed: ${error instanceof Error ? error.message : 'unknown'}\n`,
      );
      process.exitCode = 1;
    });
}
