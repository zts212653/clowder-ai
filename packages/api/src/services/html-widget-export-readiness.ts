import { randomUUID } from 'node:crypto';
import type { Page } from 'puppeteer-core';

const HTML_WIDGET_PROOF_REQUEST_EVENT = 'catcafe:html-widget-export-proof-request';
const HTML_WIDGET_PROOF_ACK_ATTRIBUTE = 'data-html-widget-proof-request-id';

export interface BrowserElementSnapshot {
  scrollHeight: number;
  getBoundingClientRect(): { height: number };
}

export interface BrowserAttributeElement {
  getAttribute(name: string): string | null;
}

export interface BrowserDocumentSnapshot {
  documentElement: { scrollHeight: number };
  querySelector(selector: string): BrowserElementSnapshot | null;
  querySelectorAll(selector: string): ArrayLike<BrowserAttributeElement>;
}

export function resolveExportCaptureHeight(metrics: {
  documentHeight: number;
  exportRootHeight: number | null;
}): number {
  const candidate =
    metrics.exportRootHeight && metrics.exportRootHeight > 0 ? metrics.exportRootHeight : metrics.documentHeight;
  return Math.max(1, Math.ceil(candidate));
}

export async function readImageExportCaptureHeight(page: Page): Promise<number> {
  const captureMetrics = await page.evaluate(() => {
    const { document } = globalThis as unknown as { document: BrowserDocumentSnapshot };
    const exportRoot = document.querySelector('[data-export-root]');
    return {
      documentHeight: document.documentElement.scrollHeight as number,
      exportRootHeight: exportRoot
        ? Math.max(exportRoot.scrollHeight, exportRoot.getBoundingClientRect().height)
        : null,
    };
  });
  return resolveExportCaptureHeight(captureMetrics);
}

export interface HtmlWidgetExportLayout {
  widgetId: string;
  layoutState: string | null;
  expanded: boolean;
  proofRequestId: string | null;
}

export type HtmlWidgetExportReadiness = {
  status: 'ready' | 'pending' | 'error';
  widgetIds: string[];
};

export function resolveHtmlWidgetExportReadiness(
  widgets: readonly HtmlWidgetExportLayout[],
  requiredProofRequestId?: string,
): HtmlWidgetExportReadiness {
  const failed = widgets.filter((widget) => widget.layoutState === 'error').map((widget) => widget.widgetId);
  if (failed.length > 0) return { status: 'error', widgetIds: failed };

  const pending = widgets
    .filter(
      (widget) =>
        widget.layoutState !== 'ready' ||
        !widget.expanded ||
        (requiredProofRequestId !== undefined && widget.proofRequestId !== requiredProofRequestId),
    )
    .map((widget) => widget.widgetId);
  if (pending.length > 0) return { status: 'pending', widgetIds: pending };

  return { status: 'ready', widgetIds: widgets.map((widget) => widget.widgetId) };
}

export async function readHtmlWidgetExportLayoutSnapshot(page: Page, requiredProofRequestId?: string) {
  const snapshot = await page.evaluate((proofAckAttribute: string) => {
    const browserGlobal = globalThis as unknown as { document: BrowserDocumentSnapshot };
    return {
      height: browserGlobal.document.documentElement.scrollHeight,
      widgets: Array.from(browserGlobal.document.querySelectorAll('[data-html-widget]')).map((element) => ({
        widgetId: element.getAttribute('data-html-widget') ?? 'unknown',
        layoutState: element.getAttribute('data-html-widget-layout-state'),
        expanded: element.getAttribute('data-html-widget-expanded') === 'true',
        proofRequestId: element.getAttribute(proofAckAttribute),
      })),
    };
  }, HTML_WIDGET_PROOF_ACK_ATTRIBUTE);
  return {
    height: snapshot.height,
    readiness: resolveHtmlWidgetExportReadiness(snapshot.widgets, requiredProofRequestId),
  };
}

export async function refreshHtmlWidgetExportLayoutProof(page: Page, maxWait = 2_000, interval = 25) {
  const proofRequestId = `export-${randomUUID()}`;
  await page.evaluate(
    (eventName: string, requestId: string) => {
      const browserGlobal = globalThis as unknown as {
        CustomEvent: new (type: string, init: { detail: string }) => unknown;
        dispatchEvent(event: unknown): boolean;
      };
      browserGlobal.dispatchEvent(new browserGlobal.CustomEvent(eventName, { detail: requestId }));
    },
    HTML_WIDGET_PROOF_REQUEST_EVENT,
    proofRequestId,
  );

  const start = Date.now();
  let lastPending: string[] = [];
  while (Date.now() - start < maxWait) {
    const snapshot = await readHtmlWidgetExportLayoutSnapshot(page, proofRequestId);
    if (snapshot.readiness.status === 'error') {
      throw new Error(`HTML widget layout failed: ${snapshot.readiness.widgetIds.join(', ')}`);
    }
    if (snapshot.readiness.status === 'ready') return snapshot;
    lastPending = snapshot.readiness.widgetIds;
    await new Promise<void>((resolve) => setTimeout(resolve, interval));
  }

  throw new Error(
    `HTML widget layout proof did not refresh: ${lastPending.join(', ') || 'unknown'} (${proofRequestId})`,
  );
}

export async function assertFreshHtmlWidgetExportCapturePlan(page: Page, expectedHeight: number): Promise<void> {
  await refreshHtmlWidgetExportLayoutProof(page);
  const actualHeight = await readImageExportCaptureHeight(page);
  if (actualHeight !== expectedHeight) {
    throw new Error(`HTML widget layout changed after capture plan: ${expectedHeight}px -> ${actualHeight}px`);
  }
}

export async function captureVerifiedImageExportCandidate<T>(
  assertFreshCapturePlan: () => Promise<void>,
  captureCandidate: () => Promise<T>,
): Promise<T> {
  await assertFreshCapturePlan();
  const candidate = await captureCandidate();
  await assertFreshCapturePlan();
  return candidate;
}
