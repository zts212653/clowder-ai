import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CodexAppServerClient } from '../dist/domains/cats/services/agents/providers/CodexAppServerClient.js';
import {
  approvedCallEvents,
  ConsentWire,
  collect,
  consentRequest,
  exercise,
  itemCompleted,
  itemStarted,
  owner,
  reviewCompleted,
  reviewStarted,
  turnCompleted,
  waitFor,
} from './helpers/f306-provider-native-capability-fixture.js';

test('F306 never applies an earlier review to a reused provider item id', async () => {
  const { response, humanRequests } = await exercise({
    events: [
      ...approvedCallEvents('call-reused'),
      itemCompleted('call-reused'),
      itemStarted('call-reused', { arguments: { code: 'different invocation data' } }),
      reviewCompleted('call-reused'),
    ],
    request: consentRequest(81, 'call-reused'),
  });
  assert.equal(humanRequests.length, 0);
  assert.equal(response.result.action, 'decline');
});

test('F306 revokes an approval when a new provider review starts', async () => {
  const { response, humanRequests } = await exercise({
    events: [...approvedCallEvents('call-rereview'), reviewStarted('call-rereview', { reviewId: 'review-rereview-2' })],
    request: consentRequest(82, 'call-rereview'),
  });
  assert.equal(humanRequests.length, 0);
  assert.equal(response.result.action, 'decline');
});

test('F306 poisons a duplicated review identity instead of leaving its first item approvable', async () => {
  const sharedReviewId = 'review-shared';
  const { response, humanRequests } = await exercise({
    events: [
      itemStarted('call-first'),
      reviewStarted('call-first', { reviewId: sharedReviewId }),
      itemStarted('call-second'),
      reviewStarted('call-second', { reviewId: sharedReviewId }),
      reviewCompleted('call-first', { reviewId: sharedReviewId }),
    ],
    request: consentRequest(821, 'call-first'),
  });
  assert.equal(humanRequests.length, 0);
  assert.equal(response.result.action, 'decline');
});

test('F306 poisons an item identity first observed as completed', async () => {
  const { response, humanRequests } = await exercise({
    events: [itemCompleted('call-out-of-order'), ...approvedCallEvents('call-out-of-order')],
    request: consentRequest(822, 'call-out-of-order'),
  });
  assert.equal(humanRequests.length, 0);
  assert.equal(response.result.action, 'decline');
});

test('F306 treats whitespace-altered callId as malformed instead of normalizing an authority coordinate', async () => {
  const { response, humanRequests } = await exercise({
    events: approvedCallEvents('call-exact'),
    request: consentRequest(83, ' call-exact '),
  });
  assert.equal(humanRequests.length, 0);
  assert.equal(response.result.action, 'decline');
});

test('F306 never trims sibling typed capability provenance into an authority match', async () => {
  for (const [name, request] of [
    ['server', consentRequest(831, 'call-server-space', { params: { serverName: ' cua_repl ' } })],
    ['connector', consentRequest(832, 'call-connector-space', { meta: { connector_id: ' computer-use ' } })],
    ['tool', consentRequest(833, 'call-tool-space', { meta: { tool_name: ' get_app_state ' } })],
  ]) {
    const callId = `call-${name}-space`;
    const { response, humanRequests } = await exercise({ events: approvedCallEvents(callId), request });
    assert.equal(humanRequests.length, 0, name);
    assert.equal(response.result.action, 'decline', name);
  }
});

test('F306 seals exact turn completion in the pump before a paused generator consumes it', async () => {
  const wire = new ConsentWire();
  const humanRequests = [];
  const client = new CodexAppServerClient({ wire });
  const iterator = client.run({
    prompt: { kind: 'frozen', prompt: 'seal the provider approval window' },
    thread: { kind: 'start' },
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
  });

  while (!wire.writes.some((message) => message.method === 'turn/start')) {
    const result = await iterator.next();
    assert.equal(result.done, false);
  }
  for (const event of approvedCallEvents('call-after-terminal')) wire.inbox.push(event);
  wire.inbox.push(turnCompleted());
  for (const event of approvedCallEvents('call-after-terminal')) wire.inbox.push(event);
  wire.inbox.push(consentRequest(84, 'call-after-terminal'));

  await waitFor(() => wire.writes.some((message) => message.id === 84));
  assert.equal(humanRequests.length, 0);
  assert.equal(wire.writes.find((message) => message.id === 84).result.action, 'decline');
  await collect(iterator);
});

test('F306 ignores a foreign turn terminal without clearing the active exact approval', async () => {
  const { response, humanRequests } = await exercise({
    events: [...approvedCallEvents('call-live'), turnCompleted('foreign-turn')],
    request: consentRequest(85, 'call-live'),
  });
  assert.equal(humanRequests.length, 0);
  assert.equal(response.result.action, 'accept');
});
