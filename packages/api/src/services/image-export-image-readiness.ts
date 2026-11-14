import type { Page } from 'puppeteer-core';
import {
  assertBeforeHtmlWidgetExportDeadline,
  type HtmlWidgetExportOperation,
} from './html-widget-export-readiness.js';

interface ExportImage {
  loading: string;
  complete: boolean;
}

/** Offscreen lazy images must acquire their final size before the capture height is frozen. */
export async function prepareImageExportImages(page: Page, operation: HtmlWidgetExportOperation): Promise<boolean> {
  const ready = await page.evaluate(() => {
    const { document } = globalThis as unknown as {
      document: { querySelectorAll(selector: string): ArrayLike<ExportImage> };
    };
    const images = Array.from(document.querySelectorAll('[data-export-root] img'));
    for (const image of images) image.loading = 'eager';
    // A failed image also completes; its existing error presentation can settle normally.
    return images.every((image) => image.complete);
  });
  assertBeforeHtmlWidgetExportDeadline(operation, 'image readiness');
  return ready;
}
