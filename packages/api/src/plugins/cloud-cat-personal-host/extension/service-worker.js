const NATIVE_HOST_NAME = 'ai.catcafe.personal_cloud_cat_host';
const NATIVE_RECONNECT_ALARM = 'f247-native-host-reconnect';
const NATIVE_RECONNECT_ALARM_DELAY_MINUTES = 0.5;
const APPEND_PROTOCOL_VERSION = 2;
const SAFE_TOKEN = /^[A-Za-z0-9._:-]+$/;
const MAX_TEXT_BYTES = 128 * 1024;
const EXTENSION_REVISION = chrome.runtime.getManifest?.().version ?? '0.2.5';
let nativePort = null;
let bindingRequestSequence = 0;
let bindingQuerySequence = 0;
let pendingBindingRequestId = null;
let pendingBindingQueryRequestId = null;
const nativeHealth = { connectAttempts: 0, connected: false, lastErrorCode: null };
globalThis.__f247NativeHealth = nativeHealth;
const conversationBinding = { status: 'unbound', conversationId: null, boundAt: null, errorCode: null };
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
function validRevisions(value) {
  return validToken(value?.helper, 135) && validToken(value?.extension, 32) && validToken(value?.pageAdapter, 32);
}

function validHealthRequest(request) {
  return (
    request?.v === APPEND_PROTOCOL_VERSION &&
    request?.kind === 'health_check' &&
    validToken(request.requestId, 200) &&
    validRevisions(request.expectedRevisions)
  );
}

function postNative(message) {
  if (!nativePort || typeof nativePort.postMessage !== 'function') return false;
  nativePort.postMessage(message);
  return true;
}

function observedRevisionsFor(request, pageAdapter = 'unobserved') {
  return {
    helper: request?.expectedRevisions?.helper,
    extension: EXTENSION_REVISION,
    pageAdapter,
  };
}

function failureFor(request, errorCode, pageAdapter) {
  return {
    v: APPEND_PROTOCOL_VERSION,
    kind: 'append_result',
    requestId: validToken(request?.requestId, 200) ? request.requestId : 'invalid-request',
    idempotencyKey: validToken(request?.idempotencyKey, 512) ? request.idempotencyKey : 'invalid-key',
    status: 'failed',
    errorCode,
    ...(validToken(request?.expectedRevisions?.helper, 135)
      ? { observedRevisions: observedRevisionsFor(request, pageAdapter) }
      : {}),
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

function exactContentResponse(response, request, kind) {
  const observed = response?.observedRevisions;
  return (
    response?.v === APPEND_PROTOCOL_VERSION &&
    response?.kind === kind &&
    response.requestId === request.requestId &&
    (kind !== 'append_result' || response.idempotencyKey === request.idempotencyKey) &&
    observed?.helper === request.expectedRevisions.helper &&
    observed?.extension === request.expectedRevisions.extension &&
    observed?.pageAdapter === request.expectedRevisions.pageAdapter
  );
}

async function sendToCurrentContentAdapter(tabId, request, resultKind) {
  let response;
  let firstError;
  try {
    response = await chrome.tabs.sendMessage(tabId, request);
  } catch (error) {
    firstError = error;
  }
  if (exactContentResponse(response, request, resultKind)) return response;
  if (!chrome.scripting?.executeScript) {
    if (firstError) throw firstError;
    return response;
  }
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content-script.js'] });
  return chrome.tabs.sendMessage(tabId, request);
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
  const expected = request?.expectedRevisions;
  if (
    request?.v !== APPEND_PROTOCOL_VERSION ||
    request?.kind !== 'append_message' ||
    !validToken(request.requestId, 200) ||
    !validToken(request.conversationId, 200) ||
    !validToken(request.idempotencyKey, 512) ||
    !validText(request.text) ||
    !validRevisions(expected)
  ) {
    postNative(failureFor(request, 'INVALID_REQUEST'));
    return;
  }
  if (expected.extension !== EXTENSION_REVISION) {
    postNative(failureFor(request, 'STALE_EXTENSION'));
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
    v: APPEND_PROTOCOL_VERSION,
    kind: 'append_progress',
    requestId: request.requestId,
    idempotencyKey: request.idempotencyKey,
    status: 'extension_received',
  });
  try {
    const contentRequest = { ...request, kind: 'append_message_v2' };
    const result = await sendToCurrentContentAdapter(matches[0].id, contentRequest, 'append_result');
    if (!exactContentResponse(result, request, 'append_result')) {
      postNative(failureFor(request, 'STALE_PAGE_ADAPTER', result?.observedRevisions?.pageAdapter));
      return;
    }
    postNative(result);
  } catch {
    postNative(failureFor(request, 'CONTENT_SCRIPT_UNAVAILABLE'));
  }
}

async function dispatchHealth(request) {
  const expected = request?.expectedRevisions;
  const result = (status, errorCode, pageAdapter = 'unobserved') => ({
    v: APPEND_PROTOCOL_VERSION,
    kind: 'health_result',
    requestId: validToken(request?.requestId, 200) ? request.requestId : 'invalid-request',
    status,
    ...(errorCode ? { errorCode } : {}),
    ...(validToken(expected?.helper, 135) ? { observedRevisions: observedRevisionsFor(request, pageAdapter) } : {}),
  });
  if (!validHealthRequest(request)) {
    postNative(result('failed', 'INVALID_HEALTH_REQUEST'));
    return;
  }
  if (expected.extension !== EXTENSION_REVISION) {
    postNative(result('stale_adapter', 'STALE_EXTENSION'));
    return;
  }
  if (!validToken(request.conversationId, 200)) {
    postNative(result('dormant'));
    return;
  }
  const candidates = await chrome.tabs.query({ url: `https://chatgpt.com/c/${request.conversationId}*` });
  const matches = candidates.filter(
    (tab) => typeof tab.id === 'number' && exactConversationId(tab.url) === request.conversationId,
  );
  if (matches.length !== 1) {
    postNative(result('dormant', matches.length > 1 ? 'AMBIGUOUS_BOUND_TABS' : 'BOUND_TAB_NOT_FOUND'));
    return;
  }
  try {
    const healthRequest = { ...request, kind: 'adapter_health' };
    const response = await sendToCurrentContentAdapter(matches[0].id, healthRequest, 'adapter_health_result');
    const observed = response?.observedRevisions;
    const exact = exactContentResponse(response, request, 'adapter_health_result');
    postNative(
      exact && response.status === 'ready'
        ? { ...result('ready', undefined, observed.pageAdapter), observedRevisions: observed }
        : {
            ...result('stale_adapter', 'STALE_PAGE_ADAPTER', observed?.pageAdapter),
            ...(observed ? { observedRevisions: observed } : {}),
          },
    );
  } catch {
    postNative(result('stale_adapter', 'CONTENT_SCRIPT_UNAVAILABLE'));
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
    if (message?.kind === 'health_check') {
      void dispatchHealth(message).catch(() =>
        postNative({
          v: APPEND_PROTOCOL_VERSION,
          kind: 'health_result',
          requestId: validToken(message?.requestId, 200) ? message.requestId : 'invalid-request',
          status: 'failed',
          errorCode: 'EXTENSION_INTERNAL_ERROR',
        }),
      );
      return;
    }
    void dispatchAppend(message).catch(() => postNative(failureFor(message, 'EXTENSION_INTERNAL_ERROR')));
  });
  port.onDisconnect.addListener(() => {
    nativeHealth.connected = false;
    nativeHealth.lastErrorCode = nativeDisconnectCode(chrome.runtime.lastError?.message);
    console.warn('F247_NATIVE_HOST_DISCONNECTED', nativeHealth.lastErrorCode);
    if (nativePort === port) {
      nativePort = null;
      pendingBindingQueryRequestId = null;
      setTimeout(() => {
        if (!nativePort) connectNativeHost();
      }, 1000);
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

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm?.name === NATIVE_RECONNECT_ALARM && !nativePort) connectNativeHost();
});

chrome.action.onClicked.addListener(bindClickedConversation);

void chrome.alarms.create(NATIVE_RECONNECT_ALARM, {
  delayInMinutes: NATIVE_RECONNECT_ALARM_DELAY_MINUTES,
  periodInMinutes: NATIVE_RECONNECT_ALARM_DELAY_MINUTES,
});
connectNativeHost();
