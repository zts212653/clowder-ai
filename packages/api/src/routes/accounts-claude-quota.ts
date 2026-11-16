import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveByAccountRef } from '../config/account-resolver.js';
import { sampleClaudeQuota } from '../config/claude-quota-sampler.js';
import { readClaudeQuota, recordClaudeQuota } from '../config/claude-quota-store.js';
import { claudeExecutionAccountSnapshot } from '../config/claude-token-account.js';
import { resolveUserId } from '../utils/request-identity.js';
import { resolveAccountProjectRoot } from './accounts-project-root.js';

const querySchema = z.object({ projectPath: z.string().optional() }).strict();

/** Explicit sampling uses only the official CLI's inference response; never the OAuth usage API. */
export async function queryClaudeAccountQuota(root: string, ref: string, sample = sampleClaudeQuota) {
  const profile = resolveByAccountRef(root, ref);
  if (!profile || profile.client !== 'anthropic' || profile.authType !== 'oauth' || profile.baseUrl)
    throw new Error('claude_quota_account_required');
  const account = claudeExecutionAccountSnapshot(profile);
  if (!account.credentialVersion) throw new Error('claude_quota_owner_unknown');
  for (const requestedModel of ['haiku', 'fable'] as const) {
    const { model, windows } = await sample(profile, requestedModel);
    for (const reading of windows) {
      if (!recordClaudeQuota({ root, account, model, windows: reading, observedAt: Date.now() }))
        throw new Error('claude_quota_credential_changed');
    }
  }
  const quota = readClaudeQuota(root, ref, account.credentialVersion);
  return { accountRef: ref, claudeQuota: quota ? { samples: quota.samples } : undefined };
}

export function registerClaudeQuotaRoutes(app: FastifyInstance, sample = sampleClaudeQuota): void {
  const pending = new Map<string, ReturnType<typeof queryClaudeAccountQuota>>();
  app.post('/api/accounts/:profileId/claude/quota', async (request, reply) => {
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
        query = queryClaudeAccountQuota(root, profileId, sample);
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
        .code(code === 'claude_quota_credential_changed' ? 409 : 503)
        .send({ error: code.startsWith('claude_quota_') ? code : 'claude_quota_reading_unavailable' });
    }
  });
}
