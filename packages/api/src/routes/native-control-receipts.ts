import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type {
  NativeControlCommand,
  NativeControlReceiptPort,
} from '../domains/cats/services/agents/invocation/NativeControlReceipt.js';
import { resolveDirectLocalAuthorizationUserId } from '../utils/request-identity.js';

export function nativeQueueControlCommand(request: FastifyRequest): NativeControlCommand | undefined {
  const params = z.object({ threadId: z.string(), entryId: z.string() }).safeParse(request.params);
  const query = z
    .object({ expectedSourceMessageId: z.string().optional(), expectedTargetCatId: z.string().optional() })
    .safeParse(request.query);
  if (!params.success || !query.success) return;
  return {
    kind: 'queue',
    ...params.data,
    ...(query.data.expectedSourceMessageId !== undefined ? { messageId: query.data.expectedSourceMessageId } : {}),
    ...(query.data.expectedTargetCatId !== undefined ? { catId: query.data.expectedTargetCatId } : {}),
  };
}
export function nativeLiveControlCommand(request: FastifyRequest): NativeControlCommand | undefined {
  const params = z.object({ threadId: z.string(), executionId: z.string() }).safeParse(request.params);
  const body = z.object({ catId: z.string(), expectedInvocationId: z.string() }).safeParse(request.body);
  if (!params.success || !body.success) return;
  return { kind: 'live', ...params.data, catId: body.data.catId, invocationId: body.data.expectedInvocationId };
}

/** Optional receipt bridge. Existing native owner authorization and mutation remain in their own routes. */
export function nativeControlReceiptHooks(
  port: (() => NativeControlReceiptPort | undefined) | undefined,
  command: (request: FastifyRequest) => NativeControlCommand | undefined,
) {
  const admitted = new WeakMap<FastifyRequest, { receiptRef: string; userId: string; kind: 'queue' | 'live' }>();
  return {
    async preHandler(request: FastifyRequest, reply: FastifyReply) {
      const ref = (request.query as { controlReceiptRef?: unknown } | undefined)?.controlReceiptRef;
      if (ref === undefined) return;
      const userId = resolveDirectLocalAuthorizationUserId(request);
      if (
        !userId ||
        request.headers['x-invocation-id'] ||
        request.headers['x-callback-token'] ||
        request.headers['x-agent-key-secret']
      )
        return reply.code(401).send({ code: 'AUTH_REQUIRED' });
      const target = command(request);
      const owner = port?.();
      if (!owner) return reply.code(503).send({ code: 'CONTROL_RECEIPT_UNAVAILABLE' });
      if (typeof ref !== 'string' || !target || !owner.authorize(ref, userId, target))
        return reply.code(409).send({ code: 'CONTROL_TARGET_MISMATCH' });
      admitted.set(request, { receiptRef: ref, userId, kind: target.kind });
    },
    async onSend(request: FastifyRequest, reply: FastifyReply, payload: unknown) {
      const intent = admitted.get(request);
      if (!intent) return payload;
      admitted.delete(request);
      const body: unknown = typeof payload === 'string' ? JSON.parse(payload) : undefined;
      const result = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
      const acknowledged =
        reply.statusCode === 200 && (intent.kind === 'live' ? result.cancelled === true : Boolean(result.removed));
      const owner = port?.();
      if (!owner) throw new Error('Native control receipt owner unavailable after operation');
      owner.observe(
        intent.receiptRef,
        intent.userId,
        reply.statusCode,
        acknowledged,
        typeof result.code === 'string' ? result.code : undefined,
      );
      return payload;
    },
  };
}
