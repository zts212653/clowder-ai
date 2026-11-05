import { createRequire } from 'node:module';
import path from 'node:path';
import { URL as NodeURL } from 'node:url';
import { MessageStore } from '../../../api/dist/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../../../api/dist/domains/cats/services/stores/ports/ThreadStore.js';
import {
  createGuideStoreBridge,
  InMemoryGuideSessionStore,
} from '../../../api/dist/domains/guides/GuideSessionRepository.js';
import { composerDraftRecallRoutes } from '../../../api/dist/routes/composer-draft-recall.js';
import { configOnboardingRoutes } from '../../../api/dist/routes/config-onboarding.js';
import { guideActionRoutes } from '../../../api/dist/routes/guide-action-routes.js';

const requireApi = createRequire(new NodeURL('../../../api/package.json', import.meta.url));
const Fastify = requireApi('fastify');

// Real route handlers, guide state machine, draft revision fences and preference files. Only the
// authenticated session is supplied by this fixture; no production auth bypass.
export async function openFirstRunEntryApi(projectRoot, userId) {
  const app = Fastify();
  const threadStore = new ThreadStore();
  const guideSessionStore = new InMemoryGuideSessionStore();
  const guideBridge = createGuideStoreBridge(guideSessionStore);
  app.decorateRequest('sessionUserId', null);
  app.addHook('onRequest', async (request) => {
    request.sessionUserId = userId;
  });
  await app.register(configOnboardingRoutes, { projectRoot });
  await app.register(guideActionRoutes, {
    threadStore,
    guideSessionStore,
    socketManager: { emitToUser() {}, broadcastToRoom() {} },
  });
  await app.register(composerDraftRecallRoutes, {
    messageStore: new MessageStore(),
    socketManager: { emitToUser() {}, broadcastToRoom() {} },
  });
  await app.ready();
  return {
    app,
    guideBridge,
    preferencesPath: path.join(projectRoot, '.cat-cafe/user-preferences.json'),
    request: (url, options = {}) =>
      app.inject({
        url,
        method: options.method ?? 'GET',
        headers: { 'X-Cat-Cafe-User': userId, 'Content-Type': 'application/json' },
        ...(options.body ? { payload: options.body } : {}),
      }),
  };
}
