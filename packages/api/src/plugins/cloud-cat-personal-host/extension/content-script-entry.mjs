import { createChatGptPageAdapter } from './chatgpt-page-adapter.mjs';

(() => {
  const APPEND_PROTOCOL_VERSION = 2;
  const EXTENSION_REVISION = '0.2.10';
  const PAGE_ADAPTER_REVISION = '2026-09-02.1';
  const ASSISTANT_RETURN_RETRY_MS = 120_000;
  const previousListener = globalThis.__catCafePersonalChromeAdapterV2?.listener;
  if (typeof previousListener === 'function') chrome.runtime.onMessage.removeListener?.(previousListener);
  const helperRevisionByRequestId = new Map();
  const removeHelperRevision = (requestId) => {
    const pending = helperRevisionByRequestId.get(requestId);
    helperRevisionByRequestId.delete(requestId);
    if (pending?.cleanupTimer !== undefined) clearTimeout(pending.cleanupTimer);
    return pending?.helper;
  };
  const publishAssistantOutcome = async (kind, observed) => {
    const helper = removeHelperRevision(observed.requestId);
    if (typeof helper !== 'string') return;
    const message = {
      v: APPEND_PROTOCOL_VERSION,
      kind,
      ...observed,
      observedRevisions: {
        helper,
        extension: EXTENSION_REVISION,
        pageAdapter: PAGE_ADAPTER_REVISION,
      },
    };
    const retryDeadline = Date.now() + ASSISTANT_RETURN_RETRY_MS;
    do {
      try {
        const response = await chrome.runtime.sendMessage(message);
        if (response?.accepted === true) return;
      } catch {
        // A sleeping/reconnecting service worker is retryable while this exact tab remains open.
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    } while (Date.now() < retryDeadline);
  };
  const adapter = createChatGptPageAdapter({
    document,
    location,
    MutationObserver,
    adapterRevision: PAGE_ADAPTER_REVISION,
    artifactRevision: EXTENSION_REVISION,
    onAssistantFinal: (observed) => publishAssistantOutcome('assistant_final_observed', observed),
    onAssistantObservationFailure: (failure) => publishAssistantOutcome('assistant_observation_failed', failure),
    onProgress: async (status, context) => {
      try {
        await chrome.runtime.sendMessage({
          v: APPEND_PROTOCOL_VERSION,
          kind: 'append_progress',
          requestId: context.requestId,
          idempotencyKey: context.idempotencyKey,
          status,
        });
      } catch {
        // Progress is advisory. The final receipt remains fail-closed in the request response.
      }
    },
  });

  const listener = (request, _sender, sendResponse) => {
    if (request?.v === APPEND_PROTOCOL_VERSION && request?.kind === 'adapter_health') {
      const expected = request.expectedRevisions;
      sendResponse({
        v: APPEND_PROTOCOL_VERSION,
        kind: 'adapter_health_result',
        requestId: request.requestId,
        status:
          expected?.extension === EXTENSION_REVISION && expected?.pageAdapter === PAGE_ADAPTER_REVISION
            ? 'ready'
            : 'stale_adapter',
        observedRevisions: {
          helper: expected?.helper,
          extension: EXTENSION_REVISION,
          pageAdapter: PAGE_ADAPTER_REVISION,
        },
      });
      return false;
    }
    if (request?.v !== APPEND_PROTOCOL_VERSION || request?.kind !== 'append_message_v2') return false;
    const expected = request.expectedRevisions;
    const observedRevisions = {
      helper: expected?.helper,
      extension: EXTENSION_REVISION,
      pageAdapter: PAGE_ADAPTER_REVISION,
    };
    if (expected?.extension !== EXTENSION_REVISION || expected?.pageAdapter !== PAGE_ADAPTER_REVISION) {
      sendResponse({
        v: APPEND_PROTOCOL_VERSION,
        kind: 'append_result',
        requestId: request.requestId,
        idempotencyKey: request.idempotencyKey,
        status: 'failed',
        errorCode: 'STALE_PAGE_ADAPTER',
        observedRevisions,
      });
      return false;
    }
    removeHelperRevision(request.requestId);
    const cleanupTimer = setTimeout(() => removeHelperRevision(request.requestId), 180_000);
    helperRevisionByRequestId.set(request.requestId, { helper: expected?.helper, cleanupTimer });
    void adapter
      .appendMessage(request)
      .then((receipt) => {
        sendResponse({
          v: APPEND_PROTOCOL_VERSION,
          kind: 'append_result',
          requestId: request.requestId,
          idempotencyKey: request.idempotencyKey,
          status: 'host_observed',
          hostMessageId: receipt.hostMessageId,
          observedRevisions,
        });
      })
      .catch((error) => {
        removeHelperRevision(request.requestId);
        sendResponse({
          v: APPEND_PROTOCOL_VERSION,
          kind: 'append_result',
          requestId: request.requestId,
          idempotencyKey: request.idempotencyKey,
          status: 'failed',
          errorCode: typeof error?.code === 'string' ? error.code : 'PAGE_ADAPTER_FAILED',
          observedRevisions,
          ...(error?.diagnostic === undefined ? {} : { diagnostic: error.diagnostic }),
        });
      });
    return true;
  };
  chrome.runtime.onMessage.addListener(listener);
  globalThis.__catCafePersonalChromeAdapterV2 = {
    listener,
    extensionRevision: EXTENSION_REVISION,
    pageAdapterRevision: PAGE_ADAPTER_REVISION,
  };
})();
