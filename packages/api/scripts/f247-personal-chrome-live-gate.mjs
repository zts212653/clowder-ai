#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, readFile, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import puppeteer from 'puppeteer-core';

import { RefreshablePersonalChromeHostAdapter } from '../dist/domains/cats/services/cloud-bridge/personal-chrome-host/personal-chrome-host-adapter.js';
import {
  inspectNativeHostInstallation,
  installNativeHost,
  uninstallNativeHost,
} from '../src/plugins/cloud-cat-personal-host/native-host/install-host.mjs';
import { closeIsolatedBrowser, resolveChromeExecutable } from './f247-personal-chrome-host-spike.mjs';
import {
  buildNotObservedLiveGateResult,
  conversationIdFromChatGptUrl,
  extensionIdFromManifestKey,
  extensionIdFromWorkerUrl,
  LiveGateNotObservedError,
  verifyLiveDelivery,
} from './f247-personal-chrome-live-contract.mjs';
import { prepareChromeBrowserScope } from './f247-personal-chrome-profile.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(scriptDirectory, '..');
const monorepoRoot = resolve(apiRoot, '../..');
const extensionRoot = join(apiRoot, 'src/plugins/cloud-cat-personal-host/extension');

function boundedTimeout(env) {
  const raw = env.F247_LIVE_LOGIN_TIMEOUT_MS;
  if (!raw) return 15 * 60 * 1000;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 10_000 || value > 60 * 60 * 1000) {
    throw new Error('F247_LIVE_LOGIN_TIMEOUT_MS must be an integer between 10000 and 3600000');
  }
  return value;
}

async function waitForResult(probe, { timeoutMs, label, signal, intervalMs = 250 }) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error(`${label} aborted`);
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs));
  }
  throw new Error(`${label} timed out${lastError instanceof Error ? `: ${lastError.message}` : ''}`);
}

async function waitForExtensionWorker(browser, signal) {
  return waitForResult(
    async () => {
      const target = browser
        .targets()
        .find((candidate) => candidate.type() === 'service_worker' && extensionIdFromWorkerUrl(candidate.url()));
      if (!target) return null;
      const worker = await target.worker();
      return worker ? { target, worker, extensionId: extensionIdFromWorkerUrl(target.url()) } : null;
    },
    { timeoutMs: 20_000, label: 'extension service worker', signal },
  );
}

async function findSingleConversationPage(browser) {
  const matches = [];
  for (const page of await browser.pages()) {
    const conversationId = conversationIdFromChatGptUrl(page.url());
    if (conversationId) matches.push({ page, conversationId });
  }
  return matches.length === 1 ? matches[0] : null;
}

async function existingInstallation(options) {
  try {
    return await inspectNativeHostInstallation(options);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function waitForSocket(path, signal) {
  return waitForResult(
    async () => {
      try {
        return (await stat(path)).isSocket();
      } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw error;
      }
    },
    { timeoutMs: 30_000, label: 'Chrome-started native helper socket', signal },
  );
}

async function waitForSocketRemoval(path) {
  return waitForResult(
    async () => {
      try {
        await stat(path);
        return false;
      } catch (error) {
        if (error?.code === 'ENOENT') return true;
        throw error;
      }
    },
    { timeoutMs: 10_000, label: 'native helper shutdown' },
  );
}

async function prepareGateInstallation({ projectRoot, homeDirectory, userDataDir, env }) {
  const extensionManifest = JSON.parse(await readFile(join(extensionRoot, 'manifest.json'), 'utf8'));
  const extensionId = extensionIdFromManifestKey(extensionManifest.key);
  const installOptions = {
    platform: process.platform,
    projectRoot,
    homeDirectory,
    localAppData: env.LOCALAPPDATA,
    userDataDirectory: userDataDir,
  };
  const prior = await existingInstallation(installOptions);
  if (prior && prior.extensionId !== extensionId) {
    throw new Error('an existing Personal Chrome installation belongs to a different extension ID');
  }
  return {
    extensionId,
    installOptions,
    installReceipt: prior ?? (await installNativeHost({ ...installOptions, extensionId })),
    installedByGate: prior === null,
  };
}

async function assertHelperStarted(extension, socketPath, signal) {
  try {
    await waitForSocket(socketPath, signal);
  } catch (error) {
    const nativeHealth = await extension.worker.evaluate(() => globalThis.__f247NativeHealth ?? null).catch(() => null);
    throw new Error(
      `${error instanceof Error ? error.message : 'native helper unavailable'}; Chrome Native Messaging: ${JSON.stringify(nativeHealth)}`,
    );
  }
}

async function selectLoggedInConversation(browser, env, signal) {
  const pages = await browser.pages();
  const loginPage = pages[0] ?? (await browser.newPage());
  if (!conversationIdFromChatGptUrl(loginPage.url())) {
    await loginPage.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  }
  let selected;
  try {
    selected = await waitForResult(() => findSingleConversationPage(browser), {
      timeoutMs: boundedTimeout(env),
      label: 'one logged-in ChatGPT conversation',
      signal,
      intervalMs: 500,
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('one logged-in ChatGPT conversation timed out')) {
      throw new LiveGateNotObservedError('LOGIN_CONVERSATION_NOT_OBSERVED', error.message);
    }
    throw error;
  }
  await selected.page.waitForFunction(
    () =>
      Boolean(
        document.querySelector('#prompt-textarea[contenteditable="true"]') ||
          document.querySelector('div[contenteditable="true"][data-virtualkeyboard="true"]') ||
          document.querySelector('textarea[data-id="root"]'),
      ),
    { timeout: 30_000 },
  );
  return selected;
}

async function executeLiveGate(context, { executablePath, homeDirectory, env, signal }) {
  const scope = await prepareChromeBrowserScope({ env, homeDirectory, fallbackProjectRoot: monorepoRoot });
  Object.assign(context, scope);
  const { userDataDir, projectRoot } = scope;
  const installation = await prepareGateInstallation({ projectRoot, homeDirectory, userDataDir, env });
  Object.assign(context, installation);
  process.stdout.write(
    `[F247 live] Opening Chrome profile ${scope.profileLabel}. Open exactly one non-sensitive logged-in ChatGPT conversation. One nonce will be sent after a control tab is brought to the foreground.\n`,
  );
  context.browser = await puppeteer.launch({
    executablePath,
    headless: false,
    userDataDir,
    enableExtensions: [extensionRoot],
    pipe: true,
    defaultViewport: null,
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-component-update',
      ...(scope.profileDirectory ? [`--profile-directory=${scope.profileDirectory}`] : []),
    ],
  });
  const extension = await waitForExtensionWorker(context.browser, signal);
  if (extension.extensionId !== context.extensionId) {
    throw new Error('loaded extension ID does not match the manifest key identity');
  }
  await assertHelperStarted(extension, context.installReceipt.socketPath, signal);
  context.helperStarted = true;
  const selected = await selectLoggedInConversation(context.browser, env, signal);
  const controlPage = await context.browser.newPage();
  await controlPage.goto('data:text/html,<title>Clowder AI F247 live gate control</title><h1>F247 control tab</h1>');
  await controlPage.bringToFront();
  const readActiveTabId = async () => {
    const current = await waitForExtensionWorker(context.browser, signal);
    return current.worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return tab?.id ?? null;
    });
  };
  const nonce = `F247_LIVE_GATE_${new Date().toISOString()}_${randomUUID()}`;
  const adapter = new RefreshablePersonalChromeHostAdapter({
    pairingRecordPath: context.installReceipt.pairingRecordPath,
    env: {},
    logger: { info: () => undefined, warn: () => undefined },
  });
  const delivery = await verifyLiveDelivery({
    adapter,
    conversationId: selected.conversationId,
    text: nonce,
    idempotencyKey: `f247-live-${randomUUID()}`,
    readActiveTabId,
  });
  const visibleNonceCount = await selected.page.evaluate(
    (expected) =>
      [...document.querySelectorAll('[data-message-author-role="user"][data-message-id]')].filter(
        (node) => node.textContent === expected,
      ).length,
    nonce,
  );
  if (visibleNonceCount !== 1) throw new Error(`live DOM contained ${visibleNonceCount} matching nonce messages`);
  return {
    status: 'PASS',
    coverage: 'logged-in-chatgpt-native-messaging-full-seam',
    profile: context.profileLabel,
    extensionId: context.extensionId,
    installOperation: context.installReceipt.operation,
    activeTabPreserved: delivery.activeTabPreserved,
    hostMessageId: delivery.hostMessageId,
    retryHostMessageId: delivery.retryHostMessageId,
    visibleNonceCount,
    cleanup: 'pending',
  };
}

async function cleanupLiveGate(context) {
  const errors = [];
  await closeIsolatedBrowser(context.browser).catch((error) => errors.push(error));
  if (context.installReceipt?.socketPath) {
    await waitForSocketRemoval(context.installReceipt.socketPath).catch((error) => errors.push(error));
  }
  if (context.installedByGate && !context.retainInstallation) {
    await uninstallNativeHost(context.installOptions).catch((error) => errors.push(error));
  }
  if (context.ownsUserDataDir && context.userDataDir) {
    await rm(context.userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch((error) =>
      errors.push(error),
    );
  }
  return errors;
}

export async function runPersonalChromeLiveGate({ chromePath, homeDirectory = homedir(), env = process.env } = {}) {
  const executablePath = chromePath ?? (await resolveChromeExecutable({ env }));
  await access(executablePath, fsConstants.X_OK);
  const abortController = new AbortController();
  const onInterrupt = () => abortController.abort();
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onInterrupt);
  const context = {};
  let result;
  let primaryError;
  try {
    result = await executeLiveGate(context, {
      executablePath,
      homeDirectory,
      env,
      signal: abortController.signal,
    });
  } catch (error) {
    primaryError = error;
  }
  process.off('SIGINT', onInterrupt);
  process.off('SIGTERM', onInterrupt);
  const cleanupErrors = await cleanupLiveGate(context);
  if (primaryError) {
    if (cleanupErrors.length > 0) throw new AggregateError([primaryError, ...cleanupErrors], primaryError.message);
    const notObserved = buildNotObservedLiveGateResult(primaryError, context);
    if (notObserved) return notObserved;
    throw primaryError;
  }
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'live gate cleanup failed');
  return result;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runPersonalChromeLiveGate()
    .then((result) => {
      process.stdout.write(`${JSON.stringify({ ...result, cleanup: 'complete' }, null, 2)}\n`);
      if (result.status !== 'PASS') process.exitCode = 2;
    })
    .catch((error) => {
      process.stderr.write(
        `F247 personal Chrome live gate failed: ${error instanceof Error ? error.message : 'unknown'}\n`,
      );
      process.exitCode = 1;
    });
}
