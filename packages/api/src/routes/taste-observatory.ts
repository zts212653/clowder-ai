import type Database from 'better-sqlite3';
import type { FastifyPluginAsync } from 'fastify';
import type { IInvocationRecordStore } from '../domains/cats/services/stores/ports/InvocationRecordStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { ITurnExecutionStore } from '../domains/cats/services/stores/ports/TurnExecutionStore.js';
import { TasteObservatoryReader } from '../domains/memory/taste/TasteObservatoryReader.js';
import type { TasteRepository } from '../domains/taste/services/TasteRepository.js';
import { resolveDirectLocalAuthorizationUserId } from '../utils/request-identity.js';

export interface TasteObservatoryRouteOptions {
  evidenceDb: Database.Database;
  tasteRepository: TasteRepository;
  privateOwnerUserId: string;
  invocationRecordStore: Pick<IInvocationRecordStore, 'get'>;
  turnExecutionStore: Pick<ITurnExecutionStore, 'get'>;
  threadStore: Pick<IThreadStore, 'get'>;
}

export const tasteObservatoryRoutes: FastifyPluginAsync<TasteObservatoryRouteOptions> = async (app, opts) => {
  const reader = new TasteObservatoryReader(
    opts.evidenceDb,
    opts.tasteRepository,
    opts.privateOwnerUserId,
    opts.invocationRecordStore,
    opts.turnExecutionStore,
    opts.threadStore,
  );
  app.get('/api/memory/taste/observatory', async (request, reply) => {
    const ownerUserId = resolveDirectLocalAuthorizationUserId(request);
    if (!ownerUserId) return reply.status(401).send({ error: 'Owner authentication required' });
    try {
      return await reader.read(ownerUserId);
    } catch {
      return reply.status(503).send({ error: 'Taste observatory source unavailable' });
    }
  });
};
