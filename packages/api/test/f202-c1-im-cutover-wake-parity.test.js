/**
 * F202 Train C1 — Core cutover gate: IM ingress wake parity at the Host boundary.
 *
 * WHERE THE GAP IS (trust boundary, not SDK semantics):
 * Mention parsing and cat wake are Host authority, never plugin-text authority.
 * F288 freezes that for v0: "插件消息不解析/不触发 @ 路由（唤醒能力归 K-3a wake route）"
 * (docs/features/F288-plugin-messaging-domain.md). A plugin speaking in its own
 * voice through `thread_handle` must therefore never gain wake power from its text.
 *
 * External IM ingress is a different address kind with a different authority:
 * `connector_binding` carries a host-issued binding whose `connectorId`/`externalChatId`
 * the Host verifies (D-4, send-service.ts:58-77). For that authenticated ingress the
 * Host — not the plugin — derives the target and wakes it. ConnectorRouter does exactly
 * that today (ConnectorRouter.ts:451-495), and its routing is THREE-way, not two-way:
 *   1. an explicit @-mention wins;
 *   2. otherwise the thread's most recently active participant (messageCount > 0) wins;
 *   3. only a thread with no such activity falls back to the default cat.
 * Collapsing 2 into 3 is itself a user-visible regression, so all three are asserted.
 *
 * The Host messaging domain has no equivalent: SendService stamps `mentions: []` for
 * EVERY address kind (send-service.ts:154) and the domain owns no broadcast/wake/thread
 * collaborator at all (MessagingDomainDeps, messaging-service.ts:21-26). So migrating the
 * seven IM providers onto the public SDK — which Train C1 briefs — silently removes
 * @-mention wake from every IM channel, and the roadmap's §6.3 Phase 1 exit evidence
 * (three entries sharing ledger, broadcast, WAKE and source derivation) is not met.
 *
 * WHAT THIS TEST BINDS, AND WHAT IT DELIBERATELY DOES NOT:
 * It drives the K-2 composition seam `createMessagingDomain(...)` — the assembly point
 * F288 already names as the Host Broker's — and injects the Host collaborators there,
 * reusing ConnectorRouter's existing vocabulary (`invokeTrigger`, `socketManager`,
 * `threadStore.getParticipantsWithActivity`) rather than minting new concepts. Binding
 * the seam to the domain's assembly point IS a deliberate architecture choice and is
 * stated as such. Internal placement is left free: SendService, a MessageIngress
 * wrapper, or a dedicated admission service all satisfy these assertions equally.
 * No new plugin-facing public method/hook/UI slot is implied — that would be C2.
 *
 * STATUS on the C1 merge base (Core 9ab0eaf28): 4 RED (cases 1-4) / 2 GREEN (cases 5-6).
 * The GREEN guards must stay green: they are what stops the wrong-layer fix of parsing
 * `@` inside the plugin-voice path.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

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
const THREAD_ID = 'thread-1';
/** Deliberately distinct from the most-active participant so case 2 cannot pass by accident. */
const DEFAULT_CAT_ID = 'codex';

beforeEach(async () => {
  messagingMod = await import('../dist/domains/messaging/messaging-service.js');
  ({ MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js'));

  messageStore = new MessageStore();
  wakes = [];
  broadcasts = [];
  participants = [];
  wakeAttempts = 0;
  wakeFailures = [];

  service = messagingMod.createMessagingDomain({
    messageStore,
    // Host collaborators at the K-2 assembly point. Ignored by today's domain.
    invokeTrigger: {
      async trigger(threadId, catId, userId, message, messageId) {
        wakeAttempts += 1;
        const failure = wakeFailures.shift();
        if (failure) throw new Error(failure);
        wakes.push({ threadId, catId, userId, message, messageId });
        return 'dispatched';
      },
    },
    socketManager: {
      broadcastToRoom(room, event, data) {
        broadcasts.push({ room, event, data });
      },
    },
    threadStore: {
      async getParticipantsWithActivity() {
        return participants;
      },
    },
    getDefaultCatId: () => DEFAULT_CAT_ID,
    getMentionPatterns: () => new Map([['opus', ['@opus', '@宪宪']]]),
  });
});

async function issueIngressHandle() {
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

async function mentionsOf(messageId) {
  const stored = await messageStore.getById(messageId);
  assert.ok(stored, 'expected the relayed message to be persisted');
  return [...(stored.mentions ?? [])];
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
    assert.deepEqual(await mentionsOf(first.messageId), [DEFAULT_CAT_ID]);
    assert.equal(wakeAttempts, 1, 'the Host surface must wake once despite adding source metadata');
    assert.equal(broadcasts.length, 1);
  });

  test('1/RED — explicit mention: authenticated ingress with "@opus" wakes opus exactly once', async () => {
    const handleId = await issueIngressHandle();

    const receipt = await service.send(CTX, ingressDraft(handleId, '@opus 请看一下这个 PR', 'ingress-1'));

    assert.deepEqual(
      await mentionsOf(receipt.messageId),
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

  test('2/RED — no mention + thread has activity: the most recently active participant wins', async () => {
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
      await mentionsOf(receipt.messageId),
      ['opus'],
      "an unmentioned ingress message routes to the thread's most recently ACTIVE participant, " +
        'not to the default cat (ConnectorRouter.ts:455-463).',
    );
    assert.equal(wakes.length, 1, 'it must wake that participant exactly once');
    assert.equal(wakes[0]?.catId, 'opus');
  });

  test('3/RED — no mention + no activity: only then does it fall back to the default cat', async () => {
    participants = [];
    const handleId = await issueIngressHandle();

    const receipt = await service.send(CTX, ingressDraft(handleId, '今天的构建过了吗', 'ingress-3'));

    assert.deepEqual(
      await mentionsOf(receipt.messageId),
      [DEFAULT_CAT_ID],
      'with no active participant the default cat is the terminal fallback ' +
        '(parseMentions(..., defaultCatId), ConnectorRouter.ts:453).',
    );
    assert.equal(wakes.length, 1, 'the default-cat fallback still wakes exactly once');
    assert.equal(wakes[0]?.catId, DEFAULT_CAT_ID);
  });

  test('4/RED — no double run: replaying the same ingress idempotencyKey wakes at most once', async () => {
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
  test('4b/RED — a settlement failure must not let the retry wake the cat a second time', async () => {
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
  test('4c/RED — a failed wake must be retried, not fenced out permanently', async () => {
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

  test('4d/RED — a wake fence that is rejected or owned elsewhere must fail the send', async () => {
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

  test('4e/RED — the broadcast fence must never suppress the durable wake', async () => {
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

  test('5/GREEN guard — a plain thread_handle plugin send still neither parses @ nor wakes (F288 v0)', async () => {
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
      await mentionsOf(receipt.messageId),
      [],
      'F288 v0: a plugin speaking in its own voice must never gain wake power from its text.',
    );
    assert.equal(wakes.length, 0, 'plugin-voice text must not wake a cat — not even the active participant');
  });

  test('6/GREEN guard — a forged external origin is rejected before any persist, broadcast or wake', async () => {
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
