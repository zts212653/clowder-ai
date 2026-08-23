const NATIVE_HOST_NAME = 'ai.catcafe.personal_cloud_cat_host';
const SAFE_TOKEN = /^[A-Za-z0-9._:-]+$/;
const MAX_TEXT_BYTES = 128 * 1024;

let nativePort = null;
let bindingRequestSequence = 0;
let bindingQuerySequence = 0;
let pendingBindingRequestId = null;
let pendingBindingQueryRequestId = null;
const nativeHealth = {
  connectAttempts: 0,
  connected: false,
  lastErrorCode: null,
};
globalThis.__f247NativeHealth = nativeHealth;
const conversationBinding = {
  status: 'unbound',
  conversationId: null,
  boundAt: null,
  errorCode: null,
};
globalThis.__f247ConversationBinding = conversationBinding;

function nativeDisconnectCode(message) {
  const normalized = typeof message === 'string' ? message.toLowerCase() : '';
  if (normalized.includes('not found')) return 'HOST_NOT_FOUND';
  if (normalized.includes('forbidden')) return 'HOST_FORBIDDEN';
  if (normalized.includes('failed to start')) return 'HOST_START_FAILED';
  if (normalized.includes('has exited')) return 'HOST_EXITED';
  return 'HOST_DISCONNECTED';
}

function validToken(value, maximum) {
  return typeof value === 'string' && value.length <= maximum && SAFE_TOKEN.test(value);
}

function validText(value) {
  return (
    typeof value === 'string' && value.trim().length > 0 && new TextEncoder().encode(value).byteLength <= MAX_TEXT_BYTES
  );
}

function postNative(message) {
  if (!nativePort || typeof nativePort.postMessage !== 'function') return false;
  nativePort.postMessage(message);
  return true;
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

function projectBindingState(update) {
  Object.assign(conversationBinding, update);
  const failed = update.status === 'failed';
  chrome.action.setBadgeText({ text: failed ? '!' : update.status === 'bound' ? '✓' : '' });
  chrome.action.setTitle({
    title: failed ? '授权失败：请在目标 ChatGPT 会话重试' : update.status === 'bound' ? '已授权此会话' : '授权此会话',
  });
}

function acceptBindingResult(message) {
  if (message?.v !== 1 || message?.kind !== 'binding_result') return false;
  if (message.requestId !== pendingBindingRequestId) return true;
  pendingBindingRequestId = null;
  if (message.status === 'bound' && validToken(message.conversationId, 200) && typeof message.boundAt === 'string') {
    projectBindingState({
      status: 'bound',
      conversationId: message.conversationId,
      boundAt: message.boundAt,
      errorCode: null,
    });
    return true;
  }
  projectBindingState({
    status: 'failed',
    conversationId: null,
    boundAt: null,
    errorCode: validToken(message.errorCode, 64) ? message.errorCode : 'BINDING_FAILED',
  });
  return true;
}

function acceptBindingStatus(message) {
  if (message?.v !== 1 || message?.kind !== 'binding_status') return false;
  if (message.requestId !== pendingBindingQueryRequestId) return true;
  pendingBindingQueryRequestId = null;
  if (message.status === 'bound' && validToken(message.conversationId, 200) && typeof message.boundAt === 'string') {
    projectBindingState({
      status: 'bound',
      conversationId: message.conversationId,
      boundAt: message.boundAt,
      errorCode: null,
    });
    return true;
  }
  if (message.status === 'unbound' && message.errorCode === 'NEEDS_BINDING') {
    projectBindingState({ status: 'unbound', conversationId: null, boundAt: null, errorCode: null });
    return true;
  }
  projectBindingState({
    status: 'failed',
    conversationId: null,
    boundAt: null,
    errorCode: validToken(message.errorCode, 64) ? message.errorCode : 'BINDING_FAILED',
  });
  return true;
}

async function bindClickedConversation(tab) {
  const conversationId = exactConversationId(tab?.url);
  if (!conversationId) {
    projectBindingState({ status: 'failed', conversationId: null, boundAt: null, errorCode: 'NOT_A_CONVERSATION' });
    return;
  }
  const requestId = `binding-${Date.now()}-${++bindingRequestSequence}`;
  pendingBindingQueryRequestId = null;
  pendingBindingRequestId = requestId;
  projectBindingState({ status: 'binding', conversationId, boundAt: null, errorCode: null });
  if (
    !postNative({
      v: 1,
      kind: 'bind_conversation',
      requestId,
      conversationId,
      chatUrl: `https://chatgpt.com/c/${conversationId}`,
    })
  ) {
    pendingBindingRequestId = null;
    projectBindingState({ status: 'failed', conversationId: null, boundAt: null, errorCode: 'HOST_DISCONNECTED' });
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
  nativeHealth.lastErrorCode = null;
  port.onMessage.addListener((message) => {
    if (acceptBindingStatus(message)) return;
    if (acceptBindingResult(message)) return;
    void dispatchAppend(message).catch(() => postNative(failureFor(message, 'EXTENSION_INTERNAL_ERROR')));
  });
  port.onDisconnect.addListener(() => {
    nativeHealth.connected = false;
    nativeHealth.lastErrorCode = nativeDisconnectCode(chrome.runtime.lastError?.message);
    console.warn('F247_NATIVE_HOST_DISCONNECTED', nativeHealth.lastErrorCode);
    if (nativePort === port) {
      nativePort = null;
      pendingBindingQueryRequestId = null;
      setTimeout(connectNativeHost, 1000);
    }
  });
  const requestId = `binding-query-${Date.now()}-${++bindingQuerySequence}`;
  pendingBindingQueryRequestId = requestId;
  postNative({ v: 1, kind: 'query_binding', requestId });
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.kind !== 'append_progress') return false;
  postNative(message);
  return false;
});

chrome.action.onClicked.addListener(bindClickedConversation);

connectNativeHost();
