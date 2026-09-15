import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runCodexAppServerWithRecovery } from '../dist/domains/cats/services/agents/providers/CodexAppServerRunner.js';
import {
  approvedCallEvents,
  ConsentWire,
  collect,
  consentRequest,
  exercise,
  itemCompleted,
  itemStarted,
  owner,
  PROVIDER_THREAD,
  reviewCompleted,
  reviewStarted,
  turnCompleted,
  waitFor,
} from './helpers/f306-provider-native-capability-fixture.js';

test('F306 accepts exact active bundled Computer Use consent after provider auto-review on fresh and resumed turns', async () => {
  for (const thread of [{ kind: 'start' }, { kind: 'resume', threadId: PROVIDER_THREAD }]) {
    const callId = `call-${thread.kind}`;
    const app = thread.kind === 'start' ? 'com.google.Chrome' : 'com.apple.TextEdit';
    const { response, humanRequests } = await exercise({
      thread,
      events: approvedCallEvents(callId),
      request: consentRequest(51, callId, { meta: { tool_params: { app } } }),
    });
    assert.equal(humanRequests.length, 0);
    assert.equal(response.result.action, 'accept', thread.kind);
    assert.equal(response.result.content.scope, 'session');
    assert.equal(response.result._meta.persist, 'session');
  }
});

test('F306 declines unlinked, unreviewed, stale, malformed, foreign, or reordered native consent with zero human cards', async () => {
  const cases = [
    ['unlinked', [], consentRequest(61, 'call-unlinked')],
    ['unreviewed', [itemStarted('call-unreviewed')], consentRequest(62, 'call-unreviewed')],
    [
      'review-before-item',
      [reviewCompleted('call-reordered'), itemStarted('call-reordered')],
      consentRequest(63, 'call-reordered'),
    ],
    [
      'foreign-review-turn',
      [itemStarted('call-foreign'), reviewCompleted('call-foreign', { turnId: 'foreign-turn' })],
      consentRequest(64, 'call-foreign'),
    ],
    [
      'foreign-plugin',
      [itemStarted('call-plugin', { pluginId: 'unified-computer-use@foreign' }), reviewCompleted('call-plugin')],
      consentRequest(65, 'call-plugin'),
    ],
    [
      'denied-review',
      [
        itemStarted('call-denied'),
        reviewStarted('call-denied'),
        reviewCompleted('call-denied', { review: { status: 'denied' } }),
      ],
      consentRequest(66, 'call-denied'),
    ],
    [
      'review-action-mismatch',
      [
        itemStarted('call-action'),
        reviewStarted('call-action'),
        reviewCompleted('call-action', { action: { type: 'mcpToolCall', server: 'cua_repl', toolName: 'other' } }),
      ],
      consentRequest(661, 'call-action'),
    ],
    [
      'reused-call-id',
      [...approvedCallEvents('call-reused'), itemStarted('call-reused', { pluginId: 'foreign' })],
      consentRequest(662, 'call-reused'),
    ],
    [
      'inactive-item',
      [itemStarted('call-inactive', { status: 'completed' }), reviewCompleted('call-inactive')],
      consentRequest(663, 'call-inactive'),
    ],
    [
      'completed-item',
      [...approvedCallEvents('call-stale'), itemCompleted('call-stale')],
      consentRequest(67, 'call-stale'),
    ],
    ['mismatched-call', [itemStarted('call-a'), reviewCompleted('call-a')], consentRequest(68, 'call-b')],
    [
      'missing-call-id',
      [itemStarted('call-missing'), reviewCompleted('call-missing')],
      consentRequest(69, undefined, { meta: { callId: undefined } }),
    ],
    [
      'missing-turn-id',
      [itemStarted('call-turn'), reviewCompleted('call-turn')],
      consentRequest(70, 'call-turn', { params: { turnId: null } }),
    ],
    [
      'foreign-server',
      [itemStarted('call-server'), reviewCompleted('call-server')],
      consentRequest(701, 'call-server', { params: { serverName: 'foreign-cua' } }),
    ],
    [
      'foreign-connector',
      [itemStarted('call-connector'), reviewCompleted('call-connector')],
      consentRequest(702, 'call-connector', { meta: { connector_id: 'foreign-computer-use' } }),
    ],
  ];

  for (const [name, events, request] of cases) {
    const { response, humanRequests } = await exercise({ events, request });
    assert.equal(humanRequests.length, 0, name);
    assert.equal(response.result.action, 'decline', name);
    assert.match(String(response.result._meta.reasonCode), /^capability_/, name);
  }
});

test('F306 rebuilds provider-native approval evidence after pre-turn recovery instead of carrying a stale window', async () => {
  const first = new ConsentWire();
  first.read = () => ({
    [Symbol.asyncIterator]() {
      return { next: async () => Promise.reject(new Error('startup transport failed')) };
    },
  });
  const second = new ConsentWire();
  const wires = [first, second];
  let factoryCalls = 0;
  const humanRequests = [];
  const run = collect(
    runCodexAppServerWithRecovery({
      sessionFactory: async () => wires[factoryCalls++],
      sessionOptions: { command: 'codex', args: ['app-server', '--stdio'], invocationId: 'inv-recovery' },
      runInput: {
        prompt: { kind: 'frozen', prompt: 'recover exact provider-native consent' },
        thread: { kind: 'resume', threadId: PROVIDER_THREAD },
        approvalsReviewer: 'auto_review',
        runtimeInteraction: {
          owner,
          declaredMcpServerNames: [],
          port: {
            request: async (interaction) => {
              humanRequests.push(interaction);
              return { kind: 'decision', decisionId: 'decline' };
            },
          },
        },
      },
      retryBudget: 1,
    }),
  );
  await waitFor(() => second.writes.some((message) => message.method === 'turn/start'));
  for (const event of approvedCallEvents('call-recovery')) second.inbox.push(event);
  second.inbox.push(consentRequest(71, 'call-recovery'));
  await waitFor(() => second.writes.some((message) => message.id === 71));
  assert.equal(humanRequests.length, 0);
  assert.equal(second.writes.find((message) => message.id === 71).result.action, 'accept');
  second.inbox.push(turnCompleted());
  const output = await run;
  assert.equal(factoryCalls, 2);
  assert.equal(output.filter((event) => event.type === 'app_server.recovery').length, 1);
});
