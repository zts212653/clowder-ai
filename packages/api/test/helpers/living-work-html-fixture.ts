import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { InvocationRegistry } from '../../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { ArtifactReviewStore } from '../../src/domains/collaborative-content/artifact-review/store.js';
import { createWorkAuthorizer } from '../../src/domains/collaborative-content/works/access.js';
import { LivingWorkService } from '../../src/domains/collaborative-content/works/service.js';
import { registerLivingWorkRoutes } from '../../src/routes/living-work-routes.js';
import { createReviewFixture } from './artifact-review-fixture.js';

export const htmlCreate = {
  action: 'create' as const,
  operationId: 'html-v1',
  title: '同名小工具',
  changeSummary: '第一版',
  source: {
    kind: 'html' as const,
    html: '<!doctype html><html><button id="b">开始 🐾</button><script>document.querySelector("#b").addEventListener("click",()=>{});</script></html>',
  },
};
export async function htmlFixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'f309-html-owner-'));
  const store = new ArtifactReviewStore(join(root, 'review.sqlite'));
  const f = createReviewFixture(root, root, store);
  f.task.current = null;
  f.messages.clear();
  if (!f.thread.current) throw new Error('HTML fixture requires its owning thread');
  // The public fixture uses "operator"; match its actual thread owner on home builds too.
  f.thread.current = { ...f.thread.current, createdBy: 'operator' };
  const registry = new InvocationRegistry();
  const credentials = await registry.create(
    'operator',
    createCatId('codex-astra'),
    'thread-cover',
    undefined,
    undefined,
    undefined,
    undefined,
    'strict',
  );
  const principal = {
    userId: 'operator',
    threadId: 'thread-cover',
    actor: { kind: 'cat' as const, actorId: 'codex-astra' },
    invocationId: credentials.invocationId,
  };
  const deps = {
    owner: f.owner,
    versions: store.works,
    source: {
      openCurrent: async () => {
        throw new Error('HTML must not locate a Workspace file');
      },
      open: async () => {
        throw new Error('HTML must not read a Workspace file');
      },
      inspect: async () => {
        throw new Error('HTML must not probe media');
      },
    },
    authorize: createWorkAuthorizer({
      ownerUserId: 'operator',
      access: f.access,
      invocation: (id) => registry.peekRecord(id),
    }),
  };
  const service = new LivingWorkService(deps);
  const app = Fastify();
  app.decorateRequest('sessionUserId', null);
  app.addHook('onRequest', async (request) => {
    request.sessionUserId =
      typeof request.headers['x-fixture-user'] === 'string' ? request.headers['x-fixture-user'] : null;
  });
  await registerLivingWorkRoutes(app, { service, registry });
  t.after(async () => {
    await app.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const headers = { 'x-invocation-id': credentials.invocationId, 'x-callback-token': credentials.callbackToken };
  const call = (command: unknown, auth = headers, extra = {}) =>
    app.inject({ method: 'POST', url: '/api/callbacks/work', headers: auth, payload: { command, ...extra } });
  return { ...f, root, store, registry, credentials, principal, deps, service, app, headers, call };
}
