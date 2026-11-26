import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveKimiQuotaExecutionOwner } from '../config/kimi-quota-identity.js';
import { readKimiQuota, recordKimiQuota } from '../config/kimi-quota-store.js';
import { resolveUserId } from '../utils/request-identity.js';
import { resolveAccountProjectRoot } from './accounts-project-root.js';
import { type CodexUsageItem, probeKimiQuotaViaCli } from './quota.js';

const querySchema = z.object({ projectPath: z.string().optional() }).strict();

export type KimiAccountQuotaSampler = (
  launchEnv: Readonly<Record<string, string>>,
) => Promise<{ observedAt: number; items: CodexUsageItem[] }>;

const defaultKimiAccountQuotaSampler: KimiAccountQuotaSampler = async (launchEnv) => {
  let observedAt = Date.now();
  const items = await probeKimiQuotaViaCli(launchEnv as NodeJS.ProcessEnv, {
    isolatedEnv: true,
    onObservedAt: (sampledAtMs) => {
      observedAt = sampledAtMs;
    },
  });
  return { observedAt, items };
};

export async function queryKimiAccountQuota(
  root: string,
  ref: string,
  sample: KimiAccountQuotaSampler = defaultKimiAccountQuotaSampler,
) {
  const owner = resolveKimiQuotaExecutionOwner(root, ref);
  if (!owner) throw new Error('kimi_quota_account_required');
  if (!owner.snapshot.credentialVersion) throw new Error('kimi_quota_owner_unknown');
  const { observedAt, items } = await sample(owner.launchEnv);
  if (!items.length) throw new Error('kimi_quota_reading_unavailable');
  if (!recordKimiQuota({ root, account: owner.snapshot, items, observedAt })) {
    throw new Error('kimi_quota_credential_changed');
  }
  const kimiQuota = readKimiQuota(root, ref, owner.snapshot.credentialVersion);
  return { accountRef: ref, ...(kimiQuota ? { kimiQuota } : {}) };
}

export function registerKimiQuotaRoutes(
  app: FastifyInstance,
  sample: KimiAccountQuotaSampler = defaultKimiAccountQuotaSampler,
): void {
  const pending = new Map<string, ReturnType<typeof queryKimiAccountQuota>>();
  app.post('/api/accounts/:profileId/kimi/quota', async (request, reply) => {
    if (!resolveUserId(request)) return reply.code(401).send({ error: 'Identity required' });
    const parsed = querySchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid query' });
    const root = await resolveAccountProjectRoot(parsed.data.projectPath);
    if (!root) return reply.code(400).send({ error: 'Invalid project path' });
    const { profileId } = request.params as { profileId: string };
    const key = JSON.stringify([root, profileId]);
    try {
      let query = pending.get(key);
      if (!query) {
        query = queryKimiAccountQuota(root, profileId, sample);
        pending.set(key, query);
      }
      try {
        return await query;
      } finally {
        if (pending.get(key) === query) pending.delete(key);
      }
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      return reply
        .code(code === 'kimi_quota_credential_changed' ? 409 : 503)
        .send({ error: code.startsWith('kimi_quota_') ? code : 'kimi_quota_reading_unavailable' });
    }
  });
}
