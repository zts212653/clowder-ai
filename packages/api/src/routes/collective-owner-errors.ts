import type { FastifyReply } from 'fastify';
import { z } from 'zod';

export function sendCollectiveOwnerError(
  reply: FastifyReply,
  error: unknown,
  invalidCode: string,
  unavailableCode: string,
) {
  if (error instanceof z.ZodError) return reply.code(400).send({ code: invalidCode });
  const code =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : unavailableCode;
  return reply
    .code(409)
    .send({ code, error: error instanceof Error ? error.message : 'Collective action is unavailable' });
}
