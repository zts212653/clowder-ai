import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { registerArtifactReviewRoutes } from '../../../api/dist/routes/artifact-review-routes.js';
import { registerCallbackArtifactReviewRoutes } from '../../../api/dist/routes/callback-artifact-review-routes.js';
import { messageActionsRoutes } from '../../../api/dist/routes/message-actions.js';
import { registerPublishedContentRoutes } from '../../../api/dist/routes/published-content-routes.js';
import { threadsRoutes } from '../../../api/dist/routes/threads.js';
import { registerWorkspaceContentReviewRoutes } from '../../../api/dist/routes/workspace-content-review-routes.js';

/** Extend the existing private native owner with shipped media/publication routes, never a second review authority. */
export async function registerNativeMediaOwnerRoutes({
  app,
  artifacts,
  integration,
  threads,
  messages,
  tasks,
  registry,
  dataDir,
  socketManager,
}) {
  await app.register(async (scope) => registerArtifactReviewRoutes(scope, artifacts));
  registerPublishedContentRoutes(app, { media: artifacts.media });
  registerWorkspaceContentReviewRoutes(app, {
    reviews: artifacts.ledgers,
    namespace: 'publication',
    changed: artifacts.changed,
  });
  await registerCallbackArtifactReviewRoutes(app, {
    ...artifacts,
    sourceDiscussions: integration.sourceDiscussions,
    threads,
    registry,
  });
  app.get('/uploads/:name', async (request, reply) => {
    const { name } = request.params;
    if (!/^native-(candidate|original)-\d+\.(png|jpg|webp|mp4)$/.test(name)) return reply.code(404).send();
    const mime = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', mp4: 'video/mp4' }[
      path.extname(name).slice(1)
    ];
    return reply.type(mime).send(await readFile(path.join(dataDir, name)));
  });
  await app.register(messageActionsRoutes, { messageStore: messages, threadStore: threads, socketManager });
  // Use the shipped Works envelope, pagination and source coverage; never invent completeness or lineage.
  await app.register(threadsRoutes, { threadStore: threads, messageStore: messages, taskStore: tasks });
}
