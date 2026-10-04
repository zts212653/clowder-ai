import { createHash } from 'node:crypto';
import type { CollectiveConnector } from '@cat-cafe/collective-connector';
import { collectivePairingIntentSchema } from '@cat-cafe/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ParticipationCat } from '../domains/plugin/builtin-runtime/collective-participation-reconciler.js';
import { pluginAccessError, requirePluginOwnerLocalAccess } from './plugin-access-guards.js';

const pairBodySchema = z
  .object({
    serviceUrl: z.string().url(),
    endpointLabel: z.string().trim().min(1).max(160),
    intent: collectivePairingIntentSchema,
    rosterFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    excludedCatIds: z.array(z.string().trim().min(1).max(120)).max(100),
  })
  .strict();

export function entryRoster(cats: readonly ParticipationCat[]) {
  const cards = [...cats]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(({ id, displayName, supported, avatar, roleDescription, defaultModel }) => ({
      id,
      displayName,
      eligible: supported,
      ...(avatar ? { avatar } : {}),
      ...(roleDescription ? { roleDescription } : {}),
      ...(defaultModel ? { defaultModel } : {}),
    }));
  return { cats: cards, fingerprint: createHash('sha256').update(JSON.stringify(cards)).digest('hex') };
}

export function registerCollectiveEntryRoutes(
  app: FastifyInstance,
  options: {
    readonly connector: () => CollectiveConnector | undefined;
    readonly cats: () => readonly ParticipationCat[];
  },
) {
  app.get('/api/plugins/collective-connector/entry-roster', async (request, reply) => {
    const access = requirePluginOwnerLocalAccess(request, 'read');
    if ('error' in access) return pluginAccessError(reply, access);
    return entryRoster(options.cats());
  });

  app.post<{ Body: unknown }>('/api/plugins/collective-connector/pair', async (request, reply) => {
    const access = requirePluginOwnerLocalAccess(request, 'write');
    if ('error' in access) return pluginAccessError(reply, access);
    const parsed = pairBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: 'PAIRING_INVALID', error: 'Invalid pairing request' });
    const { rosterFingerprint, excludedCatIds, ...pair } = parsed.data;
    if (!request.headers.origin || new URL(pair.intent.hostOrigin).origin !== request.headers.origin)
      return reply
        .code(403)
        .send({ code: 'PAIRING_ORIGIN_MISMATCH', error: 'Pairing origin does not match this Host' });
    const roster = entryRoster(options.cats());
    if (
      roster.fingerprint !== rosterFingerprint ||
      excludedCatIds.some((id) => !roster.cats.some((cat) => cat.id === id))
    )
      return reply.code(409).send({ code: 'ENTRY_ROSTER_CHANGED', error: '伙伴名单已更新，请重新确认。' });
    const connector = options.connector();
    if (!connector)
      return reply.code(409).send({ code: 'CONNECTOR_INACTIVE', error: 'Collective Connector is not active' });
    try {
      return await connector.pair({ ...pair, initialExcludedCatIds: excludedCatIds });
    } catch (error) {
      if (error instanceof Error && error.message === 'This Café is already connected to this Collective')
        return reply.code(409).send({ code: 'COLLECTIVE_ALREADY_CONNECTED', error: '这台 Café 已连接此 Collective。' });
      return reply.code(502).send({ code: 'CONNECTOR_OPERATION_FAILED', error: 'Collective pairing failed' });
    }
  });
}
