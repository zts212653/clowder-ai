import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessageStore } from '../../dist/domains/cats/services/stores/ports/MessageStore.js';
import { createDecisionFixture, createProposal, OWNER } from '../scheduler/schedule-proposal-decision-fixture.js';

const THREAD = 'thread-owner';
const CAT = 'codex-sol';
const SECRET = 'proposal-body-must-never-enter-live-input';

function liveTracker(overrides = {}) {
  const calls = [];
  const run = {
    threadId: THREAD,
    targetId: CAT,
    invocationId: 'exact-invocation',
    responseMessageId: 'exact-response',
    inputEntryIds: [],
    inputMessageIds: [],
    privateInputEntryIds: [],
    startedAt: 1,
    ...overrides.run,
  };
  const handle = { provider: 'openai_codex', carrier: 'codex_app_server', threadId: 'native', turnId: 'native-turn' };
  const dispatcher = {
    invocationId: run.invocationId,
    capabilities: { append: true, steer: true, inputReadReceipt: true },
    handle,
    async dispatch(input, options) {
      calls.push({ input, options });
      return { accepted: true, handle };
    },
    ...overrides.dispatcher,
  };
  const tracker = {
    calls,
    run,
    dispatcher,
    getUserId: () => overrides.userId ?? OWNER,
    getActiveSlots: () => [{ catId: CAT, startedAt: 1, activeRun: run }],
    getAgentClientActiveRunDispatcher: () => dispatcher,
    ...overrides.tracker,
  };
  return tracker;
}

async function fixture(t, invocationTracker, options = {}) {
  const logs = [];
  const fx = await createDecisionFixture({
    invocationTracker,
    logger: {
      warn: (...args) => logs.push({ level: 'warn', args }),
      info: (...args) => logs.push({ level: 'info', args }),
    },
    ...options,
  });
  t.after(() => fx.close());
  const proposal = createProposal();
  proposal.mutation.task.params.message = SECRET;
  fx.store.create(proposal);
  fx.anchor(proposal);
  return { ...fx, logs, proposal };
}

for (const action of ['approve', 'reject']) {
  test(`real schedule ${action} appends the same durable receipt once to the exact live run`, async (t) => {
    const tracker = liveTracker();
    const fx = await fixture(t, tracker);
    const response = await fx.decide(fx.proposal.proposalId, action, { rejectionReason: 'No longer needed' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['x-approval-receipt-status'], 'complete');
    const messages = fx.messageStore.getByThread(THREAD, 20, OWNER);
    assert.equal(messages.length, 1);
    assert.equal(tracker.calls.length, 1, 'the requester must receive the result in its current invocation');
    const [{ input, options }] = tracker.calls;
    assert.equal(input.text, messages[0].content);
    assert.deepEqual(input.messageIds, [messages[0].id]);
    assert.deepEqual(options, { force: false, expectedInvocationId: 'exact-invocation' });
    assert.ok(input.deliveryId.includes(messages[0].id));
    assert.equal(JSON.stringify(input).includes(SECRET), false);
    if (action === 'reject') assert.match(input.text, /No longer needed/);
    assert.deepEqual(messages[0].mentions, []);

    const subject = { ownerUserId: OWNER, producerId: 'F139', canonicalProposalId: fx.proposal.proposalId };
    await Promise.all(Array.from({ length: 6 }, () => fx.receipts.deliver(subject)));
    fx.receipts.prepare(subject);
    assert.equal(await fx.receipts.recover(), true);
    assert.equal((await fx.decide(fx.proposal.proposalId, action)).statusCode, 409);
    assert.equal(tracker.calls.length, 1, 'repeated HTTP, concurrency and outbox replay never dispatch again');
    assert.equal(fx.messageStore.getByThread(THREAD, 20, OWNER).length, 1);
    await input.onInputRead();
    assert.ok(fx.logs.some(({ args }) => args[0]?.phase === 'read' && args[0]?.responseMessageId === 'exact-response'));
  });
}

for (const [name, overrides] of [
  ['idle', { tracker: { getActiveSlots: () => [] } }],
  ['same cat in another thread', { run: { threadId: 'another-thread' } }],
  ['another requester', { run: { targetId: 'kimi' } }],
  ['foreign user', { userId: 'foreign-user' }],
  ['unsupported carrier', { dispatcher: { capabilities: { append: false, steer: true } } }],
  ['different invocation dispatcher', { dispatcher: { invocationId: 'other-invocation' } }],
]) {
  test(`${name}: keep the receipt without waking or redirecting`, async (t) => {
    const tracker = liveTracker(overrides);
    const fx = await fixture(t, tracker);
    assert.equal((await fx.decide(fx.proposal.proposalId, 'reject')).statusCode, 200);
    assert.equal(tracker.calls.length, 0);
    assert.equal(fx.messageStore.getByThread(THREAD, 20, OWNER).length, 1);
    assert.deepEqual(fx.outbox.list(), []);
  });
}

test('a closed or replaced selected run is never replaced by a second destination', async (t) => {
  for (const result of [
    { accepted: false, reason: 'active_run_closed', acceptance: 'not_accepted' },
    { accepted: false, reason: 'active_run_mismatch', acceptance: 'unknown' },
    new Error('provider append failed'),
  ]) {
    const tracker = liveTracker();
    tracker.dispatcher.dispatch = async (input, options) => {
      tracker.calls.push({ input, options });
      tracker.run.invocationId = 'replacement-run';
      tracker.run.responseMessageId = 'replacement-response';
      if (result instanceof Error) throw result;
      return result;
    };
    const fx = await fixture(t, tracker);
    const response = await fx.decide(fx.proposal.proposalId, 'approve');
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['x-approval-receipt-status'], 'complete');
    assert.equal(fx.store.getById(fx.proposal.proposalId).status, 'approved');
    assert.equal(tracker.calls.length, 1);
    assert.equal(tracker.calls[0].options.expectedInvocationId, 'exact-invocation');
    assert.equal(fx.messageStore.getByThread(THREAD, 20, OWNER).length, 1);
    assert.deepEqual(fx.outbox.list(), []);
  }
});

test('a run replaced between selection and handoff is skipped rather than retargeted', async (t) => {
  const tracker = liveTracker();
  let reads = 0;
  tracker.getActiveSlots = () => {
    reads += 1;
    return [
      {
        catId: CAT,
        activeRun: reads === 1 ? tracker.run : { ...tracker.run, responseMessageId: 'replacement-response' },
      },
    ];
  };
  const fx = await fixture(t, tracker);
  assert.equal((await fx.decide(fx.proposal.proposalId, 'approve')).statusCode, 200);
  assert.equal(tracker.calls.length, 0);
  assert.equal(fx.messageStore.getByThread(THREAD, 20, OWNER).length, 1);
});

test('append ACK loss after durable commit never dispatches during recovery', async (t) => {
  const messages = new MessageStore();
  const append = messages.appendIdempotent.bind(messages);
  let loseAck = true;
  messages.appendIdempotent = (input) => {
    const result = append(input);
    if (loseAck) {
      loseAck = false;
      throw new Error('message committed but ACK lost');
    }
    return result;
  };
  const tracker = liveTracker();
  const fx = await fixture(t, tracker, { messageStore: messages });
  const response = await fx.decide(fx.proposal.proposalId, 'reject');
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['x-approval-receipt-status'], 'pending');
  assert.equal(messages.getByThread(THREAD, 20, OWNER).length, 1);
  assert.equal(tracker.calls.length, 0);
  assert.equal(await fx.receipts.recover(), true);
  assert.equal(tracker.calls.length, 0, 'a replayed durable message is not a new provider delivery');
  assert.deepEqual(fx.outbox.list(), []);
});
