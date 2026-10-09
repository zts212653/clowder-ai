/** Synthetic native peer; only its private Unix socket is used, never Chrome or a runtime port. */
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';

export async function nativePeer(t, h, returned, { dropAppendReceipt = false } = {}) {
  const socketPath = join(h.root, 'helper.sock');
  const pairingSecret = 's'.repeat(64);
  const timestamp = '2026-09-01T00:00:00.000Z';
  const pairing = {
    schemaVersion: 1,
    extensionId: 'a'.repeat(32),
    socketPath,
    ledgerPath: join(h.dataDirectory, 'ledger.json'),
    pairingSecret,
    artifactDigest: `sha512:${'a'.repeat(128)}`,
    installedAt: timestamp,
    updatedAt: timestamp,
  };
  await writeFile(join(h.dataDirectory, 'pairing.json'), JSON.stringify(pairing), { mode: 0o600 });
  const requests = [];
  let acknowledged = false;
  function responseFor(request) {
    const base = { v: 2, requestId: request.requestId };
    switch (request.kind) {
      case 'append_message':
        return {
          ...base,
          kind: 'append_result',
          status: 'host_observed',
          idempotencyKey: request.idempotencyKey,
          hostMessageId: 'provider-1',
          observedRevisions: request.expectedRevisions,
        };
      case 'list_assistant_returns':
        return { ...base, kind: 'assistant_returns', returns: acknowledged ? [] : [returned] };
      case 'ack_assistant_return':
        acknowledged = true;
        return { ...base, kind: 'assistant_return_ack', status: 'acknowledged' };
      case 'refresh_conversation_titles':
        return {
          v: 1,
          kind: 'conversation_titles_refreshed',
          requestId: request.requestId,
          status: 'synced',
          updatedCount: 1,
          requestedCount: 1,
        };
      default:
        return undefined;
    }
  }
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let input = '';
    socket.on('data', (chunk) => {
      input += chunk.toString();
      if (!input.includes('\n')) return;
      const envelope = JSON.parse(input.slice(0, input.indexOf('\n')));
      input = '';
      const request = envelope.request;
      requests.push(envelope);
      if (envelope.pairingSecret !== pairingSecret) return socket.destroy();
      if (dropAppendReceipt && request.kind === 'append_message') return socket.destroy();
      const result = responseFor(request);
      if (!result) return socket.destroy();
      socket.end(`${JSON.stringify(result)}\n`);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return { requests, pairing };
}
