import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import puppeteer, { type Browser } from 'puppeteer-core';
import sharp from 'sharp';
import { createModuleLogger } from '../infrastructure/logger.js';
import {
  assertFreshHtmlWidgetExportCapturePlan,
  type BrowserDocumentSnapshot,
  captureVerifiedImageExportCandidate,
  readHtmlWidgetExportLayoutSnapshot,
  readImageExportCaptureHeight,
  refreshHtmlWidgetExportLayoutProof,
} from './html-widget-export-readiness.js';

export { resolveExportCaptureHeight } from './html-widget-export-readiness.js';

const log = createModuleLogger('image-exporter');

/** Chunk height for scroll-and-stitch. 4000px is well under Chrome's ~16384 GPU limit. */
const CHUNK_HEIGHT = 4000;
const INITIAL_VIEWPORT_HEIGHT = 900;
const VIEWPORT_WIDTH = 1280;

interface BrowserWindowSnapshot {
  requestAnimationFrame(callback: () => void): number;
  scrollTo(x: number, y: number): void;
}

export interface ImageExportCaptureOptions {
  selectionMessageIds?: readonly string[];
}

export function buildImageExportUrl(url: string, userId: string, options?: ImageExportCaptureOptions): string {
  const exportUrl = new URL(url);
  exportUrl.searchParams.set('export', 'true');
  exportUrl.searchParams.set('userId', userId);
  for (const messageId of options?.selectionMessageIds ?? []) {
    exportUrl.searchParams.append('messageId', messageId);
  }
  return exportUrl.toString();
}

export interface ImageExportChunk {
  buffer: Buffer;
  top: number;
}

export async function stitchImageExportChunks(
  width: number,
  height: number,
  chunks: readonly ImageExportChunk[],
): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  })
    .composite(chunks.map((chunk) => ({ input: chunk.buffer, top: chunk.top, left: 0 })))
    .png()
    .toBuffer();
}

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

/**
 * Detect a Chromium-based browser executable on the system.
 * Priority: CHROME_EXECUTABLE_PATH env > system Chrome > Edge > Chromium.
 * CDP (Chrome DevTools Protocol) requires a Chromium-based browser —
 * Firefox/Safari are not supported.
 */
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

/**
 * ImageExporter service for capturing screenshots of web pages using Chrome headless.
 * Uses scroll-and-stitch with Sharp to handle pages of any height without
 * hitting Chrome's GPU texture limit (~16384px) which causes content duplication.
 */
export class ImageExporter {
  private browser: Browser | null = null;

  /**
   * Capture a screenshot of the given URL.
   * For pages taller than CHUNK_HEIGHT, scrolls through the page in chunks
   * and stitches them together using Sharp.
   */
  async capture(url: string, userId: string, options?: ImageExportCaptureOptions): Promise<Buffer> {
    let page: puppeteer.Page | null = null;
    try {
      if (!this.browser) {
        this.browser = await puppeteer.launch({
          executablePath: detectChromePath(),
          headless: true,
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        });
      }

      page = await this.browser.newPage();
      const capturePage = page;

      await page.setExtraHTTPHeaders({ 'X-Cat-Cafe-User': userId });
      await page.setViewport({ width: VIEWPORT_WIDTH, height: INITIAL_VIEWPORT_HEIGHT });

      await page.goto(buildImageExportUrl(url, userId, options), {
        waitUntil: 'networkidle2',
        timeout: 30000,
      });

      // Wait for messages AND cat data to fully load and render.
      // data-export-ready is set by ChatContainer when !isLoadingHistory && messages.length > 0 && !isLoadingCatData.
      await page.waitForSelector('[data-export-ready="true"]', { timeout: 20000 });

      // Next's development error indicator is outside the application export root.
      // It must never become part of a user document, even when dogfooding a dev build.
      await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });

      // A sandbox iframe's internal document height is invisible to the parent page.
      // HtmlWidgetBlock bridges it explicitly and marks export expansion readiness.
      // Fail closed here instead of measuring the still-clipped iframe rectangle.
      await this.waitForHtmlWidgets(page);

      // Wait for React and responsive iframe reflow to finish changing the parent height.
      await this.waitForStableHeight(page);

      const pageHeight = await readImageExportCaptureHeight(page);
      const messageCount = await page.evaluate(() => {
        const { document } = globalThis as unknown as { document: BrowserDocumentSnapshot };
        return document.querySelectorAll('[data-message-id]').length;
      });
      if (options?.selectionMessageIds && messageCount !== options.selectionMessageIds.length) {
        throw new Error(
          `Selection DOM count mismatch: expected ${options.selectionMessageIds.length}, rendered ${messageCount}`,
        );
      }
      log.info(
        { pageHeight, messageCount, chunks: Math.ceil(pageHeight / CHUNK_HEIGHT) },
        'Page height and message count captured',
      );

      // Short page: single viewport screenshot (no stitching needed)
      if (pageHeight <= CHUNK_HEIGHT) {
        await page.setViewport({ width: VIEWPORT_WIDTH, height: pageHeight });
        await this.waitForPaint(page);
        const screenshot = await captureVerifiedImageExportCandidate(
          () => assertFreshHtmlWidgetExportCapturePlan(capturePage, pageHeight),
          () => capturePage.screenshot({ type: 'png' }),
        );
        log.info({ bytes: screenshot.length }, 'Captured single screenshot');
        return screenshot as Buffer;
      }

      // Tall page: scroll-and-stitch to avoid Chrome's tiling duplication bug
      const chunks: { buffer: Buffer; top: number; height: number }[] = [];

      await page.setViewport({ width: VIEWPORT_WIDTH, height: CHUNK_HEIGHT });
      await this.waitForPaint(page);

      // Scroll to top first
      await page.evaluate(() => (globalThis as unknown as BrowserWindowSnapshot).scrollTo(0, 0));
      await this.waitForPaint(page);

      for (let y = 0; y < pageHeight; y += CHUNK_HEIGHT) {
        const chunkH = Math.min(CHUNK_HEIGHT, pageHeight - y);

        // Scroll to this chunk's position
        await page.evaluate((scrollY: number) => {
          (globalThis as unknown as BrowserWindowSnapshot).scrollTo(0, scrollY);
        }, y);
        await this.waitForPaint(page);

        // For the last chunk, resize viewport to exact remaining height
        if (chunkH < CHUNK_HEIGHT) {
          await page.setViewport({ width: VIEWPORT_WIDTH, height: chunkH });
          await this.waitForPaint(page);
          // Re-scroll after resize: with the larger viewport, scrollTo(y) above was
          // clamped to maxScrollTop (= pageHeight - oldViewportHeight). After shrinking
          // the viewport, maxScrollTop increases, so we can now reach y.
          await page.evaluate((scrollY: number) => {
            (globalThis as unknown as BrowserWindowSnapshot).scrollTo(0, scrollY);
          }, y);
          await this.waitForPaint(page);
        }

        const chunk = await captureVerifiedImageExportCandidate(
          () => assertFreshHtmlWidgetExportCapturePlan(capturePage, pageHeight),
          async () => (await capturePage.screenshot({ type: 'png' })) as Buffer,
        );
        chunks.push({ buffer: chunk, top: y, height: chunkH });
      }

      log.info({ chunks: chunks.length }, 'Chunks captured, stitching...');

      // Stitch chunks vertically using Sharp
      const stitched = await stitchImageExportChunks(VIEWPORT_WIDTH, pageHeight, chunks);

      log.info({ bytes: stitched.length }, 'Stitched image ready');
      return stitched;
    } catch (error) {
      throw new Error(`Screenshot capture failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (page) {
        await page.close().catch((error) => {
          log.warn({ error }, 'Failed to close image export page');
        });
      }
    }
  }

  /**
   * Wait until document.scrollHeight stabilizes (no change for multiple consecutive checks).
   * Handles React rendering large message lists that may take many frames to commit.
   */
  private async waitForStableHeight(page: puppeteer.Page, maxWait = 8000, interval = 300): Promise<void> {
    const requiredStableChecks = 3;
    let lastHeight = 0;
    let stableChecks = 0;
    const start = Date.now();

    while (Date.now() - start < maxWait) {
      const { height } = await refreshHtmlWidgetExportLayoutProof(page);
      if (height === lastHeight && height > 0) {
        stableChecks++;
        if (stableChecks >= requiredStableChecks) {
          log.info({ height, elapsed: Date.now() - start }, 'Page height stabilized');
          return;
        }
      } else {
        stableChecks = 0;
        lastHeight = height;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, interval));
    }
    const elapsed = Date.now() - start;
    throw new Error(`Page height did not stabilize within maxWait (${elapsed}ms, last height ${lastHeight}px)`);
  }

  private async waitForHtmlWidgets(page: puppeteer.Page, maxWait = 10_000, interval = 100): Promise<void> {
    const start = Date.now();
    let lastPending: string[] = [];

    while (Date.now() - start < maxWait) {
      const { readiness } = await readHtmlWidgetExportLayoutSnapshot(page);
      if (readiness.status === 'ready') {
        await refreshHtmlWidgetExportLayoutProof(page);
        log.info({ widgets: readiness.widgetIds.length, elapsed: Date.now() - start }, 'HTML widgets export-ready');
        return;
      }
      if (readiness.status === 'error') {
        throw new Error(`HTML widget layout failed: ${readiness.widgetIds.join(', ')}`);
      }
      lastPending = readiness.widgetIds;
      await new Promise<void>((resolve) => setTimeout(resolve, interval));
    }

    throw new Error(`HTML widget layout did not become export-ready: ${lastPending.join(', ') || 'unknown'}`);
  }

  /** Wait for two animation frames (one paint cycle). */
  private async waitForPaint(page: puppeteer.Page): Promise<void> {
    await page.evaluate(() => {
      const browserWindow = globalThis as unknown as BrowserWindowSnapshot;
      return new Promise<void>((resolve) =>
        browserWindow.requestAnimationFrame(() => browserWindow.requestAnimationFrame(() => resolve())),
      );
    });
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}
