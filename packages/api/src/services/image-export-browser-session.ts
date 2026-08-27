import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { createModuleLogger } from '../infrastructure/logger.js';

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

function detectChromePath(): string {
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
  private readonly closingBrowsers = new WeakSet<Browser>();

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
      log.warn(
        { pid: this.currentBrowser.process()?.pid, reason: 'stale_handle_before_capture' },
        'Discarding disconnected image export browser',
      );
      this.currentBrowser = null;
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
    const pid = browser.process()?.pid;

    browser.once('disconnected', () => {
      const expected = this.closingBrowsers.delete(browser);
      const wasCurrent = this.currentBrowser === browser;
      if (wasCurrent) this.currentBrowser = null;
      const details = { expected, pid, wasCurrent };
      if (expected) {
        log.info(details, 'Image export browser closed');
      } else {
        log.warn(details, 'Image export browser disconnected; the next capture will relaunch it');
      }
    });

    this.currentBrowser = browser;
    if (!browser.isConnected()) {
      this.currentBrowser = null;
      throw new Error('Image export browser disconnected during launch');
    }

    log.info({ pid }, 'Image export browser ready');
    return browser;
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
    const readyBrowser = this.currentBrowser;
    this.currentBrowser = null;
    const launchedBrowser = inFlightLaunch ? await inFlightLaunch.catch(() => null) : null;
    if (this.currentBrowser === launchedBrowser) this.currentBrowser = null;

    const browsers = new Set([readyBrowser, launchedBrowser].filter((browser): browser is Browser => browser !== null));
    for (const browser of browsers) {
      if (!browser.isConnected()) continue;
      this.closingBrowsers.add(browser);
      await browser.close();
    }
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = this.finishClose();
    return this.closePromise;
  }
}
