import { isAbsolute, resolve } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  connectWorkspaceRoot,
  readRootConnection,
  WorkspaceRootConnectionConflict,
} from '../domains/workspace/roots/workspace-root-connection.js';
import {
  issueRootConnectionProof,
  verifyRootConnectionProof,
} from '../domains/workspace/roots/workspace-root-proof.js';
import { workspaceDirectHuman } from './workspace-direct-human.js';

const operationId = z.string().min(1).max(256);
export function issueReconnectionProofForChangedConnection(
  verified: ReturnType<typeof verifyRootConnectionProof>,
  currentEpoch: number,
) {
  return verified?.source.kind === 'directory-selection'
    ? issueRootConnectionProof({ ...verified, expectedEpoch: currentEpoch })
    : undefined;
}
function withReconnectionProof(receipt: Awaited<ReturnType<typeof connectWorkspaceRoot>>) {
  return !receipt.connected && receipt.source?.kind === 'directory-selection'
    ? {
        ...receipt,
        connectionProof: issueRootConnectionProof({
          userId: receipt.ownerUserId,
          root: receipt.root,
          expectedEpoch: receipt.currentEpoch,
          source: receipt.source,
        }),
      }
    : receipt;
}
export function registerWorkspaceRootConnectionRoutes(
  app: FastifyInstance,
  resolveUserId: (request: FastifyRequest) => string | null,
): void {
  app.get('/api/workspace/root-connections', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const userId = workspaceDirectHuman(request, resolveUserId);
    if (!userId) return reply.code(401).send({ error: { code: 'identity_required' } });
    const query = z.object({ operationId }).strict().safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: { code: 'invalid_operation' } });
    try {
      const receipt = await readRootConnection(userId, query.data.operationId);
      return receipt
        ? withReconnectionProof(receipt)
        : reply.code(404).send({ error: { code: 'operation_not_found' } });
    } catch {
      return reply.code(503).send({ error: { code: 'connection_state_unavailable' } });
    }
  });
  app.post('/api/workspace/root-connections', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const userId = workspaceDirectHuman(request, resolveUserId);
    if (!userId) return reply.code(401).send({ error: { code: 'identity_required' } });
    const input = z
      .object({
        root: z
          .string()
          .min(1)
          .max(4096)
          .refine((path) => isAbsolute(path) && !path.includes('\0')),
        operationId,
        expectedEpoch: z.number().int().nonnegative(),
        expectedUserId: z.string().min(1).max(256),
        admission: z.literal('absolute-file-directory').optional(),
        connectionProof: z.string().min(1).max(20000),
      })
      .strict()
      .safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: { code: 'invalid_connection' } });
    if (input.data.expectedUserId !== userId) return reply.code(409).send({ error: { code: 'identity_changed' } });
    if (resolve(input.data.root) !== input.data.root)
      return reply.code(409).send({ error: { code: 'root_not_canonical' } });
    let verified: ReturnType<typeof verifyRootConnectionProof> = null;
    try {
      verified = verifyRootConnectionProof(input.data.connectionProof);
      if (
        !verified ||
        verified.userId !== userId ||
        verified.root !== input.data.root ||
        verified.expectedEpoch !== input.data.expectedEpoch
      )
        return reply.code(409).send({ error: { code: 'invalid_connection_proof' } });
      const admission = verified.source.kind === 'absolute-file' ? 'absolute-file-directory' : undefined;
      if (input.data.admission !== undefined && input.data.admission !== admission)
        return reply.code(409).send({ error: { code: 'invalid_connection_proof' } });
      return withReconnectionProof(
        await connectWorkspaceRoot(
          userId,
          input.data.operationId,
          input.data.root,
          input.data.expectedEpoch,
          verified.source,
        ),
      );
    } catch (error) {
      if (error instanceof WorkspaceRootConnectionConflict) {
        const connectionProof =
          error.code === 'connection_changed' && verified && error.currentEpoch !== undefined
            ? issueReconnectionProofForChangedConnection(verified, error.currentEpoch)
            : undefined;
        return reply.code(409).send({
          error: {
            code: error.code,
            message: error.message,
            ...(error.currentEpoch === undefined ? {} : { currentEpoch: error.currentEpoch }),
            ...(connectionProof ? { connectionProof } : {}),
          },
        });
      }
      return reply.code(503).send({ error: { code: 'connection_state_unavailable' } });
    }
  });
}
