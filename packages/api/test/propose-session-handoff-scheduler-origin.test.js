import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildCtx } from './propose-session-handoff-route-fixtures.js';

describe('propose-session-handoff route (F225 ②a)', () => {
  // ── F167: the scheduler-origin path the catalog gate exists for ──────────────────────
  //
  // approval-ingress.test.js proves validateOrigin DECIDES correctly given a producerId
  // and an origin row, but every case there synthesises the draft directly. None of them
  // reaches the premise the design rests on: that THIS route derives threadId, messageId
  // and ownerUserId from the authenticated InvocationRecord, which is the only reason a
  // system pseudo-user row is safe to accept as an origin at all.
  //
  // `systemOriginExemption: 'server_attested'` is a hand-written DECLARATION. `required`
  // stops an omission; it cannot stop a wrong one. So these cases test the BINDING.
  // (maintainer gate 2 + @codex-luna P2 on PR #1349; tracked as #1350)
  //
  // Companion file: approval-hub/scheduler-origin-callback-integration.test.js walks the
  // same wake row ACROSS producers (F128/F193/F231/F260 accept, F221 forbidden rejects).
  // This block goes deep on the F225 route instead — the body-override case below is the
  // one assertion neither that matrix nor the ingress unit suite makes. Neither file is
  // redundant; delete either and a distinct failure mode stops being covered.
  describe('scheduler-woken origin (F167)', () => {
    async function proposeWithOrigin(ctx, { author, payload, threadId = 'thread_1' } = {}) {
      const origin = await ctx.messageStore.append({
        ...author,
        content: '⏰ 定时唤醒：持球检查 CI',
        mentions: [],
        timestamp: Date.now(),
        threadId,
      });
      // 7th arg is originTriggerMessageId: the EXACT turn origin, record-side only.
      const auth = await ctx.registry.create('user_1', 'opus', 'thread_1', undefined, undefined, undefined, origin.id);
      const response = await ctx.app.inject({
        method: 'POST',
        url: '/api/callbacks/propose-session-handoff',
        headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
        payload: payload ?? { done: 'held the ball through CI', nextSteps: 'read the verdict' },
      });
      return { origin, response };
    }

    // The reported defect (#1348): for any long-running session the message that triggered
    // the invocation IS the scheduler wake row, so this was the one handoff that could never
    // be proposed — 500 with no actionable text, while the same call from an A2A turn worked.
    it('accepts a handoff anchored to the scheduler wake row', async () => {
      const ctx = await buildCtx();
      const { origin, response } = await proposeWithOrigin(ctx, { author: { userId: 'scheduler', catId: null } });

      assert.equal(response.statusCode, 200, 'scheduler-woken handoff is no longer rejected as a cross-tenant origin');
      const stored = await ctx.handoffStore.get(response.json().proposalId);
      assert.equal(stored.status, 'pending');
      assert.deepEqual(
        stored.publication.envelope.originRef,
        { kind: 'message', threadId: 'thread_1', messageId: origin.id },
        'origin stays anchored to the exact scheduler wake row',
      );
      assert.equal(stored.publication.envelope.ownerUserId, 'user_1', 'owner is the record user, not the pseudo-user');
    });

    it('also accepts the historical catId:"system" wake shape', async () => {
      const ctx = await buildCtx();
      const { response } = await proposeWithOrigin(ctx, { author: { userId: 'system', catId: 'system' } });
      assert.equal(response.statusCode, 200, 'both persisted system shapes are accepted (visibility.ts predicate)');
    });

    // The assertion that actually distinguishes a bound route from an unbound one. A status
    // code cannot: a route that ignores these fields and a route that validates them both
    // answer 200. Only the persisted originRef separates them.
    it('the origin is record-derived — a body naming another thread/message/owner cannot move it', async () => {
      const ctx = await buildCtx();
      const foreign = await ctx.messageStore.append({
        userId: 'user_2',
        catId: null,
        content: 'another tenant thread',
        mentions: [],
        timestamp: Date.now(),
        threadId: 'thread_foreign',
      });
      const { origin, response } = await proposeWithOrigin(ctx, {
        author: { userId: 'scheduler', catId: null },
        payload: {
          done: 'held the ball through CI',
          nextSteps: 'read the verdict',
          // None of these are inputs to the origin. If any ever becomes one, this test fails.
          threadId: 'thread_foreign',
          sourceThreadId: 'thread_foreign',
          messageId: foreign.id,
          sourceMessageId: foreign.id,
          userId: 'user_2',
          ownerUserId: 'user_2',
        },
      });

      assert.equal(response.statusCode, 200);
      const envelope = (await ctx.handoffStore.get(response.json().proposalId)).publication.envelope;
      assert.deepEqual(
        envelope.originRef,
        { kind: 'message', threadId: 'thread_1', messageId: origin.id },
        'body-supplied thread/message are ignored; originRef is derived from the InvocationRecord',
      );
      assert.equal(envelope.ownerUserId, 'user_1', 'body-supplied owner cannot reassign the proposal');
    });

    // The exemption widens WHO may author a row inside an already-bound thread. It must not
    // widen it to another human: cross-tenant isolation has to survive end to end, not just
    // in the ingress unit case.
    it('still rejects a foreign human origin in the same thread', async () => {
      const ctx = await buildCtx();
      const { response } = await proposeWithOrigin(ctx, { author: { userId: 'user_2', catId: null } });

      assert.equal(response.statusCode, 500, 'a non-system foreign author is still a cross-tenant origin');
      assert.match(
        response.json().message ?? '',
        /Approval origin message owner mismatch/,
        'fails for the tenancy reason, not some unrelated 500',
      );
    });

    // A system userId worn by a cat-authored row must not reach the exemption. Asserting the
    // reason matters here too: this input is one typo in the predicate away from passing.
    it('still rejects a system userId carried by a cat-authored row', async () => {
      const ctx = await buildCtx();
      const { response } = await proposeWithOrigin(ctx, { author: { userId: 'scheduler', catId: 'opus' } });

      assert.equal(
        response.statusCode,
        500,
        'isSystemUserMessage requires BOTH a system userId and a system/null catId',
      );
      assert.match(response.json().message ?? '', /Approval origin message owner mismatch/);
    });
  });
});
