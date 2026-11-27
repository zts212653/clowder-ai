import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveKimiQuotaExecutionOwner } from '../config/kimi-quota-identity.js';
import { readKimiQuota, recordKimiQuota } from '../config/kimi-quota-store.js';
import type { createAgentAdapterAccess } from '../domains/plugin/declared/agent-adapter-access.js';
import { resolveUserId } from '../utils/request-identity.js';
import { resolveAccountProjectRoot } from './accounts-project-root.js';
import { type CodexUsageItem, probeKimiQuotaViaCli } from './quota.js';

const querySchema = z.object({ projectPath: z.string().optional() }).strict();

export type KimiAccountQuotaSampler = (
  launchEnv: Readonly<Record<string, string>>,
) => Promise<{ observedAt: number; items: CodexUsageItem[] }>;

type AccountAdapterQuota = ReturnType<typeof createAgentAdapterAccess>['quota'];
type AccountAdapterRef = Parameters<AccountAdapterQuota>[0];
export interface KimiAccountQuotaDispatch {
  resolveRef(root: string, accountRef: string): AccountAdapterRef | undefined;
  quota: AccountAdapterQuota;
}

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
  adapter?: { ref: AccountAdapterRef; quota: AccountAdapterQuota },
) {
  const owner = resolveKimiQuotaExecutionOwner(root, ref);
  if (!owner) throw new Error('kimi_quota_account_required');
  const { credentialVersion, accountRevision } = owner.snapshot;
  if (!credentialVersion) throw new Error('kimi_quota_owner_unknown');
  const result = adapter
    ? await adapter.quota(adapter.ref, {
        account: { projectRoot: root, accountRef: ref, accountRevision, credentialVersion },
      })
    : undefined;
  const { observedAt, items } = result
    ? {
        observedAt: result.observation.observedAt,
        items: result.observation.windows.map((window) => ({
          label: window.label,
          poolId: window.id,
          percentKind: 'used' as const,
          usedPercent: window.used * 100,
          ...(window.resetsAt ? { resetsAt: window.resetsAt } : {}),
        })),
      }
    : await sample(owner.launchEnv);
  if (!items.length) throw new Error('kimi_quota_reading_unavailable');
  if (!recordKimiQuota({ root, account: owner.snapshot, items, observedAt })) {
    throw new Error('kimi_quota_credential_changed');
  }
  const kimiQuota = readKimiQuota(root, ref, credentialVersion);
  return {
    accountRef: ref,
    ...(kimiQuota ? { kimiQuota } : {}),
    ...(result ? { adapterOrigin: result.binding } : {}),
  };
}

export function registerKimiQuotaRoutes(
  app: FastifyInstance,
  sample: KimiAccountQuotaSampler = defaultKimiAccountQuotaSampler,
  dispatch?: KimiAccountQuotaDispatch,
): void {
  const pending = new Map<string, ReturnType<typeof queryKimiAccountQuota>>();
  app.post('/api/accounts/:profileId/kimi/quota', async (request, reply) => {
    if (!resolveUserId(request)) return reply.code(401).send({ error: 'Identity required' });
    const parsed = querySchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid query' });
    const root = await resolveAccountProjectRoot(parsed.data.projectPath);
    if (!root) return reply.code(400).send({ error: 'Invalid project path' });
    const { profileId } = request.params as { profileId: string };
    const ref = dispatch?.resolveRef(root, profileId);
    const key = JSON.stringify([root, profileId, ref]);
    try {
      let query = pending.get(key);
      if (!query) {
        query = queryKimiAccountQuota(
          root,
          profileId,
          sample,
          dispatch && ref ? { ref, quota: dispatch.quota } : undefined,
        );
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
