import type { ChildProcess } from 'node:child_process';
import type { IEmbeddingService } from './interfaces.js';
import { type ChildMessage, encodeProcessError, type ParentMessage } from './memory-process-protocol.js';
import type { MemoryReadExecution } from './memory-read-execution.js';

/** Existing parent RPC bridge. Timing ends after handling/queuing the reply, not sidecar-only compute. */
export async function handleMemoryEmbeddingRequest(
  child: ChildProcess,
  message: Extract<ChildMessage, { type: 'embedding' }>,
  embedding: IEmbeddingService | undefined,
  signal: AbortSignal,
  execution?: MemoryReadExecution,
): Promise<void> {
  let outcome: 'fulfilled' | 'rejected' = 'rejected';
  try {
    if (!embedding) throw new Error('Embedding service unavailable');
    const value =
      message.method === 'embed'
        ? await embedding.embed(message.texts ?? [], signal)
        : await embedding[message.method](signal);
    if (child.connected)
      child.send(
        {
          type: 'embedding-result',
          id: message.id,
          value,
          ready: embedding.isReady(),
          model: embedding.getModelInfo(),
        } satisfies ParentMessage,
        () => {},
      );
    outcome = 'fulfilled';
  } catch (error) {
    if (child.connected)
      child.send(
        {
          type: 'embedding-result',
          id: message.id,
          ready: false,
          error: encodeProcessError(error),
        } satisfies ParentMessage,
        () => {},
      );
  } finally {
    execution?.embeddingFinished(message.id, outcome);
  }
}
