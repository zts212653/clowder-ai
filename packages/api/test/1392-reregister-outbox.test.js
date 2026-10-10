import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';

const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
const { InvocationRegistry } = await import('../dist/domains/cats/services/agents/invocation/InvocationRegistry.js');
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
const { MemoryWaitLifecycleEventLog } = await import('../dist/domains/ball-custody/WaitLifecycleEventLog.js');
const { GitHubWaitLifecycleService } = await import('../dist/domains/github-signals/GitHubWaitLifecycleService.js');
const { connectorDeliveryHarness } = await import('./helpers/connector-delivery-harness.js');

describe('#1392 explicit registration preserves delivery already owed to the owner', () => {
  for (const subject of ['pr', 'issue']) {
    for (const mode of [
      'continuous',
      'single-fire',
      'expired',
      'successor-expired',
      'cross-owner',
      'cross-owner-expired',
    ]) {
      it(`${subject}: recovers the pending ${mode} outcome after re-registration`, async (t) => {
        const registry = new InvocationRegistry();
        const taskStore = new TaskStore();
        const messageStore = new MessageStore();
        const threadStore = new ThreadStore();
        const eventLog = new MemoryWaitLifecycleEventLog();
        const thread = await threadStore.create('user-1', 'outbox re-registration');
        const { invocationId, callbackToken } = await registry.create('user-1', 'opus', thread.id);
        const wakes = [];
        const connector = connectorDeliveryHarness({ messageStore });
        const lifecycleOptions = {
          taskStore,
          deliveryDeps: connector.deliveryDeps,
          eventLog,
          log: { info() {}, warn() {}, error() {} },
          wakeOwner: (delivered) => wakes.push(delivered.outcome.outcomeId),
        };
        const lifecycle = new GitHubWaitLifecycleService(lifecycleOptions);
        let liveHead = 'before';
        let liveCursor = 10;
        const app = Fastify();
        t.after(() => app.close());
        await app.register(callbacksRoutes, {
          registry,
          messageStore,
          threadStore,
          taskStore,
          socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, getMessages: () => [] },
          evidenceStore: { search: async () => [] },
          reflectionService: {},
          markerQueue: { list: async () => [], transition: async () => {} },
          waitLifecycleHolder: { current: lifecycle },
          fetchPrWaitBaseline: async () => ({
            baseline: { capturedAt: Date.now(), headSha: liveHead },
            collectorState: { ci: { headSha: liveHead } },
          }),
          fetchIssueWaitBaseline: async () => ({
            baseline: { capturedAt: Date.now(), issue: { lastCommentCursor: liveCursor, state: 'open' } },
            collectorState: {
              issue: { lastCommentCursor: liveCursor, lastDeliveredCursor: liveCursor, issueState: 'open' },
            },
          }),
          resolveGitHubPrTrackingIdentity: async () => ({ selfLogin: 'self', subjectAuthorLogin: 'self' }),
          resolveGitHubSelfLogin: async () => 'self',
        });

        const register = (extra = {}, credentials = { invocationId, callbackToken }) =>
          app.inject({
            method: 'POST',
            url: `/api/callbacks/register-${subject}-tracking`,
            headers: { 'x-invocation-id': credentials.invocationId, 'x-callback-token': credentials.callbackToken },
            payload: {
              repoFullName: 'owner/repo',
              ...(subject === 'pr' ? { prNumber: 7 } : { issueNumber: 7 }),
              when: [{ kind: subject === 'pr' ? 'pr_head_changed' : 'issue_comment_added' }],
              nextStep: 'Handle the first observation.',
              ...extra,
            },
          });
        const expiresAt = Date.now() + 60_000;
        const first = await register({
          ...(mode === 'single-fire' ? { autoRenew: false } : {}),
          ...(mode.endsWith('expired') ? { expiresAt } : {}),
        });
        assert.equal(first.statusCode, 200, first.body);
        const taskId = first.json().task.id;
        // RFC §5.2: the durable boundary is atomic Message+Queue admission, not a bare store
        // append. Inject the outage at that exact seam so this still proves the product fact:
        // a failed delivery must not settle the outbox.
        const append = messageStore.appendWithQueueLedgerAdmission.bind(messageStore);
        messageStore.appendWithQueueLedgerAdmission = () => {
          throw new Error('delivery temporarily offline');
        };
        liveHead = 'after';
        liveCursor = 11;
        await assert.rejects(
          lifecycle.observe({
            taskId,
            at: mode === 'expired' ? expiresAt : Date.now(),
            facts:
              subject === 'pr'
                ? { headSha: liveHead }
                : { issue: { state: 'open', comments: [{ id: liveCursor, author: 'author' }] } },
          }),
          /delivery temporarily offline/,
        );
        const before = await taskStore.get(taskId);
        const pending = structuredClone(before.automationState.waitOutcome);
        // The claim is taken before the send, so a delivery that throws leaves the outcome claimed.
        // `delivery` deliberately stays `pending` so an older binary would still deliver it; the
        // claim rides on its own field. The recovery below is what proves it is still drainable.
        assert.equal(pending.delivery, 'pending');
        assert.equal(typeof pending.publishClaimedAt, 'number', 'and it carries the publish claim');
        assert.equal(pending.reason, mode === 'expired' ? 'expired' : 'matched');
        const renewed = mode !== 'single-fire' && mode !== 'expired';
        assert.equal(before.automationState.await?.generation, renewed ? 2 : undefined);

        // The delivery backend is still unavailable: registering cannot depend on draining it now.
        const successorExpired = mode === 'successor-expired' || mode === 'cross-owner-expired';
        if (successorExpired || mode === 'cross-owner') {
          if (successorExpired) t.mock.method(Date, 'now', () => expiresAt + 1);
          let credentials = { invocationId, callbackToken };
          if (mode.startsWith('cross-owner')) {
            const otherThread = await threadStore.create('user-1', 'other tracking owner');
            credentials = await registry.create('user-1', 'codex', otherThread.id);
          }
          const blocked = await register({}, credentials);
          assert.equal(blocked.statusCode, 409, 'two owed deliveries cannot share one outbox slot');
          assert.match(blocked.json().error, /pending delivery/);
          assert.deepEqual(await taskStore.get(taskId), before, 'a rejected registration must have no task mutation');
          messageStore.appendWithQueueLedgerAdmission = append;
          await new GitHubWaitLifecycleService(lifecycleOptions).recoverOutcome(taskId);
        }
        const second = await register({ nextStep: 'Handle the next observation.' });
        assert.equal(second.statusCode, 200, second.body);
        const installed = (await taskStore.get(taskId)).automationState;
        assert.equal(installed.await.generation, renewed ? 3 : 2);
        assert.equal(installed.await.continuation.then, 'Handle the next observation.');
        if (successorExpired) {
          assert.equal(installed.waitOutcome.generation, 2);
          assert.equal(installed.waitOutcome.reason, 'expired');
          assert.equal(installed.waitOutcome.delivery, 'pending');
        } else if (mode === 'cross-owner') {
          assert.equal(installed.waitOutcome.reason, 'superseded');
        } else {
          assert.deepEqual(installed.waitOutcome, pending, 'the new wait must retain the undelivered old result');
        }
        if (mode === 'continuous') {
          assert.ok(
            (await eventLog.read(taskId)).some((event) => event.generation === 2 && event.reason === 'superseded'),
          );
        }

        messageStore.appendWithQueueLedgerAdmission = append;
        // Restart the lifecycle consumer: only TaskStore state may carry the owed notification.
        const restarted = new GitHubWaitLifecycleService(lifecycleOptions);
        assert.equal((await restarted.recoverOutcome(taskId)).kind, mode === 'cross-owner' ? 'state_only' : 'notified');
        await restarted.recoverOutcome(taskId);
        // RFC §5.2: the owed notification is durable at Queue commit. A queued source is not yet a
        // History member, so observe the same boundary production settles on.
        const messages = connector.deliveries(thread.id, 'user-1');
        assert.equal(messages.length, successorExpired ? 2 : 1);
        assert.deepEqual(messages[0].mentions, ['opus']);
        assert.match(messages[0].content, /Handle the first observation/);
        assert.deepEqual(
          wakes,
          successorExpired ? [pending.outcomeId, installed.waitOutcome.outcomeId] : [pending.outcomeId],
        );
        const recovered = (await taskStore.get(taskId)).automationState;
        assert.equal(recovered.waitOutcome.delivery, mode === 'cross-owner' ? 'not_applicable' : 'delivered');
        assert.deepEqual(recovered.await, installed.await, 'recovery must preserve the newly registered wait');
      });
    }
  }
});
