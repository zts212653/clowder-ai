import { createChatGptPageAdapter } from './chatgpt-page-adapter.mjs';

(() => {
  const APPEND_PROTOCOL_VERSION = 2;
  const EXTENSION_REVISION = '0.2.5';
  const PAGE_ADAPTER_REVISION = '2026-08-27.1';
  const previousListener = globalThis.__catCafePersonalChromeAdapterV2?.listener;
  if (typeof previousListener === 'function') chrome.runtime.onMessage.removeListener?.(previousListener);
  const adapter = createChatGptPageAdapter({
    document,
    location,
    MutationObserver,
    adapterRevision: PAGE_ADAPTER_REVISION,
    artifactRevision: EXTENSION_REVISION,
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
