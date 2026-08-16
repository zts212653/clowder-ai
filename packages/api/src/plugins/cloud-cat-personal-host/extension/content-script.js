void (async () => {
  const { createChatGptPageAdapter } = await import(chrome.runtime.getURL('chatgpt-page-adapter.mjs'));
  const adapter = createChatGptPageAdapter({
    document,
    location,
    MutationObserver,
    onProgress: async (status, context) => {
      try {
        await chrome.runtime.sendMessage({
          v: 1,
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

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request?.v !== 1 || request?.kind !== 'append_message') return false;
    void adapter
      .appendMessage(request)
      .then((receipt) => {
        sendResponse({
          v: 1,
          kind: 'append_result',
          requestId: request.requestId,
          idempotencyKey: request.idempotencyKey,
          status: 'host_observed',
          hostMessageId: receipt.hostMessageId,
        });
      })
      .catch((error) => {
        sendResponse({
          v: 1,
          kind: 'append_result',
          requestId: request.requestId,
          idempotencyKey: request.idempotencyKey,
          status: 'failed',
          errorCode: typeof error?.code === 'string' ? error.code : 'PAGE_ADAPTER_FAILED',
        });
      });
    return true;
  });
})();
