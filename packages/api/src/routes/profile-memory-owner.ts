import {
  type ProfileMemoryOwnerAction,
  type ProfileMemoryOwnerEntry,
  profileMemoryOwnerActionSchema,
} from '@cat-cafe/shared';
import {
  PROFILE_CAPSULE_RELATIVE_PATH,
  PROFILE_CORPUS_RELATIVE_PATH,
  relationshipPrimerRelativePath,
} from '@cat-cafe/shared/profile-contract';
import { profileRevisionOf } from '@cat-cafe/shared/profile-revision';
import type { ProfileMemoryEntry } from '@clowder-ai/plugin-memory-contract/profile';
import type { FastifyPluginAsync } from 'fastify';
import type { IProfileUpdateProposalStore } from '../domains/cats/services/stores/ports/ProfileUpdateProposalStore.js';
import { canAccessThread } from '../domains/guides/guide-state-access.js';
import type { ProfileMemoryLifecycleService } from '../domains/memory/profile/ProfileMemoryLifecycleService.js';
import { MemoryProviderCallError } from '../domains/plugin/host-surface/memory/memory-plugin-host.js';
import type { createProfileMemoryProvider } from '../domains/plugin/host-surface/memory/profile-memory-provider.js';
import { resolveSessionUserId } from '../utils/request-identity.js';
import { authorizeOwnerBrowserAction, ownerMemoryActionHttpStatus } from './owner-memory-browser-auth.js';
import { readProfileMemoryProposals } from './profile-memory-proposals.js';
import { type ProfileMemorySourceReaders, projectProfileMemorySource } from './profile-memory-source.js';

export interface ProfileMemoryOwnerRoutesOptions {
  ownerUserId: string;
  store: Pick<ReturnType<typeof createProfileMemoryProvider>, 'list' | 'get' | 'provenance' | 'usage'>;
  lifecycle?: Pick<ProfileMemoryLifecycleService, 'executeOwnerAction'>;
  proposalStore: Pick<IProfileUpdateProposalStore, 'listByTarget'>;
  sourceReaders: ProfileMemorySourceReaders;
}

export const profileMemoryOwnerRoutes: FastifyPluginAsync<ProfileMemoryOwnerRoutesOptions> = async (app, opts) => {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof MemoryProviderCallError) return reply.status(503).send({ error: 'memory_unavailable' });
    return reply.send(error);
  });

  app.get('/api/memory/profile', async (request, reply) => {
    const owner = authorizeRead(request, reply, opts.ownerUserId);
    if (!owner) return;
    const entries = await Promise.all(
      (await opts.store.list(owner)).map(async (entry) =>
        projectEntry(entry, await readProfileMemoryProposals(owner, proposalTarget(entry), opts.proposalStore)),
      ),
    );
    const capsuleSetup = entries.some((entry) => entry.id === 'capsule')
      ? undefined
      : {
          revision: profileRevisionOf(''),
          proposals: await readProfileMemoryProposals(owner, PROFILE_CAPSULE_RELATIVE_PATH, opts.proposalStore),
        };
    return { readStatus: 'ready', entries, ...(capsuleSetup ? { capsuleSetup } : {}) };
  });

  app.get<{ Params: { memoryId: string }; Querystring: { revision?: string } }>(
    '/api/memory/profile/:memoryId',
    async (request, reply) => {
      const owner = authorizeRead(request, reply, opts.ownerUserId);
      if (!owner) return;
      if (!request.query.revision) return reply.status(400).send({ error: 'Revision required' });
      const entry = await opts.store.get(owner, request.params.memoryId);
      if (!entry) return reply.status(404).send({ error: 'Profile memory not found' });
      if (entry.revision !== request.query.revision) return reply.status(409).send({ error: 'Revision changed' });
      return projectEntry(entry, await readProfileMemoryProposals(owner, proposalTarget(entry), opts.proposalStore));
    },
  );

  app.get<{ Params: { memoryId: string }; Querystring: { revision?: string } }>(
    '/api/memory/profile/:memoryId/source',
    async (request, reply) => {
      const owner = authorizeRead(request, reply, opts.ownerUserId);
      if (!owner) return;
      if (!request.query.revision) return reply.status(400).send({ error: 'Revision required' });
      const entry = await opts.store.get(owner, request.params.memoryId);
      if (!entry) return reply.status(404).send({ error: 'Profile memory not found' });
      if (entry.revision !== request.query.revision) return reply.status(409).send({ error: 'Revision changed' });
      const source = await opts.store.provenance(owner, entry.id, entry.revision);
      if (source.outcome === 'not_available') return reply.status(404).send({ error: 'Profile memory not found' });
      if (source.outcome !== 'found') return reply.status(409).send({ error: 'Revision changed' });
      return projectProfileMemorySource(source.coordinates, owner, opts.sourceReaders);
    },
  );

  app.get<{ Params: { memoryId: string }; Querystring: { revision?: string } }>(
    '/api/memory/profile/:memoryId/usage',
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      const owner = authorizeRead(request, reply, opts.ownerUserId);
      if (!owner) return;
      if (!request.query.revision) return reply.status(400).send({ error: 'Revision required' });
      const entry = await opts.store.get(owner, request.params.memoryId);
      if (!entry) return reply.status(404).send({ error: 'Profile memory not found' });
      if (entry.revision !== request.query.revision) return reply.status(409).send({ error: 'Revision changed' });
      try {
        const result = await opts.store.usage(owner, entry.id, entry.revision);
        if (result.outcome === 'not_available') return reply.status(404).send({ error: 'Profile memory not found' });
        if (result.outcome !== 'found') return reply.status(409).send({ error: 'Revision changed' });
        const { usage } = result;
        usage.recent = await Promise.all(
          usage.recent.map(async (item) => {
            if (!item.threadId) return item;
            const thread = await opts.sourceReaders.threadStore.get(item.threadId);
            const visible =
              thread &&
              !thread.deletedAt &&
              (canAccessThread(thread, owner) ||
                (thread.createdBy === 'system' &&
                  (await opts.sourceReaders.threadStore.list(owner)).some((candidate) => candidate.id === thread.id)));
            return { ...item, threadId: visible ? item.threadId : null };
          }),
        );
        return usage;
      } catch (error) {
        request.log.warn({ err: error }, 'Profile usage read unavailable');
        return reply.status(503).send({ error: 'Usage recording unavailable' });
      }
    },
  );

  app.post<{ Params: { memoryId: string }; Body: ProfileMemoryOwnerAction }>(
    '/api/memory/profile/:memoryId/actions',
    async (request, reply) => {
      if (!authorizeOwnerBrowserAction(request)) return reply.status(403).send({ error: 'invalid_action' });
      const owner = resolveSessionUserId(request);
      if (!owner || owner !== opts.ownerUserId) return reply.status(403).send({ error: 'invalid_action' });
      if (!opts.lifecycle) return reply.status(503).send({ error: 'mutation_unavailable' });
      const body = profileMemoryOwnerActionSchema.safeParse(request.body);
      if (!body.success) return reply.status(400).send({ error: 'invalid_request', details: body.error.issues });
      try {
        const result = await opts.lifecycle.executeOwnerAction(owner, request.params.memoryId, body.data);
        if (!('error' in result)) return result;
        return reply.status(ownerMemoryActionHttpStatus(result.error)).send(result);
      } catch (error) {
        request.log.warn({ err: error }, '[F321] Owner Profile mutation unavailable');
        return reply.status(503).send({ error: 'mutation_unavailable' });
      }
    },
  );
};

function authorizeRead(
  request: Parameters<typeof resolveSessionUserId>[0],
  reply: { status(code: number): { send(payload: unknown): unknown } },
  expectedOwner: string,
): string | null {
  const owner = resolveSessionUserId(request);
  if (!owner) {
    reply.status(401).send({ error: 'Session required' });
    return null;
  }
  if (owner !== expectedOwner) {
    reply.status(403).send({ error: 'Owner scope required' });
    return null;
  }
  return owner;
}

function projectEntry(
  entry: ProfileMemoryEntry,
  proposals: ProfileMemoryOwnerEntry['proposals'],
): ProfileMemoryOwnerEntry {
  return {
    id: entry.id,
    type: entry.type,
    layer: entry.layer,
    relationshipKey: entry.relationshipKey,
    uri: entry.uri,
    title: entry.title,
    status: entry.status,
    revision: entry.revision,
    content: entry.content,
    ...(entry.updatedAt !== undefined ? { updatedAt: entry.updatedAt } : {}),
    proposals,
  };
}

function proposalTarget(entry: ProfileMemoryEntry): string {
  if (entry.layer === 'capsule') return PROFILE_CAPSULE_RELATIVE_PATH;
  if (entry.layer === 'corpus') return PROFILE_CORPUS_RELATIVE_PATH;
  if (!entry.relationshipKey) throw new Error('Profile relationship identity unavailable');
  return relationshipPrimerRelativePath(entry.relationshipKey);
}
