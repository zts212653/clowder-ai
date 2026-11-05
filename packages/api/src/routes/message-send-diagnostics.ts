import type { ServerResponse } from 'node:http';
import type { FastifyBaseLogger } from 'fastify';

export type MessageSendStage =
  | 'queueAdmission'
  | 'participants'
  | 'projectImport'
  | 'queueUpdate'
  | 'holds'
  | 'receipt'
  | 'draft';

export interface MessageSendTrace {
  measure<T>(stage: MessageSendStage, read: () => T | Promise<T>): Promise<T>;
  committed(messageId: string | undefined): void;
}

/** Wall-time observations only: settlement does not prove the client received HTTP 202. */
export async function observeMessageSend<T>(
  logger: Pick<FastifyBaseLogger, 'info'>,
  response: Pick<ServerResponse, 'once' | 'off' | 'writableFinished'>,
  read: (trace: MessageSendTrace) => Promise<T>,
  startedAt = performance.now(),
): Promise<T> {
  const preQueueMs = performance.now() - startedAt;
  const phases: Partial<Record<MessageSendStage, number>> = {};
  let activePhase: MessageSendStage | undefined;
  let committedSourceMessageId: string | undefined;
  let clientClosed = false;
  let outcome = 'rejected';
  const report = (event: 'client_closed' | 'handler_settled') => {
    try {
      logger.info(
        {
          event,
          handlerElapsedMs: performance.now() - startedAt,
          preQueueMs,
          phases: { ...phases },
          activePhase,
          committedSourceMessageId,
          ...(event === 'handler_settled' ? { outcome } : {}),
        },
        '[Task229] message send diagnostic',
      );
    } catch {
      /* Diagnostics must never replace durable admission results or errors. */
    }
  };
  const onClose = () => {
    if (response.writableFinished) return;
    clientClosed = true;
    report('client_closed');
  };
  response.once('close', onClose);
  try {
    const result = await read({
      measure: async (stage, operation) => {
        const before = performance.now();
        const parent = activePhase;
        activePhase = stage;
        try {
          return await operation();
        } finally {
          phases[stage] = (phases[stage] ?? 0) + performance.now() - before;
          activePhase = parent;
        }
      },
      committed: (messageId) => {
        if (messageId) committedSourceMessageId = messageId;
      },
    });
    outcome = 'resolved';
    return result;
  } finally {
    response.off('close', onClose);
    if (clientClosed || performance.now() - startedAt >= 1000) report('handler_settled');
  }
}
