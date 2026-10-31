import type { FastifyReply } from 'fastify';
import { findMonorepoRoot } from '../utils/monorepo-root.js';
import { resolvePersistentProjectPathDetailed } from '../utils/persistent-project-path.js';

/** Resolve UI defaults from workspace truth, never from the disposable API runtime projection. */
export async function resolveRecommendedProjectPath(reply: FastifyReply): Promise<string | null> {
  const configuredWorkspace = process.env.CAT_CAFE_WORKSPACE_ROOT?.trim();
  const result = await resolvePersistentProjectPathDetailed(configuredWorkspace || findMonorepoRoot(process.cwd()));
  if (result.ok) return result.path;
  reply.status(503);
  void reply.send({ error: 'Canonical workspace is unavailable', reason: result.reason });
  return null;
}
