import assert from 'node:assert/strict';
import {
  callerCancellation,
  isPrefetch,
  observeCallerCancellations,
  verifiedRscCancellation,
} from './native-request-cancellations.mjs';

export async function observePageFaults(page, record) {
  record.consoleErrors ??= [];
  record.networkErrors ??= [];
  record.documentTransitions ??= [];
  record.verifiedRoutes ??= [];
  const requestPath = (request) => new URL(request.url()).pathname;
  page.on('console', (message) => {
    if (message.type() === 'error') record.consoleErrors.push(message.text().slice(0, 400));
  });
  page.on('response', (response) => {
    if (response.status() >= 400)
      record.networkErrors.push({
        method: response.request().method(),
        path: requestPath(response.request()),
        status: response.status(),
      });
  });
  const session = await page.context().newCDPSession(page);
  const stopCallerObserver = await observeCallerCancellations(page, record, session);
  const requests = new Map();
  const documents = new Map();
  const pendingNavigation = new Map();
  const visit = (tree) => {
    documents.set(tree.frame.id, tree.frame.loaderId);
    for (const child of tree.childFrames ?? []) visit(child);
  };
  await session.send('Page.enable');
  visit((await session.send('Page.getFrameTree')).frameTree);
  const initialDocuments = new Map(documents);
  session.on('Page.frameStartedNavigating', ({ frameId, loaderId }) => {
    if (loaderId && loaderId !== documents.get(frameId)) pendingNavigation.set(frameId, loaderId);
  });
  session.on('Page.frameNavigated', ({ frame }) => {
    record.documentTransitions.push({ frameId: frame.id, previous: documents.get(frame.id), current: frame.loaderId });
    documents.set(frame.id, frame.loaderId);
    pendingNavigation.delete(frame.id);
    initialDocuments.delete(frame.id);
  });
  session.on('Page.frameDetached', ({ frameId }) => {
    record.documentTransitions.push({ frameId, previous: documents.get(frameId), current: null });
    documents.delete(frameId);
    pendingNavigation.delete(frameId);
    initialDocuments.delete(frameId);
  });
  session.on('Network.requestWillBeSent', (event) => {
    requests.set(event.requestId, {
      method: event.request.method,
      path: new URL(event.request.url).pathname,
      document: event.loaderId,
      frameId: event.frameId,
      startedAt: event.wallTime * 1000,
      prefetch: isPrefetch(event.request.headers),
      rsc: Object.entries(event.request.headers).some(([name, value]) => name.toLowerCase() === 'rsc' && value === '1'),
    });
  });
  session.on('Network.responseReceived', ({ requestId, response }) => {
    const request = requests.get(requestId);
    if (request)
      Object.assign(request, {
        responseStatus: response.status,
        mimeType: response.mimeType,
        fromServiceWorker: response.fromServiceWorker === true,
      });
  });
  session.on('Network.loadingFinished', ({ requestId }) => requests.delete(requestId));
  session.on('Network.loadingFailed', (event) => {
    const request = requests.get(event.requestId);
    // Network.enable does not replay the start of an already pending fetch.
    // Constrain this case to the sole remaining initial frame's first explicit
    // document navigation, then require that navigation to really commit.
    const initial = !request && initialDocuments.size === 1 ? [...initialDocuments][0] : null;
    const target = initial && pendingNavigation.get(initial[0]);
    record.networkErrors.push({
      ...request,
      activeDocumentAtFailure: request?.frameId ? (documents.get(request.frameId) ?? null) : undefined,
      navigationTarget: pendingNavigation.get(request?.frameId),
      failure: event.errorText,
      canceled: event.canceled === true,
      failedAt: Date.now(),
      eventType: event.type,
      ...(target && ['Fetch', 'Other'].includes(event.type)
        ? {
            preObserverNavigation: { frameId: initial[0], previous: initial[1], current: target },
          }
        : {}),
    });
    requests.delete(event.requestId);
  });
  await session.send('Network.enable');
  page.on('pageerror', (error) => record.pageErrors.push(error.message));
  page.on('dialog', (dialog) => {
    const fault = { type: dialog.type(), message: dialog.message().slice(0, 400) };
    record.dialogs.push(fault);
    // Release the test runner, but the unexpected dialog still fails acceptance.
    void dialog.dismiss().catch((error) => {
      fault.dismissError = error.message;
    });
  });
  return async () => {
    await stopCallerObserver();
    await session.detach();
  };
}

export function assertLivePageHealthy(record) {
  record.expectedDocumentCancellations = [];
  record.unexpectedNetworkErrors = [];
  record.expectedCallerCancellations = [];
  record.expectedRscCancellations = [];
  for (const error of record.networkErrors ?? []) {
    // Keep every raw failure. Only the browser's exact canceled request from a
    // retired document is expected; HTTP/current/unidentified failures still fail.
    const retirement = record.documentTransitions?.find(
      (transition) =>
        transition.frameId === error.frameId &&
        transition.previous === error.document &&
        (transition.current === error.activeDocumentAtFailure || transition.current === error.navigationTarget),
    );
    const navigation =
      error.canceled &&
      error.failure === 'net::ERR_ABORTED' &&
      error.frameId &&
      error.document &&
      retirement &&
      (error.activeDocumentAtFailure !== error.document || error.navigationTarget !== undefined);
    const preObserverNavigation =
      !error.document &&
      error.canceled &&
      error.failure === 'net::ERR_ABORTED' &&
      error.preObserverNavigation &&
      record.documentTransitions?.some(
        (transition) =>
          transition.frameId === error.preObserverNavigation.frameId &&
          transition.previous === error.preObserverNavigation.previous &&
          transition.current === error.preObserverNavigation.current,
      );
    const caller = callerCancellation(error, record);
    if (navigation || preObserverNavigation) record.expectedDocumentCancellations.push(error);
    else if (caller) record.expectedCallerCancellations.push({ error, evidence: caller });
    else if (verifiedRscCancellation(error, record)) record.expectedRscCancellations.push(error);
    else record.unexpectedNetworkErrors.push(error);
  }
  for (const field of ['pageErrors', 'dialogs', 'consoleErrors', 'networkErrors', 'documentTransitions']) {
    assert.ok(Array.isArray(record[field]), `Missing live observer: ${field}`);
  }
  for (const field of ['pageErrors', 'dialogs', 'consoleErrors', 'unexpectedNetworkErrors'])
    assert.deepEqual(record[field], [], `Unexpected renderer faults: ${field}`);
}

export async function verifyVisibleRoute(page, record, testId) {
  await page.getByTestId(testId).waitFor({ state: 'visible' });
  const session = await page.context().newCDPSession(page);
  try {
    const {
      frameTree: { frame },
    } = await session.send('Page.getFrameTree');
    record.verifiedRoutes ??= [];
    record.verifiedRoutes.push({
      path: new URL(page.url()).pathname,
      frameId: frame.id,
      document: frame.loaderId,
      testId,
      verifiedAt: Date.now(),
    });
  } finally {
    await session.detach();
  }
}
