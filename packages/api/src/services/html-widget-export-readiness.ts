import { randomUUID } from 'node:crypto';
import type { Page } from 'puppeteer-core';

const HTML_WIDGET_PROOF_REQUEST_EVENT = 'catcafe:html-widget-export-proof-request';
const HTML_WIDGET_PROOF_ACK_ATTRIBUTE = 'data-html-widget-proof-request-id';
// A proof is part of the bounded layout operation. This budget covers the
// readiness challenge, three freshly-proved stable-height confirmations, and
// the pre/post screenshot proofs under renderer contention. Eight seconds was
// the old height-stability phase budget, not a sufficient whole-transaction
// budget; the operation still owns one absolute deadline and fails closed.
export const HTML_WIDGET_EXPORT_OPERATION_MAX_WAIT_MS = 12_000;

export interface HtmlWidgetExportOperation {
  readonly startedAt: number;
  readonly deadlineAt: number;
  proofSequence: number;
}

type HtmlWidgetExportDeadline = number | HtmlWidgetExportOperation;
type HtmlWidgetExportDeadlineDetails = Readonly<Record<string, string | number>>;

export function createHtmlWidgetExportOperation(
  maxWaitMs = HTML_WIDGET_EXPORT_OPERATION_MAX_WAIT_MS,
  startedAt = Date.now(),
): HtmlWidgetExportOperation {
  return { startedAt, deadlineAt: startedAt + maxWaitMs, proofSequence: 0 };
}

function resolveHtmlWidgetExportOperation(
  operation: HtmlWidgetExportDeadline = createHtmlWidgetExportOperation(),
): HtmlWidgetExportOperation {
  if (typeof operation !== 'number') return operation;
  return {
    startedAt: operation - HTML_WIDGET_EXPORT_OPERATION_MAX_WAIT_MS,
    deadlineAt: operation,
    proofSequence: 0,
  };
}

export function assertBeforeHtmlWidgetExportDeadline(
  operationDeadline: HtmlWidgetExportDeadline,
  operation: string,
  details: HtmlWidgetExportDeadlineDetails = {},
): void {
  const exportOperation = resolveHtmlWidgetExportOperation(operationDeadline);
  const now = Date.now();
  const deadlineAt = exportOperation.deadlineAt;
  if (now >= deadlineAt) {
    const diagnosticDetails = {
      ...details,
      operationElapsedMs: now - exportOperation.startedAt,
      remainingMs: deadlineAt - now,
    };
    const diagnosticText = Object.entries(diagnosticDetails)
      .map(([key, value]) => `${key}=${value}`)
      .join(', ');
    throw new Error(
      `HTML widget export operation deadline exceeded during ${operation}${diagnosticText ? ` (${diagnosticText})` : ''}`,
    );
  }
}

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

export async function readImageExportCaptureHeight(page: Page, operation?: HtmlWidgetExportDeadline): Promise<number> {
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
  if (operation !== undefined) assertBeforeHtmlWidgetExportDeadline(operation, 'capture height read');
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

export async function refreshHtmlWidgetExportLayoutProof(
  page: Page,
  operationDeadline: HtmlWidgetExportDeadline = createHtmlWidgetExportOperation(),
  interval = 25,
) {
  const operation = resolveHtmlWidgetExportOperation(operationDeadline);
  const proofSequence = ++operation.proofSequence;
  const proofStartedAt = Date.now();
  const proofRequestId = `export-${randomUUID()}`;
  const proofDetails = (proofStage: string, pendingWidgets: readonly string[] = []) => ({
    proofSequence,
    proofStage,
    proofElapsedMs: Date.now() - proofStartedAt,
    ...(pendingWidgets.length > 0 ? { pendingWidgets: pendingWidgets.join('|') } : {}),
  });
  assertBeforeHtmlWidgetExportDeadline(operation, 'layout proof', proofDetails('before-dispatch'));
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
  assertBeforeHtmlWidgetExportDeadline(operation, 'layout proof', proofDetails('after-dispatch'));

  let lastPending: string[] = [];
  while (true) {
    assertBeforeHtmlWidgetExportDeadline(operation, 'layout proof', proofDetails('before-snapshot', lastPending));
    const snapshot = await readHtmlWidgetExportLayoutSnapshot(page, proofRequestId);
    assertBeforeHtmlWidgetExportDeadline(
      operation,
      'layout proof',
      proofDetails('after-snapshot', snapshot.readiness.widgetIds),
    );
    if (snapshot.readiness.status === 'error') {
      throw new Error(`HTML widget layout failed: ${snapshot.readiness.widgetIds.join(', ')}`);
    }
    if (snapshot.readiness.status === 'ready') return snapshot;
    lastPending = snapshot.readiness.widgetIds;
    const remainingWait = operation.deadlineAt - Date.now();
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(interval, remainingWait)));
  }
}

export async function assertFreshHtmlWidgetExportCapturePlan(
  page: Page,
  expectedHeight: number,
  operationDeadline: HtmlWidgetExportDeadline = createHtmlWidgetExportOperation(),
): Promise<void> {
  const operation = resolveHtmlWidgetExportOperation(operationDeadline);
  await refreshHtmlWidgetExportLayoutProof(page, operation);
  assertBeforeHtmlWidgetExportDeadline(operation, 'capture plan');
  const actualHeight = await readImageExportCaptureHeight(page, operation);
  assertBeforeHtmlWidgetExportDeadline(operation, 'capture plan');
  if (actualHeight !== expectedHeight) {
    throw new Error(`HTML widget layout changed after capture plan: ${expectedHeight}px -> ${actualHeight}px`);
  }
}

export async function captureVerifiedImageExportCandidate<T>(
  assertFreshCapturePlan: (operation: HtmlWidgetExportOperation) => Promise<void>,
  captureCandidate: () => Promise<T>,
  operationDeadline: HtmlWidgetExportDeadline = createHtmlWidgetExportOperation(),
): Promise<T> {
  const operation = resolveHtmlWidgetExportOperation(operationDeadline);
  assertBeforeHtmlWidgetExportDeadline(operation, 'capture transaction');
  await assertFreshCapturePlan(operation);
  assertBeforeHtmlWidgetExportDeadline(operation, 'capture transaction');
  const candidate = await captureCandidate();
  assertBeforeHtmlWidgetExportDeadline(operation, 'capture transaction');
  await assertFreshCapturePlan(operation);
  assertBeforeHtmlWidgetExportDeadline(operation, 'capture transaction');
  return candidate;
}
