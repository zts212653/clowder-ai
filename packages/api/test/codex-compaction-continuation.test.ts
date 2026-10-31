import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CODEX_ACTIVE_WORK_CONTEXT_DECISION,
  CODEX_COMPACTION_CONTINUATION_TRIGGER,
  codexActiveWorkContext,
  continueCodexWorkAfterCompaction,
  isCodexCompactionContinuation,
} from '../src/domains/cats/services/agents/providers/codex-active-work-context.js';
import type { PreparedProviderRequestV1 } from '../src/domains/cats/services/types.js';

function prepare(): PreparedProviderRequestV1 {
  const context = codexActiveWorkContext({
    threadId: 'cafe-thread',
    invocationId: 'cafe-invocation',
    promptMessageIds: ['source'],
  });
  assert.ok(context);
  return {
    v: 1,
    boundaryReason: 'provider_continuation',
    message: { body: CODEX_COMPACTION_CONTINUATION_TRIGGER, injectionDecision: CODEX_ACTIVE_WORK_CONTEXT_DECISION },
    nativeInstructions: [context],
    runtime: { provider: 'openai', carrier: 'app_server' },
    tools: { finalSurface: 'unknown' },
    providerNativeVisibility: 'unknown',
  };
}

const native = { threadId: 'native-thread', turnId: 'native-turn' };

test('cancellation, including during durable recording, prevents the continuation RPC', async () => {
  for (const timing of ['before', 'during'] as const) {
    const controller = new AbortController();
    if (timing === 'before') controller.abort();
    let recorded = 0;
    let sent = 0;
    await assert.rejects(
      continueCodexWorkAfterCompaction({
        ...native,
        signal: controller.signal,
        prepare,
        commit: async () => {
          recorded++;
          controller.abort();
        },
        request: async () => {
          sent++;
          return { turnId: native.turnId };
        },
      }),
      { name: 'AbortError' },
    );
    assert.equal(recorded, timing === 'before' ? 0 : 1);
    assert.equal(sent, 0);
  }
});

test('a failed exact-request record prevents any unrecorded provider input', async () => {
  let sent = 0;
  await assert.rejects(
    continueCodexWorkAfterCompaction({
      ...native,
      prepare,
      commit: async () => {
        throw new Error('durable recorder unavailable');
      },
      request: async () => {
        sent++;
        return { turnId: native.turnId };
      },
    }),
    /durable recorder unavailable/,
  );
  assert.equal(sent, 0);
});

test('missing or malformed sources do not become an invented task or a nudge exemption', async () => {
  assert.equal(codexActiveWorkContext(undefined), undefined);
  assert.equal(codexActiveWorkContext({ threadId: 't', invocationId: 'i', promptMessageIds: [] }), undefined);
  let sent = 0;
  await continueCodexWorkAfterCompaction({
    ...native,
    prepare: () => undefined,
    request: async () => {
      sent++;
      return { turnId: native.turnId };
    },
  });
  assert.equal(sent, 0);
  for (const request of [
    { ...prepare(), nativeInstructions: [] },
    { ...prepare(), boundaryReason: 'provider_fallback' as const },
    { ...prepare(), message: { body: 'a different user request' } },
    { ...prepare(), runtime: { provider: 'anthropic', carrier: 'claude_cli' } },
  ]) {
    assert.equal(isCodexCompactionContinuation(request), false);
    await assert.rejects(
      continueCodexWorkAfterCompaction({
        ...native,
        prepare: () => request,
        request: async () => {
          sent++;
          return { turnId: native.turnId };
        },
      }),
      /codex_compaction_context_not_exact/,
    );
  }
  assert.equal(sent, 0);
});

test('a rejected or mismatched steer never replays the task in a new native turn', async () => {
  for (const outcome of ['rejected', 'mismatched'] as const) {
    const methods: string[] = [];
    await assert.rejects(
      continueCodexWorkAfterCompaction({
        ...native,
        prepare,
        request: async (method) => {
          methods.push(method);
          if (outcome === 'rejected') throw new Error('Turn is no longer active');
          return { turnId: 'another-turn' };
        },
      }),
      outcome === 'rejected' ? /no longer active/ : /turn_mismatch/,
    );
    assert.deepEqual(methods, ['turn/steer']);
  }
});
