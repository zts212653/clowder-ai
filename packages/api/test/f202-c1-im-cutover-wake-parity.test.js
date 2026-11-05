/** Authenticated IM ingress uses ordinary conversation routing and durable effect deduplication. */
import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { getDefaultCatId } from '../dist/config/cat-config-loader.js';

let messagingMod;
let MessageStore;

let messageStore;
let service;
/** Host-side effects the cutover must produce. Today nothing ever pushes into these. */
let wakes;
let broadcasts;
/** Wake attempts vs. successes: the seventh-round P1 is a wake that is attempted once, fails, and
 *  is then never retried, so counting successes alone cannot see it. */
let wakeAttempts;
/** Failures to inject into successive `trigger()` calls (one entry consumed per attempt). */
let wakeFailures;
/** Thread activity the Host consults when no @-mention matched (ConnectorRouter.ts:455-463). */
let participants;

const CTX = { pluginInstanceId: 'inst-im-feishu' };
const CONNECTOR_ID = 'feishu';
const EXTERNAL_CHAT_ID = 'chat-9';
let THREAD_ID;
let threads;
let queue;
/** Deliberately distinct from the most-active participant so case 2 cannot pass by accident. */
const DEFAULT_CAT_ID = getDefaultCatId();

beforeEach(async () => {
  messagingMod = await import('../dist/domains/messaging/messaging-service.js');
  ({ MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js'));

  messageStore = new MessageStore();
  wakes = [];
  broadcasts = [];
  participants = [];
  wakeAttempts = 0;
  wakeFailures = [];

  const [
    { ThreadStore },
    { AgentRegistry },
    { AgentRouter },
    { InvocationRegistry },
    { InvocationQueue },
    { createPluginConversationDelivery },
  ] = await Promise.all([
    import('../dist/domains/cats/services/stores/ports/ThreadStore.js'),
    import('../dist/domains/cats/services/agents/registry/AgentRegistry.js'),
    import('../dist/domains/cats/services/agents/routing/AgentRouter.js'),
    import('../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'),
    import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js'),
    import('../dist/domains/plugin/host-surface/plugin-conversation-delivery.js'),
  ]);
  threads = new ThreadStore();
  THREAD_ID = threads.create('user-1', 'IM ingress').id;
  const agents = new AgentRegistry();
  for (const catId of new Set(['opus', 'codex', DEFAULT_CAT_ID]))
    agents.register(catId, {
      async *invoke() {
        throw Error('no model IO');
      },
    });
  const router = new AgentRouter({
    agentRegistry: agents,
    registry: new InvocationRegistry(),
    messageStore,
    threadStore: threads,
  });
  queue = new InvocationQueue(undefined, { resolveTargets: (...args) => router.resolveSendTargets(...args) });
  const delivery = createPluginConversationDelivery({ messageStore, queue, router });

  service = messagingMod.createMessagingDomain({
    messageStore,
    // Host collaborators at the K-2 assembly point. Ignored by today's domain.
    invokeTrigger: {
      async trigger(threadId, catId, userId, message, messageId) {
        wakeAttempts += 1;
        const failure = wakeFailures.shift();
        if (failure) throw new Error(failure);
        const result = await delivery.trigger(threadId, catId, userId, message, messageId);
        const target =
          queue.list(threadId, userId).find((entry) => entry.messageId === messageId) ??
          queue.list(threadId, userId).at(-1);
        wakes.push({ threadId, catId: target.targets[0], userId, message, messageId });
        return result;
      },
    },
    socketManager: {
      broadcastToRoom(room, event, data) {
        broadcasts.push({ room, event, data });
      },
    },
  });
});

async function issueIngressHandle() {
  for (const participant of participants
    .filter((row) => row.messageCount > 0)
    .sort((a, b) => a.lastMessageAt - b.lastMessageAt)) {
    messageStore.append({
      from: { kind: 'agent', catId: participant.catId },
      userId: 'user-1',
      threadId: THREAD_ID,
      content: 'Existing healthy reply',
      mentions: [],
      timestamp: participant.lastMessageAt,
    });
    threads.updateParticipantActivity(THREAD_ID, participant.catId, true);
  }
  const { handleId } = await service.issueConnectorBindingHandle({
    pluginInstanceId: CTX.pluginInstanceId,
    threadId: THREAD_ID,
    userId: 'user-1',
    scope: { canSend: true, canSubscribe: false },
    connectorId: CONNECTOR_ID,
    externalChatId: EXTERNAL_CHAT_ID,
  });
  return handleId;
}

function ingressDraft(handleId, text, idempotencyKey, originOverride) {
  return {
    address: { kind: 'connector_binding', handle: handleId },
    idempotencyKey,
    sourceEventId: `${CONNECTOR_ID}-evt-${idempotencyKey}`,
    payload: {
      provenance: {
        epistemicStatus: 'user_intent',
        origin: originOverride ?? {
          kind: 'external',
          connectorId: CONNECTOR_ID,
          sourceAddress: { connectorId: CONNECTOR_ID, chatId: EXTERNAL_CHAT_ID, messageId: 'ext-msg-7' },
        },
      },
      elements: [{ elementId: 'el-1', kind: 'text', payload: { text } }],
    },
  };
}

async function admittedTargetsOf(messageId) {
  const stored = await messageStore.getById(messageId);
  assert.ok(stored, 'expected the relayed message to be persisted');
  assert.deepEqual(stored.mentions, []);
  return queue
    .list(THREAD_ID, 'user-1')
    .filter((entry) => entry.messageId === messageId || entry.payload.sourceRecordId === messageId)
    .flatMap((entry) => entry.targets);
}

describe('F202 C1 Core cutover gate — IM ingress wake parity at the Host boundary', () => {
  test('Host plugin surface preserves automatic wake when it supplies message source metadata', async () => {
    const handleId = await issueIngressHandle();
    const draft = ingressDraft(handleId, 'hello from connector', 'host-surface-1');
    const hostOptions = {
      source: { connector: CONNECTOR_ID, label: 'Feishu', icon: 'message', meta: { externalChatId: EXTERNAL_CHAT_ID } },
    };

    const first = await service.sendFromHost(CTX, draft, hostOptions);
    const replay = await service.sendFromHost(CTX, draft, hostOptions);

    assert.equal(replay.messageId, first.messageId);
    assert.deepEqual(await admittedTargetsOf(first.messageId), [DEFAULT_CAT_ID]);
    assert.equal(wakeAttempts, 1, 'the Host surface must wake once despite adding source metadata');
    assert.equal(broadcasts.length, 1);
  });

  test('explicit mention: authenticated ingress with "@opus" wakes opus exactly once', async () => {
    const handleId = await issueIngressHandle();

    const receipt = await service.send(CTX, ingressDraft(handleId, '@opus 请看一下这个 PR', 'ingress-1'));

    assert.deepEqual(
      await admittedTargetsOf(receipt.messageId),
      ['opus'],
      'C1 blocker: the Host messaging domain stamps `mentions: []` for every address kind ' +
        '(send-service.ts:154), so authenticated IM ingress loses the target ConnectorRouter derives.',
    );
    assert.equal(broadcasts.length, 1, 'ingress must broadcast to the thread room exactly once');
    assert.equal(wakes.length, 1, 'ingress must wake the derived cat exactly once');
    assert.equal(wakes[0]?.catId, 'opus');
    assert.equal(wakes[0]?.threadId, THREAD_ID);
    assert.equal(wakes[0]?.messageId, receipt.messageId, 'the wake must carry the persisted message id');
  });

  test('no mention + thread has activity: the most recently active participant wins', async () => {
    // ConnectorRouter.ts:457-459 filters messageCount > 0 FIRST, then sorts by lastMessageAt.
    // 'codex' is both the default cat and the newest timestamp, but has never spoken — so a
    // correct implementation must still route to 'opus'. A fix that only wires the default
    // cat, or that forgets the messageCount filter, lands on 'codex' and fails here.
    participants = [
      { catId: 'opus', lastMessageAt: 2_000, messageCount: 3 },
      { catId: 'codex', lastMessageAt: 3_000, messageCount: 0 },
    ];
    const handleId = await issueIngressHandle();

    const receipt = await service.send(CTX, ingressDraft(handleId, '今天的构建过了吗', 'ingress-2'));

    assert.deepEqual(
      await admittedTargetsOf(receipt.messageId),
      ['opus'],
      "an unmentioned ingress message routes to the thread's most recently ACTIVE participant, " +
        'not to the default cat (ConnectorRouter.ts:455-463).',
    );
    assert.equal(wakes.length, 1, 'it must wake that participant exactly once');
    assert.equal(wakes[0]?.catId, 'opus');
  });

  test('no mention + no activity: only then does it fall back to the default cat', async () => {
    participants = [];
    const handleId = await issueIngressHandle();

    const receipt = await service.send(CTX, ingressDraft(handleId, '今天的构建过了吗', 'ingress-3'));

    assert.deepEqual(
      await admittedTargetsOf(receipt.messageId),
      [DEFAULT_CAT_ID],
      'with no active participant the default cat is the terminal fallback ' +
        '(parseMentions(..., defaultCatId), ConnectorRouter.ts:453).',
    );
    assert.equal(wakes.length, 1, 'the default-cat fallback still wakes exactly once');
    assert.equal(wakes[0]?.catId, DEFAULT_CAT_ID);
  });

  test('no double run: replaying the same ingress idempotencyKey wakes at most once', async () => {
    const handleId = await issueIngressHandle();
    const draft = ingressDraft(handleId, '@opus 再确认一次', 'ingress-4');

    const first = await service.send(CTX, draft);
    const replay = await service.send(CTX, draft);

    assert.equal(replay.messageId, first.messageId, 'INV-1: a settled send replays its receipt');
    assert.equal(wakes.length, 1, 'a replayed ingress send must not wake the cat a second time');
    assert.equal(broadcasts.length, 1, 'a replayed ingress send must not re-broadcast');
  });

  /**
   * Sixth-round review P1. Case 4 only replays a send whose settlement already succeeded, which
   * the settled-receipt early return answers on its own. The window that actually threatens
   * at-most-once is the other one: the ingress effects ran, then settlement failed, so the catch
   * released the claim and the retry re-entered a send that had already woken a cat. Before the
   * fence this produced wakes=2 and broadcasts=2 for one stored message.
   */
  test('a settlement failure must not let the retry wake the cat a second time', async () => {
    const handleId = await issueIngressHandle();
    const ledgerMod = await import('../dist/domains/messaging/ledger.js');
    const settleSend = ledgerMod.MessagingLedger.prototype.settleSend;
    let injected = false;

    ledgerMod.MessagingLedger.prototype.settleSend = async function injectOnce(...args) {
      if (!injected) {
        injected = true;
        throw new Error('injected settlement failure');
      }
      return settleSend.apply(this, args);
    };

    let receipt;
    try {
      await assert.rejects(
        service.send(CTX, ingressDraft(handleId, '@opus hello', 'k-settle-window')),
        /injected settlement failure/,
        'the first attempt must surface the settlement failure rather than swallow it',
      );
      receipt = await service.send(CTX, ingressDraft(handleId, '@opus hello', 'k-settle-window'));
    } finally {
      ledgerMod.MessagingLedger.prototype.settleSend = settleSend;
    }

    assert.equal(wakes.length, 1, 'a retry after a failed settlement must not wake the cat again');
    assert.equal(broadcasts.length, 1, 'a retry after a failed settlement must not re-broadcast');
    assert.equal(wakes[0]?.catId, 'opus', 'the one wake that did happen still targets the derived cat');
    assert.equal(
      wakes[0]?.messageId,
      receipt.messageId,
      'the delivered wake must carry the same message id the retry converged on',
    );
  });

  /**
   * Seventh-round review P1 (sol). The sixth-round fence settled BEFORE the effects ran, on the
   * argument that a duplicated wake costs a whole agent turn. That argument was wrong on a fact
   * this repo already owns: connector-sourced invocations are admitted under the durable
   * idempotency key `connector-${messageId}` (QueueProcessor.ts:4247-4255), so a retry is deduped
   * where it lands rather than spending a second turn. Settling first therefore bought nothing and
   * cost everything: one failed `trigger()` fenced the wake out permanently while the send still
   * returned a success receipt — the message is stored, the API says OK, and no cat ever wakes.
   */
  test('a failed wake must be retried, not fenced out permanently', async () => {
    const handleId = await issueIngressHandle();
    wakeFailures.push('injected wake failure');

    await assert.rejects(
      service.send(CTX, ingressDraft(handleId, '@opus hello', 'k-wake-window')),
      /injected wake failure/,
      'a wake that never happened must not be reported to the caller as a successful send',
    );

    const receipt = await service.send(CTX, ingressDraft(handleId, '@opus hello', 'k-wake-window'));

    assert.equal(wakeAttempts, 2, 'the retry must re-run the wake the first attempt failed to deliver');
    assert.equal(wakes.length, 1, 'exactly one wake survives the retry');
    assert.equal(
      wakes[0]?.messageId,
      receipt.messageId,
      'the delivered wake carries the message id the retry converged on',
    );
    assert.equal(broadcasts.length, 1, 'the broadcast stays at-most-once across the retry');
  });

  test('a wake fence that is rejected or owned elsewhere must fail the send', async () => {
    const handleId = await issueIngressHandle();
    const ledgerMod = await import('../dist/domains/messaging/ledger.js');
    const settle = ledgerMod.MessagingLedger.prototype.settleIngressEffect;
    const claim = ledgerMod.MessagingLedger.prototype.claimIngressEffect;

    // A settle the store refused means the admission was never recorded. Reporting success here
    // would strand the wake: no fence to replay from, and a receipt that says it is done.
    ledgerMod.MessagingLedger.prototype.settleIngressEffect = async function rejectWake(effect, ...rest) {
      if (effect === 'wake') return { status: 'rejected' };
      return settle.apply(this, [effect, ...rest]);
    };
    try {
      await assert.rejects(
        service.send(CTX, ingressDraft(handleId, '@opus one', 'k-fence-rejected')),
        /retry/i,
        'a fence that did not record the admission must not settle as a successful send',
      );
    } finally {
      ledgerMod.MessagingLedger.prototype.settleIngressEffect = settle;
    }

    // `inflight` is a concurrent attempt owning the wake, not proof that it landed.
    ledgerMod.MessagingLedger.prototype.claimIngressEffect = async function ownedWake(effect, ...rest) {
      if (effect === 'wake') return { status: 'inflight' };
      return claim.apply(this, [effect, ...rest]);
    };
    try {
      await assert.rejects(
        service.send(CTX, ingressDraft(handleId, '@opus two', 'k-fence-inflight')),
        /retry/i,
        'a wake owned by a concurrent attempt must not be reported as this send delivering it',
      );
    } finally {
      ledgerMod.MessagingLedger.prototype.claimIngressEffect = claim;
    }
  });

  test('the broadcast fence must never suppress the durable wake', async () => {
    const handleId = await issueIngressHandle();
    const ledgerMod = await import('../dist/domains/messaging/ledger.js');
    const claim = ledgerMod.MessagingLedger.prototype.claimIngressEffect;

    // The socket broadcast is at-most-once on its own terms: a duplicate would double a visible
    // bubble, and a missed one is recovered by any refetch. That trade is its own, and it may
    // never decide whether a cat gets woken.
    ledgerMod.MessagingLedger.prototype.claimIngressEffect = async function ownedBroadcast(effect, ...rest) {
      if (effect === 'broadcast') return { status: 'inflight' };
      return claim.apply(this, [effect, ...rest]);
    };
    let receipt;
    try {
      receipt = await service.send(CTX, ingressDraft(handleId, '@opus hello', 'k-broadcast-owned'));
    } finally {
      ledgerMod.MessagingLedger.prototype.claimIngressEffect = claim;
    }

    assert.equal(broadcasts.length, 0, 'the concurrent owner of the broadcast fence keeps this attempt out');
    assert.equal(wakes.length, 1, 'the wake carries its own fence and is still delivered');
    assert.equal(wakes[0]?.messageId, receipt.messageId, 'the wake targets the message this send stored');
  });

  test('a plain thread_handle plugin send still neither parses @ nor wakes (F288 v0)', async () => {
    participants = [{ catId: 'opus', lastMessageAt: 2_000, messageCount: 3 }];
    const { handleId } = await service.issueThreadHandle({
      pluginInstanceId: CTX.pluginInstanceId,
      threadId: THREAD_ID,
      userId: 'user-1',
      scope: { canSend: true, canSubscribe: true },
    });

    const receipt = await service.send(CTX, {
      address: { kind: 'thread_handle', handle: handleId },
      idempotencyKey: 'plugin-voice-1',
      payload: {
        provenance: { epistemicStatus: 'observation' },
        elements: [{ elementId: 'el-1', kind: 'text', payload: { text: '@opus 这是插件自己说的话' } }],
      },
    });

    assert.deepEqual(
      await admittedTargetsOf(receipt.messageId),
      [],
      'F288 v0: a plugin speaking in its own voice must never gain wake power from its text.',
    );
    assert.equal(wakes.length, 0, 'plugin-voice text must not wake a cat — not even the active participant');
  });

  test('a forged external origin is rejected before any persist, broadcast or wake', async () => {
    const handleId = await issueIngressHandle();

    await assert.rejects(
      service.send(
        CTX,
        ingressDraft(handleId, '@opus 伪造来源', 'forged-1', { kind: 'external', connectorId: 'telegram' }),
      ),
      (error) => error?.code === 'PERMISSION',
      'D-4: ingress authority comes from the host-issued binding, not from the declared origin.',
    );
    assert.equal(wakes.length, 0, 'an unauthenticated ingress claim must never reach the wake route');
    assert.equal(broadcasts.length, 0, 'an unauthenticated ingress claim must never broadcast');
    // Eighth-round review P1: this case has always CLAIMED "before any persist" while only
    // observing wake and broadcast. A forged origin that lands in the message store and then
    // throws would have satisfied it, so the persist half is now observed too.
    assert.equal(messageStore.messages.length, 0, 'a forged external origin must never be persisted');
  });
});
