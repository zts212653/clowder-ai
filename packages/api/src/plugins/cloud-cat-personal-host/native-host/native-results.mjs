const SAFE_TOKEN = /^[A-Za-z0-9._:-]+$/;
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;

export function safeToken(value, maximum) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && SAFE_TOKEN.test(value);
}

export function safeErrorCode(value) {
  return typeof value === 'string' && SAFE_ERROR_CODE.test(value);
}

export function failureFor(request, errorCode) {
  return {
    v: 1,
    kind: 'append_result',
    requestId: safeToken(request?.requestId, 200) ? request.requestId : 'invalid-request',
    idempotencyKey: safeToken(request?.idempotencyKey, 512) ? request.idempotencyKey : 'invalid-key',
    status: 'failed',
    errorCode,
  };
}

export function terminalResult(entry, requestId) {
  if (entry.state === 'host_observed') {
    return {
      v: 1,
      kind: 'append_result',
      requestId,
      idempotencyKey: entry.idempotencyKey,
      status: 'host_observed',
      hostMessageId: entry.hostMessageId,
    };
  }
  return {
    v: 1,
    kind: 'append_result',
    requestId,
    idempotencyKey: entry.idempotencyKey,
    status: 'failed',
    errorCode: entry.errorCode,
  };
}

export function applyTerminalResult(entry, result) {
  if (result.status === 'host_observed' && safeToken(result.hostMessageId, 512)) {
    entry.state = 'host_observed';
    entry.hostMessageId = result.hostMessageId;
    delete entry.errorCode;
    return;
  }
  entry.state = 'failed';
  entry.errorCode =
    result.status === 'host_observed'
      ? 'INVALID_HOST_RECEIPT'
      : safeErrorCode(result.errorCode)
        ? result.errorCode
        : 'NATIVE_DELIVERY_FAILED';
  delete entry.hostMessageId;
}
