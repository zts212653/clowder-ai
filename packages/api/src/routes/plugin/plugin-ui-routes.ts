import type { FastifyPluginAsync } from 'fastify';
import type { DeclaredPluginUi } from '../../domains/plugin/declared/declared-plugin-ui.js';
import {
  listPluginConversations,
  type PluginConversationDependencies,
} from '../../domains/plugin/declared/plugin-conversations.js';
import { pluginAccessError, requirePluginOwnerLocalAccess } from '../plugin-access-guards.js';

/** Discovery only. HTML and business requests use the declared plugin HTTP dispatcher. */
export const pluginUiRoutes: FastifyPluginAsync<{
  ui: DeclaredPluginUi;
  conversations?: PluginConversationDependencies;
}> = async (app, { ui, conversations }) => {
  app.get('/api/plugin-ui', async (request, reply) => {
    const access = requirePluginOwnerLocalAccess(request, 'read');
    if ('error' in access) return pluginAccessError(reply, access);
    return { entries: ui.list() };
  });
  app.get('/api/plugin-conversations', async (request, reply) => {
    const access = requirePluginOwnerLocalAccess(request, 'read');
    if ('error' in access) return pluginAccessError(reply, access);
    return { entries: conversations ? await listPluginConversations(conversations, access.operator) : [] };
  });
};
