import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { resolveUserId } from '../utils/request-identity.js';

export type StorageMode = 'redis' | 'memory';

export interface SystemStatusRoutesOptions {
  storageMode: StorageMode;
}

export interface SystemStatusResponse {
  storageMode: StorageMode;
  storage: {
    mode: StorageMode;
    persistent: boolean;
    warning: string | null;
  };
}

export function buildSystemStatus(storageMode: StorageMode): SystemStatusResponse {
  const persistent = storageMode === 'redis';
  return {
    storageMode,
    storage: {
      mode: storageMode,
      persistent,
      warning: persistent ? null : 'Memory mode: data will be lost on restart.',
    },
  };
}

function requireIdentity(request: FastifyRequest, reply: FastifyReply): boolean {
  const userId = resolveUserId(request);
  if (!userId) {
    reply.status(401);
    return false;
  }
  return true;
}

export async function systemStatusRoutes(app: FastifyInstance, opts: SystemStatusRoutesOptions): Promise<void> {
  app.get('/api/system/status', async (request, reply) => {
    if (!requireIdentity(request, reply)) return { error: 'Identity required' };
    return buildSystemStatus(opts.storageMode);
  });
}
