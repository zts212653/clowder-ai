import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { renewCodexQuotaLogin } from '../config/codex-quota-renewal.js';
import { resolveUserId } from '../utils/request-identity.js';
import { resolveAccountProjectRoot } from './accounts-project-root.js';
import { QuotaCredentialChanged, queryAccountQuota } from './accounts-quota-query.js';

/** Explicit per-account queries; coalesce automatic renewal checks across clients. */
export function registerCodexQuotaRoutes(
  app: FastifyInstance,
  fetcher: typeof fetch = globalThis.fetch,
  renewer: typeof renewCodexQuotaLogin = renewCodexQuotaLogin,
): void {
  const automatic = new Map<string, ReturnType<typeof queryAccountQuota>>();
  app.post('/api/accounts/:profileId/codex/quota', async (request, reply) => {
    if (!resolveUserId(request)) return reply.code(401).send({ error: 'Identity required' });
    const parsed = z
      .object({
        projectPath: z.string().optional(),
        renewExpired: z.boolean().optional(),
        renewedCredentialVersion: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
      })
      .strict()
      .refine((value) => !(value.renewExpired && value.renewedCredentialVersion))
      .safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid query' });
    const root = await resolveAccountProjectRoot(parsed.data.projectPath);
    if (!root) return reply.code(400).send({ error: 'Invalid project path' });
    const { profileId } = request.params as { profileId: string };
    const version = parsed.data.renewedCredentialVersion;
    const key = JSON.stringify([root, profileId, version]);
    try {
      if (!version)
        return await queryAccountQuota(root, profileId, fetcher, undefined, parsed.data.renewExpired, renewer);
      let pending = automatic.get(key);
      if (!pending) {
        pending = queryAccountQuota(root, profileId, fetcher, version);
        automatic.set(key, pending);
      }
      try {
        return await pending;
      } finally {
        if (automatic.get(key) === pending) automatic.delete(key);
      }
    } catch (error) {
      if (error instanceof QuotaCredentialChanged)
        return reply.code(409).send({ error: '账号登录已变化，请刷新账号列表后重新查询' });
      return reply
        .code(error instanceof Error && error.message === 'Codex account not found' ? 404 : 409)
        .send({ error: '无法读取账号，请核对账号配置' });
    }
  });
}
