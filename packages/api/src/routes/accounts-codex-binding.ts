import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { toAllCatConfigs } from '../config/cat-config-loader.js';
import { reconcileCatRegistry } from '../config/cat-registry-reconciliation.js';
import { planClaudeAccountBinding } from '../config/claude-account-binding.js';
import { planCodexAccountBinding } from '../config/codex-account-binding.js';
import { configEventBus, createChangeSetId } from '../config/config-event-bus.js';
import { readLocalAccountSelection } from '../config/local-account-selection.js';
import {
  bindRuntimeClaudeAccounts,
  bindRuntimeCodexAccounts,
  readRuntimeAccountMembers,
} from '../config/runtime-cat-catalog.js';
import { resolveActiveProjectRoot } from '../utils/active-project-root.js';
import { resolveUserId } from '../utils/request-identity.js';
import { resolveAccountProjectRoot } from './accounts-project-root.js';

const schema = z
  .object({
    projectPath: z.string().optional(),
    catId: z.string().min(1).optional(),
    scope: z.enum(['cat', 'family', 'local']),
    includeOverrides: z.boolean().optional(),
    previewToken: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
export function registerCodexBindingRoutes(app: FastifyInstance): void {
  for (const tool of ['codex', 'claude'] as const) {
    const client = tool === 'codex' ? 'openai' : 'anthropic';
    app.get(`/api/accounts/${tool}/members`, async (request, reply) => {
      if (!resolveUserId(request)) return reply.code(401).send({ error: 'Identity required' });
      const query = z.object({ projectPath: z.string().optional() }).safeParse(request.query);
      if (!query.success) return reply.code(400).send({ error: 'Invalid query' });
      const root = await resolveAccountProjectRoot(query.data.projectPath);
      if (!root) return reply.code(400).send({ error: 'Invalid project path' });
      const selection = readLocalAccountSelection(readRuntimeAccountMembers(resolveActiveProjectRoot()), client);
      return {
        members: selection.members,
        selection,
      };
    });
    for (const action of ['preview', 'commit'] as const) {
      app.post(`/api/accounts/:profileId/${tool}/binding/${action}`, async (request, reply) => {
        if (!resolveUserId(request)) return reply.code(401).send({ error: 'Identity required' });
        const parsed = schema.safeParse(request.body);
        if (!parsed.success) return reply.code(400).send({ error: 'Invalid binding request' });
        const root = await resolveAccountProjectRoot(parsed.data.projectPath);
        if (!root) return reply.code(400).send({ error: 'Invalid project path' });
        const { profileId } = request.params as { profileId: string };
        const selection = {
          accountRef: profileId,
          catId: parsed.data.catId,
          scope: parsed.data.scope,
          includeOverrides: parsed.data.includeOverrides,
        };
        try {
          // Account persistence follows the workspace; member mutations follow /api/cats.
          const memberRoot = resolveActiveProjectRoot();
          const catalog = readRuntimeAccountMembers(memberRoot);
          const preview =
            tool === 'codex'
              ? planCodexAccountBinding(root, catalog, selection)
              : planClaudeAccountBinding(root, catalog, selection);
          if (action === 'commit') {
            if (!parsed.data.previewToken) return reply.code(400).send({ error: 'Binding preview required' });
            const bind = tool === 'codex' ? bindRuntimeCodexAccounts : bindRuntimeClaudeAccounts;
            bind(memberRoot, selection, parsed.data.previewToken, root);
            reconcileCatRegistry(memberRoot, new Set(Object.keys(toAllCatConfigs(catalog))));
            await configEventBus.emitChangeAsync({
              source: 'cat-config',
              scope: 'file',
              changedKeys: preview.targets.map((target) => target.catId),
              changeSetId: createChangeSetId(),
              timestamp: Date.now(),
            });
          }
          return {
            ...preview,
            ...(action === 'commit'
              ? {
                  selection: readLocalAccountSelection(readRuntimeAccountMembers(memberRoot), client),
                }
              : {}),
          };
        } catch (error) {
          return reply.code(409).send({ error: error instanceof Error ? error.message : 'Binding unavailable' });
        }
      });
    }
  }
}
