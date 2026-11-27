import type { ResolvedMessageSelectionItem } from '@cat-cafe/shared';
import type { Page } from 'puppeteer-core';
import sharp from 'sharp';
import { createModuleLogger } from '../infrastructure/logger.js';
import { createHtmlWidgetExportOperation, type HtmlWidgetExportOperation } from './html-widget-export-readiness.js';
import { ImageExportBrowserSession } from './image-export-browser-session.js';
import { prepareImageExportImages } from './image-export-image-readiness.js';

export { resolveExportCaptureHeight } from './html-widget-export-readiness.js';

const log = createModuleLogger('image-exporter');

/** Chunk height for scroll-and-stitch. 4000px is well under Chrome's ~16384 GPU limit. */
const CHUNK_HEIGHT = 4000;
const INITIAL_VIEWPORT_HEIGHT = 900;
const VIEWPORT_WIDTH = 1280;

const EXPORT_VIEW = '[data-view="thread.export"]';
const EXPORT_STREAM = `${EXPORT_VIEW} [data-stream]`;

interface ExportElement {
  parentElement: ExportElement | null;
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
  getBoundingClientRect(): { height: number; width: number; left: number; top: number };
  getAttribute(name: string): string | null;
  querySelector(selector: string): ExportElement | null;
  querySelectorAll(selector: string): ArrayLike<ExportElement>;
}
interface ExportWindow {
  __settled(): Promise<unknown>;
  document: { querySelector(selector: string): ExportElement | null };
  getComputedStyle(element: ExportElement): { overflowY: string; paddingBottom: string };
  scrollTo(x: number, y: number): void;
}

export interface ImageExportCaptureOptions {
  selectionMessageIds?: readonly string[];
  selectionItems?: readonly ResolvedMessageSelectionItem[];
}

export function buildImageExportUrl(url: string, userId: string, options?: ImageExportCaptureOptions): string {
  const exportUrl = new URL(url);
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

export async function readThreadExportSnapshot(page: Page): Promise<{ height: number; mids: string[] }> {
  return page.evaluate((selector: string) => {
    const browser = globalThis as unknown as ExportWindow;
    const view = browser.document.querySelector(selector)!;
    const stream = view.querySelector('[data-stream]')!;
    return {
      height: Math.max(
        1,
        Math.ceil(
          stream.scrollHeight +
            stream.getBoundingClientRect().top -
            view.getBoundingClientRect().top +
            Number.parseFloat(browser.getComputedStyle(view).paddingBottom),
        ),
      ),
      mids: Array.from(stream.querySelectorAll(':scope > [data-mid]')).map((el) => el.getAttribute('data-mid')!),
    };
  }, EXPORT_VIEW);
}

export function assertThreadExportSnapshot(
  expected: { height: number; mids: string[] },
  actual: { height: number; mids: string[] },
) {
  if (
    expected.height !== actual.height ||
    expected.mids.length !== actual.mids.length ||
    expected.mids.some((mid, i) => mid !== actual.mids[i])
  )
    throw new Error('Engine export content changed during capture');
}

/**
 * ImageExporter service for capturing screenshots of web pages using Chrome headless.
 * Uses scroll-and-stitch with Sharp to handle pages of any height without
 * hitting Chrome's GPU texture limit (~16384px) which causes content duplication.
 */
export class ImageExporter {
  private readonly browserSession = new ImageExportBrowserSession();

  private get browser() {
    return this.browserSession.browser;
  }

  /** Capture the engine's read-only export frame; no old JSX export page participates. */
  async capture(url: string, userId: string, options?: ImageExportCaptureOptions): Promise<Buffer> {
    let page: Page | null = null;
    try {
      page = await this.browserSession.openPage();
      await page.setExtraHTTPHeaders({ 'X-Cat-Cafe-User': userId });
      await page.setViewport({ width: VIEWPORT_WIDTH, height: INITIAL_VIEWPORT_HEIGHT });
      if (options?.selectionItems) {
        await page.evaluateOnNewDocument((items) => {
          (globalThis as unknown as { __catCafeImageExportItems: typeof items }).__catCafeImageExportItems = items;
        }, options.selectionItems);
      }
      await page.goto(buildImageExportUrl(url, userId, options), { waitUntil: 'networkidle2', timeout: 30000 });
      // The data binding starts this view only after its authoritative history is loaded.
      await page.waitForSelector(EXPORT_STREAM, { timeout: 20000 });
      const operation = createHtmlWidgetExportOperation();
      const deadline = operation.deadlineAt;
      await this.waitForSettled(page, operation);
      const snapshot = await readThreadExportSnapshot(page);
      if (
        options?.selectionMessageIds &&
        (snapshot.mids.length !== options.selectionMessageIds.length ||
          options.selectionMessageIds.some((mid) => !snapshot.mids.includes(mid)))
      ) {
        throw new Error('Selection DOM identities do not match the resolved selection');
      }
      const height = snapshot.height;
      const chunks: ImageExportChunk[] = [];
      for (let top = 0; top < height; top += CHUNK_HEIGHT) {
        const chunkHeight = Math.min(CHUNK_HEIGHT, height - top);
        await page.setViewport({ width: VIEWPORT_WIDTH, height: chunkHeight });
        await page.evaluate(
          (offset: number, selector: string) => {
            const browser = globalThis as unknown as ExportWindow;
            const view = browser.document.querySelector(selector)!;
            // A full-window frame may own its scroll instead of the browser window.
            let owner: ExportElement | null = view;
            while (
              owner &&
              !(
                owner.scrollHeight > owner.clientHeight && /auto|scroll/.test(browser.getComputedStyle(owner).overflowY)
              )
            )
              owner = owner.parentElement;
            if (owner) owner.scrollTop = offset;
            else browser.scrollTo(0, offset);
          },
          top,
          EXPORT_VIEW,
        );
        await this.waitForSettled(page, operation);
        const before = await readThreadExportSnapshot(page);
        assertThreadExportSnapshot(snapshot, before);
        const buffer = (await page.screenshot({ type: 'png' })) as Buffer;
        await this.waitForSettled(page, operation);
        assertThreadExportSnapshot(snapshot, await readThreadExportSnapshot(page));
        chunks.push({ buffer, top });
      }
      const result =
        chunks.length === 1 ? chunks[0].buffer : await stitchImageExportChunks(VIEWPORT_WIDTH, height, chunks);
      if (Date.now() >= deadline) throw new Error('Engine export capture deadline exceeded');
      log.info(
        { height, messages: snapshot.mids.length, chunks: chunks.length, bytes: result.length },
        'Engine export captured',
      );
      return result;
    } catch (error) {
      throw new Error(`Screenshot capture failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (page) await page.close().catch((error) => log.warn({ error }, 'Failed to close image export page'));
    }
  }

  private async waitForSettled(page: Page, operation: HtmlWidgetExportOperation): Promise<void> {
    for (;;) {
      const timeout = operation.deadlineAt - Date.now();
      if (timeout <= 0) throw new Error('Engine export capture deadline exceeded');
      await page.waitForFunction(
        async () => {
          const browser = globalThis as unknown as ExportWindow;
          await browser.__settled();
          return true;
        },
        { timeout },
      );
      if (Date.now() >= operation.deadlineAt) throw new Error('Engine export capture deadline exceeded');
      if (await prepareImageExportImages(page, operation, EXPORT_VIEW)) return;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(100, operation.deadlineAt - Date.now())));
    }
  }

  async close(): Promise<void> {
    await this.browserSession.close();
  }
}
