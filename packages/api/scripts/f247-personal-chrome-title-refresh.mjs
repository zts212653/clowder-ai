import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { readPersonalChromePairingRecord } from '../src/plugins/cloud-cat-personal-host/native-host/pairing-record.mjs';

const unavailable = (errorCode) => ({ status: 'unavailable', errorCode });

export function parseConversationTitleRefreshResult(value, requestId) {
  if (value?.v !== 1 || value?.kind !== 'conversation_titles_refreshed') return unavailable('STALE_HELPER_PROTOCOL');
  if (value.requestId !== requestId) return unavailable('INVALID_TITLE_RECEIPT');
  if (
    value.status === 'unavailable' &&
    typeof value.errorCode === 'string' &&
    /^[A-Z][A-Z0-9_]{2,63}$/.test(value.errorCode)
  )
    return unavailable(value.errorCode);
  if (
    value.status !== 'synced' ||
    !Number.isInteger(value.updatedCount) ||
    !Number.isInteger(value.requestedCount) ||
    value.updatedCount < 0 ||
    value.updatedCount > value.requestedCount ||
    value.requestedCount > 32
  )
    return unavailable('INVALID_TITLE_RECEIPT');
  return { status: 'synced', updatedCount: value.updatedCount, requestedCount: value.requestedCount };
}

export async function refreshNativeConversationTitles({ pairingRecordPath, expectedHelperRevision }) {
  const record = await readPersonalChromePairingRecord(pairingRecordPath);
  return new Promise((resolve) => {
    const socket = connect(record.socketPath);
    const requestId = randomUUID();
    let input = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      resolve(result);
    };
    // Absolute deadline: a peer cannot extend the operation with partial bytes.
    const deadline = setTimeout(() => finish(unavailable('TITLE_SYNC_TIMEOUT')), 4000);
    socket.setEncoding('utf8');
    socket.once('connect', () =>
      socket.write(
        `${JSON.stringify({
          pairingSecret: record.pairingSecret,
          request: { v: 1, kind: 'refresh_conversation_titles', requestId, expectedHelperRevision },
        })}\n`,
      ),
    );
    socket.on('data', (chunk) => {
      input += chunk;
      if (Buffer.byteLength(input) > 4096) return finish(unavailable('INVALID_TITLE_RECEIPT'));
      const newline = input.indexOf('\n');
      if (newline === -1) return;
      try {
        finish(parseConversationTitleRefreshResult(JSON.parse(input.slice(0, newline)), requestId));
      } catch {
        finish(unavailable('INVALID_TITLE_RECEIPT'));
      }
    });
    socket.once('error', () => finish(unavailable('CHROME_DISCONNECTED')));
    socket.once('end', () => finish(unavailable('CHROME_DISCONNECTED')));
  });
}

function titleRefreshBlocker(state) {
  if (state.platformSupport !== 'supported') return 'UNSUPPORTED_PLATFORM';
  if (['stale', 'invalid'].includes(state.artifact.helper)) return 'HELPER_UPDATE_REQUIRED';
  if (state.artifact.helper !== 'ready') return 'HELPER_NOT_INSTALLED';
  if (state.authorization.status === 'invalid') return 'AUTHORIZATION_INVALID';
  if (['STALE_EXTENSION', 'STALE_HELPER', 'STALE_HELPER_PROTOCOL'].includes(state.live.errorCode))
    return 'EXTENSION_RELOAD_REQUIRED';
  return undefined;
}

export async function refreshPersonalChromeConversationTitles({ inspect, pairingRecordPath, refreshTitlesFromHost }) {
  const state = await inspect();
  const blocked = (code) => ({ ...state, titleSync: unavailable(code) });
  const blocker = titleRefreshBlocker(state);
  if (blocker) return blocked(blocker);
  if (!state.authorization.count)
    return { ...state, titleSync: { status: 'synced', updatedCount: 0, requestedCount: 0 } };
  // Revision-only health is dormant without a selected page. Title observation
  // needs an authenticated extension, not a send-ready page or a new binding.
  if (!state.live.expectedRevisions?.helper) return blocked('CHROME_DISCONNECTED');
  try {
    const titleSync = await refreshTitlesFromHost({
      pairingRecordPath,
      expectedHelperRevision: state.live.expectedRevisions.helper,
    });
    return { ...(await inspect()), titleSync };
  } catch {
    return blocked('TITLE_SYNC_UNAVAILABLE');
  }
}
