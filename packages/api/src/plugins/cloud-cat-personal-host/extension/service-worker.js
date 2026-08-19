const NATIVE_HOST_NAME = 'ai.catcafe.personal_cloud_cat_host';
const SAFE_TOKEN = /^[A-Za-z0-9._:-]+$/;
const MAX_TEXT_BYTES = 128 * 1024;

let nativePort = null;
const nativeHealth = {
  connectAttempts: 0,
  connected: false,
  lastError: null,
};
globalThis.__f247NativeHealth = nativeHealth;

function validToken(value, maximum) {
  return typeof value === 'string' && value.length <= maximum && SAFE_TOKEN.test(value);
}

function validText(value) {
  return (
    typeof value === 'string' && value.trim().length > 0 && new TextEncoder().encode(value).byteLength <= MAX_TEXT_BYTES
  );
}

function postNative(message) {
  if (nativePort) nativePort.postMessage(message);
}

function failureFor(request, errorCode) {
  return {
    v: 1,
    kind: 'append_result',
    requestId: validToken(request?.requestId, 200) ? request.requestId : 'invalid-request',
    idempotencyKey: validToken(request?.idempotencyKey, 512) ? request.idempotencyKey : 'invalid-key',
    status: 'failed',
    errorCode,
  };
}

function exactConversationId(tabUrl) {
  try {
    const url = new URL(tabUrl);
    if (url.protocol !== 'https:' || url.hostname !== 'chatgpt.com') return null;
    return url.pathname.match(/^\/c\/([A-Za-z0-9-]+)\/?$/)?.[1] ?? null;
  } catch {
    return null;
  }
}

async function dispatchAppend(request) {
  if (
    request?.v !== 1 ||
    request?.kind !== 'append_message' ||
    !validToken(request.requestId, 200) ||
    !validToken(request.conversationId, 200) ||
    !validToken(request.idempotencyKey, 512) ||
    !validText(request.text)
  ) {
    postNative(failureFor(request, 'INVALID_REQUEST'));
    return;
  }
  const candidates = await chrome.tabs.query({ url: `https://chatgpt.com/c/${request.conversationId}*` });
  const matches = candidates.filter(
    (tab) => typeof tab.id === 'number' && exactConversationId(tab.url) === request.conversationId,
  );
  if (matches.length === 0) {
    postNative(failureFor(request, 'BOUND_TAB_NOT_FOUND'));
    return;
  }
  if (matches.length > 1) {
    postNative(failureFor(request, 'AMBIGUOUS_BOUND_TABS'));
    return;
  }
  postNative({
    v: 1,
    kind: 'append_progress',
    requestId: request.requestId,
    idempotencyKey: request.idempotencyKey,
    status: 'extension_received',
  });
  try {
    const result = await chrome.tabs.sendMessage(matches[0].id, request);
    if (
      result?.v !== 1 ||
      result?.kind !== 'append_result' ||
      result.requestId !== request.requestId ||
      result.idempotencyKey !== request.idempotencyKey
    ) {
      postNative(failureFor(request, 'INVALID_CONTENT_RECEIPT'));
      return;
    }
    postNative(result);
  } catch {
    postNative(failureFor(request, 'CONTENT_SCRIPT_UNAVAILABLE'));
  }
}

function connectNativeHost() {
  nativeHealth.connectAttempts += 1;
  const port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
  nativePort = port;
  nativeHealth.connected = true;
  nativeHealth.lastError = null;
  port.onMessage.addListener((message) => {
    void dispatchAppend(message).catch(() => postNative(failureFor(message, 'EXTENSION_INTERNAL_ERROR')));
  });
  port.onDisconnect.addListener(() => {
    nativeHealth.connected = false;
    nativeHealth.lastError = chrome.runtime.lastError?.message ?? 'native port disconnected';
    if (nativePort === port) nativePort = null;
    setTimeout(connectNativeHost, 1000);
  });
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.kind !== 'append_progress') return false;
  postNative(message);
  return false;
});

connectNativeHost();
