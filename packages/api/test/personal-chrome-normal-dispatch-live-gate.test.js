import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  NormalDispatchLiveGateError,
  runPersonalChromeNormalDispatchLiveGate,
} from '../scripts/f247-normal-dispatch-live-gate.mjs';

const source = { id: 'source-1', threadId: 'thread-1', catId: 'codex-sol', content: '@gpt-pro inspect' };

function receipt(overrides = {}) {
  return {
    id: 'receipt-1',
    threadId: 'thread-1',
    catId: null,
    replyTo: source.id,
    content: 'cloud bridge status',
    source: {
      connector: 'cloud-bridge-status',
      meta: {
        cloudBridgeOutboundReceipt: {
          v: 1,
          sourceMessageId: source.id,
          sourceSender: { kind: 'cat', id: 'codex-sol' },
          dispatchInvocationId: 'dispatch-1',
          targetCatId: 'gpt-pro',
          status: 'sent',
          transport: 'host',
          hostMessageId: 'host-message-1',
          idempotency: { keyKind: 'source_message_id', disposition: 'fresh' },
          ...overrides,
        },
      },
    },
  };
}

describe('F247 managed normal-dispatch live gate', () => {
  it('waits for a host-observed receipt and exact source-bound gpt-pro return', async () => {
    const snapshots = [
      [source],
      [source, receipt()],
      [source, receipt(), { id: 'reply-1', threadId: 'thread-1', catId: 'gpt-pro', replyTo: source.id }],
    ];
    const result = await runPersonalChromeNormalDispatchLiveGate({
      sourceMessageId: source.id,
      readMessages: async () => snapshots.shift() ?? snapshots.at(-1),
      wait: async () => undefined,
      timeoutMs: 100,
    });

    assert.deepEqual(result, {
      status: 'PASS',
      sourceMessageId: source.id,
      targetCatId: 'gpt-pro',
      hostMessageId: 'host-message-1',
      returnMessageId: 'reply-1',
    });
  });

  it('never treats unknown, routed, or source-substituted state as PASS', async () => {
    for (const messages of [
      [source, receipt({ status: 'unknown', hostMessageId: undefined })],
      [source, { id: 'routed-1', threadId: 'thread-1', catId: null, replyTo: source.id, content: 'routed' }],
      [source, receipt(), { id: 'reply-wrong', threadId: 'thread-1', catId: 'gpt-pro', replyTo: 'different-source' }],
    ]) {
      await assert.rejects(
        runPersonalChromeNormalDispatchLiveGate({
          sourceMessageId: source.id,
          readMessages: async () => messages,
          wait: async () => undefined,
          timeoutMs: 0,
        }),
        (error) => error instanceof NormalDispatchLiveGateError && error.code !== 'PASS',
      );
    }
  });

  it('returns the bounded text-free fingerprint and exact next action on terminal failure', async () => {
    const failure = {
      v: 1,
      errorCode: 'COMPOSER_DOM_UNSUPPORTED',
      nextAction: 'inspect_bound_tab',
      fingerprint: {
        v: 1,
        phase: 'before_submit',
        adapterRevision: '2026-08-27.1',
        artifactRevision: '0.2.5',
        firstUnsupportedPath: 'composer/p[0]/mark[0]',
        nodes: [{ path: 'composer', kind: 'element', tag: 'DIV', childCount: 1 }],
        truncated: false,
      },
    };
    await assert.rejects(
      runPersonalChromeNormalDispatchLiveGate({
        sourceMessageId: source.id,
        readMessages: async () => [source, receipt({ status: 'unknown', hostMessageId: undefined, failure })],
        wait: async () => undefined,
        timeoutMs: 100,
      }),
      (error) => {
        assert.equal(error.code, 'DELIVERY_NOT_OBSERVED');
        assert.deepEqual(error.diagnostic, failure);
        assert.equal(JSON.stringify(error).includes('@gpt-pro inspect'), false);
        return true;
      },
    );
  });
});
