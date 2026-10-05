import { statSync } from 'node:fs';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import puppeteer, { type Browser } from 'puppeteer-core';
import { createHostLaunchedLocalNoteConnector } from '../../action/LocalNoteTrialConnector.js';
import { createOwnerLocalNoteProfile } from './owner-local-note-profile.js';

export interface OwnerLocalNoteLabOptions {
  readonly enabled: boolean;
  readonly projectRoot: string;
  readonly apiPort: number;
  readonly apiHost: string;
  readonly memoryStore: boolean;
  readonly nodeEnv: string | undefined;
}

interface HostFixture {
  readonly server: Server;
  readonly url: string;
}

interface LocalNoteLab {
  readonly url: string;
  readonly profile: ReturnType<typeof createOwnerLocalNoteProfile>;
  readonly connector: ReturnType<typeof createHostLaunchedLocalNoteConnector>;
  close(): Promise<void>;
}

const CLEANUP_MS = 2_000;

function closeServer(server: Pick<Server, 'close'>): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

/** One cleanup attempt starts both owned closes and reports an unresolved one in bounded time. */
export function createOwnerLocalNoteCleanup(
  currentBrowser: () => Pick<Browser, 'close'> | undefined,
  server: Pick<Server, 'close'>,
  timeoutMs = CLEANUP_MS,
): () => Promise<void> {
  let closing: Promise<void> | undefined;
  return () => {
    if (closing) return closing;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Isolated local note lab cleanup unconfirmed')), timeoutMs);
    });
    const resources = Promise.allSettled([
      Promise.resolve().then(() => currentBrowser()?.close()),
      Promise.resolve().then(() => closeServer(server)),
    ]).then((results) => {
      if (results.some((result) => result.status === 'rejected'))
        throw new Error('Isolated local note lab cleanup unconfirmed');
    });
    closing = Promise.race([resources, deadline]).finally(() => {
      if (timer) clearTimeout(timer);
    });
    return closing;
  };
}

export function assertOwnerLocalNoteLabIsolation(options: OwnerLocalNoteLabOptions): void {
  const git = statSync(join(options.projectRoot, '.git'), { throwIfNoEntry: false });
  if (
    !options.enabled ||
    !git?.isFile() ||
    !Number.isInteger(options.apiPort) ||
    options.apiPort < 3202 ||
    options.apiPort > 65535 ||
    options.apiHost !== '127.0.0.1' ||
    !options.memoryStore ||
    (options.nodeEnv !== 'development' && options.nodeEnv !== 'test')
  )
    throw new Error('An isolated local note lab requires a loopback memory worktree on API port 3202 or above');
}

/** Trusted fixtures may choose a physical-close budget; the Host retains its default. Never ordinary production Live. */
export async function maybeStartOwnerLocalNoteLab(
  options: OwnerLocalNoteLabOptions,
  cleanupTimeoutMs = CLEANUP_MS,
): Promise<LocalNoteLab | null> {
  if (!options.enabled) return null;
  assertOwnerLocalNoteLabIsolation(options);
  if (!Number.isSafeInteger(cleanupTimeoutMs) || cleanupTimeoutMs <= 0 || cleanupTimeoutMs > 60_000)
    throw new Error('Isolated local note lab cleanup deadline must be a positive integer at most 60000ms');
  const root = options.projectRoot;
  const serverModule = (await import(pathToFileURL(join(root, 'scripts/f317-page-action/serve.mjs')).href)) as {
    startFixtureServer(port?: number): Promise<HostFixture>;
  };
  const browserModule = (await import(
    pathToFileURL(join(root, 'scripts/f317-page-action/browser-binary.mjs')).href
  )) as {
    loadChromium(): Promise<{ executablePath(): string }>;
  };
  const fixture = await serverModule.startFixtureServer();
  let browser: Browser | undefined;
  const close = createOwnerLocalNoteCleanup(() => browser, fixture.server, cleanupTimeoutMs);
  try {
    const chromium = await browserModule.loadChromium();
    browser = await puppeteer.launch({ headless: true, executablePath: chromium.executablePath() });
    const ownedBrowser = browser;
    const profile = createOwnerLocalNoteProfile(fixture.url);
    const connector = createHostLaunchedLocalNoteConnector(fixture, ownedBrowser);
    return {
      url: fixture.url,
      profile,
      connector,
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch {
      throw new Error('Isolated local note lab cleanup unconfirmed', { cause: error });
    }
    throw error;
  }
}
