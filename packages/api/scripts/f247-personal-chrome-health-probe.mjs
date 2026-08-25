import { connect } from 'node:net';

const SAFE_TOKEN = /^[A-Za-z0-9._:-]+$/;
const HEALTH_STATUSES = new Set(['ready', 'stale_adapter', 'dormant', 'failed']);
let healthRequestSequence = 0;

function healthError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function safeRevisions(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  if (Object.keys(value).some((field) => !['helper', 'extension', 'pageAdapter'].includes(field))) return undefined;
  if (!/^sha512:[a-f0-9]{128}$/.test(value.helper)) return undefined;
  if (!/^\d+\.\d+\.\d+$/.test(value.extension)) return undefined;
  if (typeof value.pageAdapter !== 'string' || !SAFE_TOKEN.test(value.pageAdapter) || value.pageAdapter.length > 32) {
    return undefined;
  }
  return { helper: value.helper, extension: value.extension, pageAdapter: value.pageAdapter };
}

export function parseHealthResult(result, requestId) {
  if (result?.v !== 2 || result?.kind !== 'health_result') {
    throw healthError('STALE_HELPER_PROTOCOL', 'personal Chrome helper does not support revision health');
  }
  if (result.requestId !== requestId || !HEALTH_STATUSES.has(result.status)) {
    throw healthError('INVALID_HEALTH_RECEIPT', 'personal Chrome helper health receipt is invalid');
  }
  if (
    result.errorCode !== undefined &&
    (typeof result.errorCode !== 'string' || !/^[A-Z][A-Z0-9_]{2,63}$/.test(result.errorCode))
  ) {
    throw healthError('INVALID_HEALTH_RECEIPT', 'personal Chrome helper health error is invalid');
  }
  const observedRevisions =
    result.observedRevisions === undefined ? undefined : safeRevisions(result.observedRevisions);
  if (result.observedRevisions !== undefined && observedRevisions === undefined) {
    throw healthError('INVALID_HEALTH_RECEIPT', 'personal Chrome helper revision receipt is invalid');
  }
  return {
    status: result.status,
    ...(result.errorCode ? { errorCode: result.errorCode } : {}),
    ...(observedRevisions ? { observedRevisions } : {}),
  };
}

export function probeNativeHostHealth(
  { socketPath, pairingSecret, expectedRevisions, conversationId },
  timeoutMs = 1_500,
) {
  return new Promise((resolveProbe, rejectProbe) => {
    const socket = connect(socketPath);
    const requestId = `health-${process.pid}-${Date.now()}-${++healthRequestSequence}`;
    let input = '';
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) rejectProbe(error);
      else resolveProbe(result);
    };
    socket.setEncoding('utf8');
    socket.once('connect', () =>
      socket.write(
        `${JSON.stringify({
          pairingSecret,
          request: {
            v: 2,
            kind: 'health_check',
            requestId,
            expectedRevisions,
            ...(conversationId ? { conversationId } : {}),
          },
        })}\n`,
      ),
    );
    socket.on('data', (chunk) => {
      input += chunk;
      if (Buffer.byteLength(input, 'utf8') > 16 * 1024) {
        finish(new Error('personal Chrome helper health receipt exceeds size limit'));
        return;
      }
      const newline = input.indexOf('\n');
      if (newline === -1) return;
      let result;
      try {
        result = JSON.parse(input.slice(0, newline));
      } catch {
        finish(new Error('personal Chrome helper health receipt is invalid'));
        return;
      }
      try {
        finish(undefined, parseHealthResult(result, requestId));
      } catch (error) {
        finish(error);
      }
    });
    socket.once('error', (error) => {
      if (error?.code === 'ENOENT' || error?.code === 'ECONNREFUSED') finish(undefined, { status: 'dormant' });
      else finish(error);
    });
    socket.setTimeout(timeoutMs, () => finish(new Error('personal Chrome helper health probe timed out')));
  });
}
