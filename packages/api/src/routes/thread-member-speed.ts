import {
  CODEX_SPEED_VALUES,
  type CodexSpeedValue,
  catIdSchema,
  catRegistry,
  createCatId,
  resolveCodexSpeed,
  type ThreadMemberSpeedRow,
} from '@cat-cafe/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { resolveByAccountRef } from '../config/account-resolver.js';
import { resolveBoundAccountRefForCat } from '../config/cat-account-binding.js';
import { getAcpConfig, isCatAvailable } from '../config/cat-config-loader.js';
import { getCatModel } from '../config/cat-models.js';
import type { IThreadStore, Thread } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { canAccessThread, isSharedDefaultThread } from '../domains/guides/guide-state-access.js';
import { resolveActiveProjectRoot } from '../utils/active-project-root.js';
import { resolveHeaderUserId } from '../utils/request-identity.js';

const speedPatchSchema = z.object({
  speed: z.enum(CODEX_SPEED_VALUES).nullable(),
});

type SpeedThreadStore = Pick<IThreadStore, 'get' | 'getMemberSpeeds' | 'updateMemberSpeed'>;

export interface ThreadMemberSpeedRouteOptions {
  threadStore: SpeedThreadStore;
}

function getParticipantIds(thread: Pick<Thread, 'participants'>): Set<string> {
  return new Set(thread.participants.map(String));
}

function buildSpeedRow(
  catId: string,
  rawOverride: CodexSpeedValue | null | undefined,
  participants: ReadonlySet<string>,
): ThreadMemberSpeedRow | null {
  const config = catRegistry.tryGet(catId)?.config;
  if (!config?.cli || config.clientId !== 'openai' || !isCatAvailable(catId)) return null;

  const projectRoot = resolveActiveProjectRoot();
  if (getAcpConfig(catId, projectRoot)) return null;
  const accountRef = resolveBoundAccountRefForCat(projectRoot, catId, config);
  const account = accountRef ? resolveByAccountRef(projectRoot, accountRef) : null;
  const resolution = resolveCodexSpeed({
    clientId: config.clientId,
    authType: account?.authType,
    model: getCatModel(catId),
    memberDefault: config.cli.serviceTier,
    threadOverride: rawOverride,
  });
  if (!resolution.configurable) return null;

  return {
    catId: createCatId(catId),
    displayName: config.displayName,
    ...resolution,
    isParticipant: participants.has(catId),
  };
}

function sortRows(rows: ThreadMemberSpeedRow[]): ThreadMemberSpeedRow[] {
  return rows.sort((left, right) => {
    if (left.isParticipant !== right.isParticipant) return left.isParticipant ? -1 : 1;
    return left.displayName.localeCompare(right.displayName) || String(left.catId).localeCompare(String(right.catId));
  });
}

export const threadMemberSpeedRoutes: FastifyPluginAsync<ThreadMemberSpeedRouteOptions> = async (app, opts) => {
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
      return { error: 'Speed overrides are not available on the shared default thread' } as const;
    }
    return { thread, userId } as const;
  }

  app.get<{ Params: { id: string } }>('/api/threads/:id/members/speed', async (request, reply) => {
    const access = await requireThread(request, request.params.id, reply);
    if ('error' in access) return access;

    const overrides = await threadStore.getMemberSpeeds(request.params.id, access.userId);
    const participants = getParticipantIds(access.thread);
    const members = sortRows(
      catRegistry
        .getAllIds()
        .map((catId) => buildSpeedRow(String(catId), overrides[catId], participants))
        .filter((row): row is ThreadMemberSpeedRow => row !== null),
    );
    return { threadId: request.params.id, members };
  });

  app.patch<{ Params: { id: string; catId: string } }>(
    '/api/threads/:id/members/:catId/speed',
    async (request, reply) => {
      const access = await requireThread(request, request.params.id, reply);
      if ('error' in access) return access;

      const catResult = catIdSchema().safeParse(request.params.catId);
      const parsed = speedPatchSchema.safeParse(request.body);
      if (!catResult.success || !parsed.success) {
        reply.status(400);
        return { error: 'speed must be standard, fast, or null' };
      }

      const catId = createCatId(String(catResult.data));
      const current = buildSpeedRow(catId, null, getParticipantIds(access.thread));
      if (!current) {
        reply.status(400);
        return { error: 'Cat does not support Codex OAuth speed overrides' };
      }
      if (parsed.data.speed !== null && !current.options.includes(parsed.data.speed)) {
        reply.status(400);
        return { error: 'Speed is not supported by this cat model' };
      }

      await threadStore.updateMemberSpeed(request.params.id, catId, parsed.data.speed);
      const row = buildSpeedRow(catId, parsed.data.speed, getParticipantIds(access.thread));
      if (!row) {
        reply.status(400);
        return { error: 'Cat does not support Codex OAuth speed overrides' };
      }
      return row;
    },
  );
};
