import {
  CLI_EFFORT_VALUES,
  type CliEffortPreset,
  catIdSchema,
  catRegistry,
  createCatId,
  getCliEffortOptionsForProvider,
  resolveCliEffortOverride,
  type ThreadMemberEffortRow,
} from '@cat-cafe/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getCatEffort, isCatAvailable } from '../config/cat-config-loader.js';
import { getCatModel } from '../config/cat-models.js';
import type { IThreadStore, Thread } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { canAccessThread, isSharedDefaultThread } from '../domains/guides/guide-state-access.js';
import { resolveHeaderUserId } from '../utils/request-identity.js';

const effortPatchSchema = z.object({
  effort: z.enum(CLI_EFFORT_VALUES).nullable(),
});

type EffortThreadStore = Pick<IThreadStore, 'get' | 'getMemberEffort' | 'getMemberEfforts' | 'updateMemberEffort'>;

export interface ThreadMemberEffortRouteOptions {
  threadStore: EffortThreadStore;
}

function getParticipantIds(thread: Pick<Thread, 'participants'>): Set<string> {
  return new Set(thread.participants.map(String));
}

function buildEffortRow(
  catId: string,
  rawOverride: CliEffortPreset | null | undefined,
  participants: ReadonlySet<string>,
): ThreadMemberEffortRow | null {
  const config = catRegistry.tryGet(catId)?.config;
  if (!config || !isCatAvailable(catId)) return null;

  const effectiveModel = getCatModel(catId);
  const options = getCliEffortOptionsForProvider(config.clientId, effectiveModel);
  if (!options) return null;

  const inherited = getCatEffort(catId, undefined, config.clientId, effectiveModel);
  const resolution = resolveCliEffortOverride(config.clientId, effectiveModel, inherited, rawOverride);
  return {
    catId: createCatId(catId),
    displayName: config.displayName,
    options,
    override: rawOverride ?? null,
    inherited,
    ...resolution,
    isParticipant: participants.has(catId),
  };
}

function sortRows(rows: ThreadMemberEffortRow[]): ThreadMemberEffortRow[] {
  return rows.sort((left, right) => {
    if (left.isParticipant !== right.isParticipant) return left.isParticipant ? -1 : 1;
    return left.displayName.localeCompare(right.displayName) || String(left.catId).localeCompare(String(right.catId));
  });
}

export const threadMemberEffortRoutes: FastifyPluginAsync<ThreadMemberEffortRouteOptions> = async (app, opts) => {
  const { threadStore } = opts;

  async function requireThread(request: FastifyRequest, id: string, reply: FastifyReply) {
    const userId = resolveHeaderUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' } as const;
    }
    const thread = await threadStore.get(id);
    if (!thread) {
      reply.status(404);
      return { error: 'Thread not found' } as const;
    }
    if (!canAccessThread(thread, userId)) {
      reply.status(403);
      return { error: 'Access denied' } as const;
    }
    if (isSharedDefaultThread(thread)) {
      reply.status(400);
      return { error: 'Effort overrides are not available on the shared default thread' } as const;
    }
    return { thread, userId } as const;
  }

  app.get<{ Params: { id: string } }>('/api/threads/:id/members/effort', async (request, reply) => {
    const access = await requireThread(request, request.params.id, reply);
    if ('error' in access) return access;

    const overrides = await threadStore.getMemberEfforts(request.params.id, access.userId);
    const participants = getParticipantIds(access.thread);
    const members = sortRows(
      catRegistry
        .getAllIds()
        .map((catId) => buildEffortRow(String(catId), overrides[catId], participants))
        .filter((row): row is ThreadMemberEffortRow => row !== null),
    );
    return { threadId: request.params.id, members };
  });

  app.patch<{ Params: { id: string; catId: string } }>(
    '/api/threads/:id/members/:catId/effort',
    async (request, reply) => {
      const access = await requireThread(request, request.params.id, reply);
      if ('error' in access) return access;

      const catResult = catIdSchema().safeParse(request.params.catId);
      const parsed = effortPatchSchema.safeParse(request.body);
      if (!catResult.success || !parsed.success) {
        reply.status(400);
        return { error: 'effort must be a supported effort value or null' };
      }

      const catId = createCatId(String(catResult.data));
      const config = catRegistry.tryGet(catId)?.config;
      const effectiveModel = config ? getCatModel(catId) : null;
      const options = config ? getCliEffortOptionsForProvider(config.clientId, effectiveModel) : null;
      if (!config || !isCatAvailable(catId) || !options) {
        reply.status(400);
        return { error: 'Cat does not support effort overrides' };
      }
      if (parsed.data.effort !== null && !options.includes(parsed.data.effort)) {
        reply.status(400);
        return { error: 'Effort is not supported by this cat model' };
      }

      await threadStore.updateMemberEffort(request.params.id, catId, parsed.data.effort);
      const row = buildEffortRow(catId, parsed.data.effort, getParticipantIds(access.thread));
      if (!row) {
        reply.status(400);
        return { error: 'Cat does not support effort overrides' };
      }
      return row;
    },
  );
};
