import puppeteer, { type Browser } from 'puppeteer';
import sharp from 'sharp';
import { createModuleLogger } from '../infrastructure/logger.js';

const log = createModuleLogger('image-exporter');

/** Chunk height for scroll-and-stitch. 4000px is well under Chrome's ~16384 GPU limit. */
const CHUNK_HEIGHT = 4000;
const VIEWPORT_WIDTH = 1280;

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
  async capture(url: string, userId: string): Promise<Buffer> {
    try {
      if (!this.browser) {
        this.browser = await puppeteer.launch({
          headless: true,
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        });
      }

      const page = await this.browser.newPage();

      await page.setExtraHTTPHeaders({ 'X-Cat-Cafe-User': userId });
      await page.setViewport({ width: VIEWPORT_WIDTH, height: CHUNK_HEIGHT });

      const exportUrl = new URL(url);
      exportUrl.searchParams.set('export', 'true');
      exportUrl.searchParams.set('userId', userId);

      await page.goto(exportUrl.toString(), {
        waitUntil: 'networkidle2',
        timeout: 30000,
      });

      // Wait for messages AND cat data to fully load and render.
      // data-export-ready is set by ChatContainer when !isLoadingHistory && messages.length > 0 && !isLoadingCatData.
      await page.waitForSelector('[data-export-ready="true"]', { timeout: 20000 });

      // Wait for React to finish rendering all messages (height stabilizes)
      await this.waitForStableHeight(page);

      const pageHeight = await page.evaluate(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        () => (globalThis as any).document.documentElement.scrollHeight as number,
      );
      const messageCount = await page.evaluate(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        () => ((globalThis as any).document.querySelectorAll('[data-message-id]') ?? []).length,
      );
      log.info(
        { pageHeight, messageCount, chunks: Math.ceil(pageHeight / CHUNK_HEIGHT) },
        'Page height and message count captured',
      );

      // Short page: single viewport screenshot (no stitching needed)
      if (pageHeight <= CHUNK_HEIGHT) {
        await page.setViewport({ width: VIEWPORT_WIDTH, height: pageHeight });
        await this.waitForPaint(page);
        const screenshot = await page.screenshot({ type: 'png' });
        log.info({ bytes: screenshot.length }, 'Captured single screenshot');
        await page.close();
        return screenshot as Buffer;
      }

      // Tall page: scroll-and-stitch to avoid Chrome's tiling duplication bug
      const chunks: { buffer: Buffer; top: number; height: number }[] = [];

      // Scroll to top first
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await page.evaluate(() => (globalThis as any).window.scrollTo(0, 0));
      await this.waitForPaint(page);

      for (let y = 0; y < pageHeight; y += CHUNK_HEIGHT) {
        const chunkH = Math.min(CHUNK_HEIGHT, pageHeight - y);

        // Scroll to this chunk's position
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await page.evaluate((scrollY: number) => {
          (globalThis as any).window.scrollTo(0, scrollY);
        }, y);
        await this.waitForPaint(page);

        // For the last chunk, resize viewport to exact remaining height
        if (chunkH < CHUNK_HEIGHT) {
          await page.setViewport({ width: VIEWPORT_WIDTH, height: chunkH });
          await this.waitForPaint(page);
          // Re-scroll after resize: with the larger viewport, scrollTo(y) above was
          // clamped to maxScrollTop (= pageHeight - oldViewportHeight). After shrinking
          // the viewport, maxScrollTop increases, so we can now reach y.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await page.evaluate((scrollY: number) => {
            (globalThis as any).window.scrollTo(0, scrollY);
          }, y);
          await this.waitForPaint(page);
        }

        const chunk = (await page.screenshot({ type: 'png' })) as Buffer;
        chunks.push({ buffer: chunk, top: y, height: chunkH });
      }

      log.info({ chunks: chunks.length }, 'Chunks captured, stitching...');

      // Stitch chunks vertically using Sharp
      const stitched = await sharp({
        create: {
          width: VIEWPORT_WIDTH,
          height: pageHeight,
          channels: 4,
          background: { r: 255, g: 255, b: 255, alpha: 1 },
        },
      })
        .composite(
          chunks.map((c) => ({
            input: c.buffer,
            top: c.top,
            left: 0,
          })),
        )
        .png()
        .toBuffer();

      log.info({ bytes: stitched.length }, 'Stitched image ready');
      await page.close();
      return stitched;
    } catch (error) {
      throw new Error(`Screenshot capture failed: ${error instanceof Error ? error.message : String(error)}`);
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
      const height = await page.evaluate(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        () => (globalThis as any).document.documentElement.scrollHeight as number,
      );
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
    log.warn({ lastHeight, elapsed: Date.now() - start }, 'Page height did not stabilize within maxWait, proceeding');
  }

  /** Wait for two animation frames (one paint cycle). */
  private async waitForPaint(page: puppeteer.Page): Promise<void> {
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (globalThis as any).requestAnimationFrame(() =>
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (globalThis as any).requestAnimationFrame(() => resolve()),
          ),
        ),
    );
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}
