import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readIgnoredItemPreferences } from '../../../api/src/config/user-preferences-ignored-items.ts';
import { InvocationRegistry } from '../../../api/src/domains/cats/services/agents/invocation/InvocationRegistry.ts';
import { registerArtifactReviewRoutes } from '../../../api/src/routes/artifact-review-routes.ts';
import { registerCallbackArtifactReviewRoutes } from '../../../api/src/routes/callback-artifact-review-routes.ts';
import { registerCallbackAuthHook } from '../../../api/src/routes/callback-auth-prehandler.ts';
import { registerCallbackTaskRoutes } from '../../../api/src/routes/callback-task-routes.ts';
import { registerEntrustedWorkReadRoutes } from '../../../api/src/routes/entrusted-work-read-routes.ts';
import { registerPublishedContentRoutes } from '../../../api/src/routes/published-content-routes.ts';
import { createLiveReviewFixture } from '../../../api/test/helpers/artifact-review-live-fixture.ts';
import { createInboxProposalFixture } from './f322-inbox-proposal.fixture.mjs';

const require = createRequire(new URL('../../../api/package.json', import.meta.url));
const { Server } = require('socket.io');
/** Original F309 Task/journal/media/publication/HTTP writers inside the same actual Next owner fixture. */
export async function createNextReviewFixture(root) {
  let sockets, fixture;
  const priorOwner = process.env.DEFAULT_OWNER_USER_ID;
  process.env.DEFAULT_OWNER_USER_ID = 'operator';
  const restoreOwner = () => {
    if (priorOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
    else process.env.DEFAULT_OWNER_USER_ID = priorOwner;
  };
  const emit = (userId, event, data) => sockets?.to(`user:${userId}`).emit(event, data);
  const review = await createLiveReviewFixture(root, 'image/png', emit).catch((error) => {
    restoreOwner();
    throw error;
  });
  const registry = new InvocationRegistry();
  const credentials = await registry.create('operator', 'codex-astra', review.thread.id);
  try {
    fixture = await createInboxProposalFixture({
      ownerUserId: 'operator',
      // This bounded review host owns no collective requests. Supply the unrelated source explicitly;
      // omitting its port correctly produces an uncertain global read and prevents Inbox commits.
      collectiveAccountability: async (owner) => {
        assert.equal(owner, 'operator');
        const observedAt = Date.now();
        return {
          status: 200,
          body: {
            data: {
              items: [],
              reasons: [],
              state: {
                coverage: 'pending_f290_collective_accountability_requests',
                status: 'available',
                exhaustiveness: 'complete',
                startedAt: observedAt,
                observedAt,
              },
            },
          },
        };
      },
      readIgnoredPreferences: (owner) => readIgnoredItemPreferences(root, owner),
      participantIds: ['codex61-sol', 'codex-astra'],
      messageStore: review.messages,
      threadStore: review.threads,
      configureOwnedReads: async ({ app }) => {
        await app.register(async (scope) => {
          registerCallbackAuthHook(scope, registry);
          registerCallbackTaskRoutes(scope, {
            taskStore: review.tasks,
            messageStore: review.messages,
            threadStore: review.threads,
            socketManager: { emitToUser: emit, broadcastAgentMessage() {}, broadcastToRoom() {} },
          });
          await registerCallbackArtifactReviewRoutes(scope, { ...review, threads: review.threads, registry });
        });
        await app.register(async (scope) => registerArtifactReviewRoutes(scope, review));
        registerPublishedContentRoutes(app, { media: review.media });
        await app.register(async (scope) =>
          registerEntrustedWorkReadRoutes(scope, { service: review.ownerReads, callbackRegistry: registry }),
        );
        sockets = new Server(app.server, { cors: { origin: true, credentials: true } });
        sockets.on('connection', (socket) => {
          void socket.join('user:operator');
        });
        app.addHook('onClose', async () => {
          await new Promise((resolve) => sockets.close(resolve));
        });
      },
    });
    async function callback(operation, body) {
      const response = await fetch(`http://127.0.0.1:${fixture.apiPort}/api/callbacks/${operation}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-invocation-id': credentials.invocationId,
          'x-callback-token': credentials.callbackToken,
        },
        body: JSON.stringify(body),
      });
      const value = await response.json();
      assert.equal(response.status, 200, JSON.stringify(value));
      return value;
    }
    return {
      ...fixture,
      review,
      callback,
      async prepare() {
        await callback('update-entrusted-work', { taskId: review.taskId, expectedRevision: 1, status: 'doing' });
        const task = await review.tasks.get(review.taskId);
        assert.equal(task.entrustedWork.revision, 2);
        const prepared = await callback('artifact-review/prepare', { ...review.prepare, expectedTaskRevision: 2 });
        await callback('artifact-review/act', {
          reviewId: prepared.reviewId,
          expectedRevision: prepared.revision,
          expectedTaskRevision: 2,
          operationId: 'next-review-judgment',
          round: 1,
          action: { kind: 'request_judgment', summary: '核对封面标题', judgmentNeeded: '这版标题能否继续发布？' },
        });
        return prepared;
      },
      async close() {
        try {
          await fixture.close();
        } finally {
          await review.dispatch.close();
          review.store.close();
          restoreOwner();
        }
      },
    };
  } catch (error) {
    await fixture?.close();
    await review.dispatch.close();
    review.store.close();
    restoreOwner();
    throw error;
  }
}
