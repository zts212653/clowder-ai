import { parentPort } from 'node:worker_threads';
import { ManagedJobService } from '../ManagedJobService.js';
import type { ManagedJobActiveReadInput, ManagedJobActiveReadReply } from './active-ledger-reader.js';

function readError(error: unknown): { name: string; message: string; code?: string } {
  return {
    name: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof Error && 'code' in error && typeof error.code === 'string' ? { code: error.code } : {}),
  };
}

/** Keep module imports warm; each operation still opens/closes the canonical SQLite read afresh. */
export function serveManagedJobActiveReads(input: ManagedJobActiveReadInput): Promise<void> {
  const service = new ManagedJobService(
    input.dataRoot,
    input.maxConcurrent,
    input.operatorUserId,
    input.supervisorEpoch,
  );
  const port = parentPort;
  if (!port) throw new Error('Managed active reader requires a worker port');
  return new Promise((resolve) => {
    const receive = async (request: { kind: 'read'; id: number } | { kind: 'close' }) => {
      if (request.kind === 'close') {
        port.off('message', receive);
        resolve();
        return;
      }
      if (request.kind !== 'read' || !Number.isSafeInteger(request.id)) throw new Error('Invalid active read request');
      let reply: ManagedJobActiveReadReply;
      try {
        reply = { kind: 'active_read_result', id: request.id, ok: true, value: await service.activeExecutions() };
      } catch (error) {
        reply = {
          kind: 'active_read_result',
          id: request.id,
          ok: false,
          error: readError(error),
        };
      }
      port.postMessage(reply);
    };
    port.on('message', receive);
  });
}
