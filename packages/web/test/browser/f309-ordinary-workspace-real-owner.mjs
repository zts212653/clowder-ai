import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fulfillFixtureApi } from './f309-ordinary-workspace-journey-actions.mjs';
import { createReviewState, fixtureForApi, THREAD_ID, WEB_ROOT } from './f309-ordinary-workspace-journey-fixture.mjs';

/**
 * Starts the shipped workspace + F309 content-review routes over this checkout, with private data.
 * Only the session issuer is synthetic; reads, refusals, writes and SQLite persistence are real.
 */
export async function startRealWorkspaceOwner(dataDir) {
  const root = path.resolve(WEB_ROOT, '../..');
  const previousDataDir = process.env.CAT_CAFE_DATA_DIR;
  const previousRoot = process.env.CAT_CAFE_WORKSPACE_ROOT;
  process.env.CAT_CAFE_DATA_DIR = dataDir;
  process.env.CAT_CAFE_WORKSPACE_ROOT = root;
  const requireApi = createRequire(fileURLToPath(new URL('../../../api/package.json', import.meta.url)));
  const Fastify = requireApi('fastify');
  const { createWorkspaceContentReviewComposition } = await import(
    '../../../api/dist/domains/collaborative-content/workspace-review/composition.js'
  );
  const { registerWorkspaceContentReviewRoutes } = await import(
    '../../../api/dist/routes/workspace-content-review-routes.js'
  );
  const { workspaceRoutes } = await import('../../../api/dist/routes/workspace.js');
  const content = createWorkspaceContentReviewComposition({ dataDir, ownerUserId: 'operator' });
  const app = Fastify();
  app.decorateRequest('sessionUserId', null);
  app.addHook('onRequest', async (request) => {
    request.sessionUserId = 'operator';
  });
  await app.register(workspaceRoutes);
  registerWorkspaceContentReviewRoutes(app, { reviews: content.reviews });
  const api = await app.listen({ host: '127.0.0.1', port: 0 });
  return {
    root,
    api,
    async close() {
      await app.close();
      content.store.close();
      if (previousDataDir === undefined) delete process.env.CAT_CAFE_DATA_DIR;
      else process.env.CAT_CAFE_DATA_DIR = previousDataDir;
      if (previousRoot === undefined) delete process.env.CAT_CAFE_WORKSPACE_ROOT;
      else process.env.CAT_CAFE_WORKSPACE_ROOT = previousRoot;
    },
  };
}

/**
 * Proxies `/api/workspace/*` to the real owner (narrowed to this checkout's worktree) and serves the
 * unrelated chat shell from the fixture. `extra` may answer a request first by returning true.
 */
export async function routeThroughRealOwner(context, owner, { onReviewPost, extra } = {}) {
  await context.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (extra && (await extra(route, url))) return;
    if (url.pathname.startsWith('/api/workspace/')) {
      const response = await route.fetch({ url: `${owner.api}${url.pathname}${url.search}` });
      if (url.pathname === '/api/workspace/worktrees') {
        const data = await response.json();
        assert.ok(response.ok(), JSON.stringify(data));
        data.worktrees = data.worktrees.filter((entry) => entry.root === owner.root);
        assert.equal(data.worktrees.length, 1);
        return route.fulfill({ response, json: data });
      }
      if (onReviewPost && request.method() === 'POST' && url.pathname.includes('/content-reviews/')) {
        onReviewPost({
          path: url.pathname,
          request: request.postDataJSON(),
          status: response.status(),
          response: await response.json(),
        });
      }
      return route.fulfill({ response });
    }
    if (url.pathname === '/api/threads' || url.pathname === `/api/threads/${THREAD_ID}`) {
      const data = fixtureForApi(url, undefined, createReviewState());
      if (data.threads) data.threads[0].projectPath = owner.root;
      else data.projectPath = owner.root;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
    }
    return fulfillFixtureApi(route, createReviewState(), []);
  });
}
