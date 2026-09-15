import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { createModuleLogger } from '../infrastructure/logger.js';
import {
  type BrowserCloseReason,
  hasErrorCode,
  OWNED_BROWSER_CLOSE_TIMEOUT_MS,
  OWNED_BROWSER_KILL_TIMEOUT_MS,
  type OwnedBrowser,
  processHasExited,
  settleCloseWithin,
  waitForProcessExit,
} from './image-export-browser-lifecycle.js';

const log = createModuleLogger('image-exporter');

function resolveConfiguredChromePath(): string | null {
  const envPath = process.env.CHROME_EXECUTABLE_PATH;
  if (!envPath) return null;
  if (fs.existsSync(envPath)) {
    log.info({ path: envPath }, 'Using CHROME_EXECUTABLE_PATH from env');
    return envPath;
  }
  log.warn({ path: envPath }, 'CHROME_EXECUTABLE_PATH set but file not found, falling back to auto-detect');
  return null;
}

function findLinuxBrowserCandidates(): string[] {
  const candidates: string[] = [];
  for (const name of ['google-chrome', 'google-chrome-stable', 'microsoft-edge', 'chromium', 'chromium-browser']) {
    try {
      const resolved = execFileSync('which', [name], { encoding: 'utf8' }).trim();
      if (resolved) candidates.push(resolved);
    } catch {
      // not found, continue
    }
  }
  return candidates;
}

function browserCandidatesForPlatform(): string[] {
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
  }

  if (process.platform === 'win32') {
    return [
      process.env.PROGRAMFILES ? `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe` : null,
      process.env['PROGRAMFILES(X86)']
        ? `${process.env['PROGRAMFILES(X86)']}\\Google\\Chrome\\Application\\chrome.exe`
        : null,
      process.env.PROGRAMFILES ? `${process.env.PROGRAMFILES}\\Microsoft\\Edge\\Application\\msedge.exe` : null,
    ].filter((candidate): candidate is string => Boolean(candidate));
  }

  if (process.platform === 'linux') return findLinuxBrowserCandidates();
  return [];
}

export function detectChromePath(): string {
  const configuredPath = resolveConfiguredChromePath();
  if (configuredPath) return configuredPath;

  const candidates = browserCandidatesForPlatform();
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      log.info({ path: candidate }, 'Detected Chromium-based browser');
      return candidate;
    }
  }

  throw new Error(
    `No Chromium-based browser found. Set CHROME_EXECUTABLE_PATH or install Chrome/Edge/Chromium. Searched: ${candidates.join(', ')}`,
  );
}

export class ImageExportBrowserSession {
  private currentBrowser: Browser | null = null;
  private browserLaunch: Promise<Browser> | null = null;
  private closePromise: Promise<void> | null = null;
  private closed = false;
  private readonly ownedBrowsers = new Map<Browser, OwnedBrowser>();
  private readonly browserClosures = new Map<Browser, Promise<void>>();

  get browser(): Browser | null {
    return this.currentBrowser;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Image export browser session is closed');
  }

  private async acquireBrowser(): Promise<Browser> {
    this.assertOpen();
    if (this.currentBrowser?.isConnected()) return this.currentBrowser;

    if (this.currentBrowser) {
      const staleBrowser = this.currentBrowser;
      log.warn(
        { pid: staleBrowser.process()?.pid, reason: 'stale_handle_before_capture' },
        'Discarding disconnected image export browser',
      );
      this.currentBrowser = null;
      this.drainBrowserInBackground(
        staleBrowser,
        'stale_handle_before_capture',
        'Failed to drain stale image export browser',
      );
    }

    if (this.browserLaunch) return this.browserLaunch;

    const launch = this.launchBrowser();
    this.browserLaunch = launch;
    try {
      const browser = await launch;
      this.assertOpen();
      return browser;
    } finally {
      if (this.browserLaunch === launch) this.browserLaunch = null;
    }
  }

  private async launchBrowser(): Promise<Browser> {
    const browser = await puppeteer.launch({
      executablePath: detectChromePath(),
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const owned = this.registerOwnedBrowser(browser);

    this.currentBrowser = browser;
    if (!browser.isConnected()) {
      this.currentBrowser = null;
      await this.closeOwnedBrowser(browser, 'launch_disconnect');
      throw new Error('Image export browser disconnected during launch');
    }

    log.info({ pid: owned.process?.pid, ownedBrowserCount: this.ownedBrowsers.size }, 'Image export browser ready');
    return browser;
  }

  private registerOwnedBrowser(browser: Browser): OwnedBrowser {
    const browserProcess = browser.process();
    const owned: OwnedBrowser = {
      browser,
      process: browserProcess,
      launchedAtMs: Date.now(),
      exitObserved: false,
      closeReason: null,
    };
    this.ownedBrowsers.set(browser, owned);

    browserProcess?.once('exit', (exitCode, signalCode) => {
      owned.exitObserved = true;
      if (this.currentBrowser === browser) this.currentBrowser = null;
      this.ownedBrowsers.delete(browser);
      log.info(
        {
          pid: browserProcess.pid,
          exitCode,
          signalCode,
          closeReason: owned.closeReason,
          lifetimeMs: Date.now() - owned.launchedAtMs,
          ownedBrowserCount: this.ownedBrowsers.size,
        },
        'Image export browser process exited',
      );
    });

    browser.once('disconnected', () => {
      const wasCurrent = this.currentBrowser === browser;
      if (wasCurrent) this.currentBrowser = null;
      const expected = owned.closeReason !== null;
      const processAlive = browserProcess ? !processHasExited(owned) : null;
      const details = {
        expected,
        pid: browserProcess?.pid,
        wasCurrent,
        processAlive,
        exitCode: browserProcess?.exitCode,
        signalCode: browserProcess?.signalCode,
        ownedBrowserCount: this.ownedBrowsers.size,
      };
      if (expected) {
        log.info(details, 'Image export browser transport closed');
        return;
      }

      log.warn(details, 'Image export browser transport disconnected; draining the owned process');
      if (!processHasExited(owned)) {
        this.drainBrowserInBackground(
          browser,
          'unexpected_disconnect',
          'Failed to drain image export browser after transport disconnect',
        );
      }
    });

    return owned;
  }

  private drainBrowserInBackground(browser: Browser, reason: BrowserCloseReason, failureMessage: string): void {
    void this.closeOwnedBrowser(browser, reason).catch((error) => {
      const owned = this.ownedBrowsers.get(browser);
      log.error(
        { error, pid: browser.process()?.pid, processAlive: owned ? !processHasExited(owned) : false },
        failureMessage,
      );
    });
  }

  private closeOwnedBrowser(browser: Browser, reason: BrowserCloseReason): Promise<void> {
    const existing = this.browserClosures.get(browser);
    if (existing) return existing;

    const owned = this.ownedBrowsers.get(browser);
    if (!owned) return Promise.resolve();
    owned.closeReason ??= reason;

    const close = Promise.resolve().then(() => this.finishOwnedBrowserClose(owned));
    const tracked = close.finally(() => {
      if (this.browserClosures.get(browser) === tracked) this.browserClosures.delete(browser);
    });
    this.browserClosures.set(browser, tracked);
    return tracked;
  }

  private async finishOwnedBrowserClose(owned: OwnedBrowser): Promise<void> {
    const closeAttempt = Promise.resolve().then(() => owned.browser.close());
    const outcome = await settleCloseWithin(closeAttempt, OWNED_BROWSER_CLOSE_TIMEOUT_MS);
    const exited = await waitForProcessExit(owned, 0);

    if (outcome.status === 'fulfilled' && exited) {
      this.ownedBrowsers.delete(owned.browser);
      return;
    }
    if (outcome.status === 'rejected' && exited) {
      this.ownedBrowsers.delete(owned.browser);
      log.warn(
        { error: outcome.error, pid: owned.process?.pid, closeReason: owned.closeReason },
        'Image export browser close errored after its process exited',
      );
      return;
    }

    log.warn(
      {
        error: outcome.status === 'rejected' ? outcome.error : undefined,
        pid: owned.process?.pid,
        closeReason: owned.closeReason,
        closeTimedOut: outcome.status === 'timeout',
      },
      'Image export browser did not exit during bounded close; force-killing its owned process',
    );
    this.forceKillOwnedProcess(owned);
    if (!(await waitForProcessExit(owned, OWNED_BROWSER_KILL_TIMEOUT_MS))) {
      const pid = owned.process?.pid;
      throw new Error(
        `Owned image export browser process ${pid === undefined ? 'unknown' : pid} survived forced close`,
      );
    }
    this.ownedBrowsers.delete(owned.browser);
  }

  private forceKillOwnedProcess(owned: OwnedBrowser): void {
    const browserProcess = owned.process;
    const pid = browserProcess?.pid;
    if (!browserProcess) return;
    if (pid === undefined) return;
    if (processHasExited(owned)) return;

    try {
      if (process.platform === 'win32') {
        execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 5_000 });
      } else {
        process.kill(-pid, 'SIGKILL');
      }
      return;
    } catch (error) {
      if (hasErrorCode(error, 'ESRCH')) return;
      log.warn({ error, pid }, 'Failed to kill owned image export browser process group; killing its direct child');
    }

    if (!browserProcess.kill('SIGKILL') && !processHasExited(owned)) {
      throw new Error(`Failed to force-kill owned image export browser process ${pid}`);
    }
  }

  async openPage(): Promise<Page> {
    this.assertOpen();
    const browser = await this.acquireBrowser();
    try {
      return await browser.newPage();
    } catch (error) {
      if (browser.isConnected()) throw error;
      this.assertOpen();

      if (this.currentBrowser === browser) this.currentBrowser = null;
      this.drainBrowserInBackground(
        browser,
        'page_creation_disconnect',
        'Failed to drain disconnected image export browser',
      );
      log.warn(
        { error, pid: browser.process()?.pid },
        'Image export browser disconnected before page creation; relaunching once',
      );
      const replacement = await this.acquireBrowser();
      return replacement.newPage();
    }
  }

  private async finishClose(): Promise<void> {
    const inFlightLaunch = this.browserLaunch;
    this.browserLaunch = null;
    this.currentBrowser = null;
    if (inFlightLaunch) await Promise.allSettled([inFlightLaunch]);
    this.currentBrowser = null;

    const closures = new Set(this.browserClosures.values());
    for (const browser of this.ownedBrowsers.keys()) {
      closures.add(this.closeOwnedBrowser(browser, 'session_close'));
    }
    const results = await Promise.allSettled(closures);
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure) throw failure.reason;
    if (this.ownedBrowsers.size > 0) {
      throw new Error(
        `Image export browser session closed with live owned processes: ${[...this.ownedBrowsers.values()]
          .map((owned) => (owned.process?.pid === undefined ? 'unknown' : owned.process.pid))
          .join(', ')}`,
      );
    }
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = this.finishClose();
    return this.closePromise;
  }
}
