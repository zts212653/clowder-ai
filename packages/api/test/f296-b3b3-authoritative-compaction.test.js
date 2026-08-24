import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { ContextEpochOwner } = await import('../dist/domains/cats/services/session/ContextEpochOwner.js');
const { InMemoryContextEpochStore } = await import('../dist/domains/cats/services/stores/ports/ContextEpochStore.js');
const { resolveAuthoritativeCompactionSupport } = await import(
  '../dist/domains/cats/services/session/authoritative-compaction.js'
);

const SCOPE = { userId: 'user-1', catId: 'opus', threadId: 'thread-1' };

function capability(provider, carrier, observesCompression) {
  return {
    provider,
    carrier,
    observesCompression,
    reportsRuntimeWindow: false,
    authoritativeUsage: false,
    usageTelemetry: 'unavailable',
    nativeWindowControl: false,
    nativeCompressionControl: false,
    reason: 'fixture',
  };
}

describe('F296 B3b-3: authoritative compaction is an independent epoch edge', () => {
  test('a hook event advances an existing cold scope without inventing resumed', async () => {
    const owner = new ContextEpochOwner(new InMemoryContextEpochStore());
    const before = await owner.resolve({
      ...SCOPE,
      disposition: { state: 'unknown', reason: 'signal_unavailable', evidenceRef: 'launch:unknown' },
    });

    const compacted = await owner.observeCompaction({
      ...SCOPE,
      event: {
        eventId: 'context-compaction:session-1:1',
        runtimeSessionId: 'runtime-1',
        evidenceRef: 'claude-precompact:session-1:1',
      },
    });

    assert.equal(compacted.contextEpoch, before.contextEpoch + 1);
    assert.equal(compacted.contextMode, 'cold');
    assert.equal(compacted.transition, 'context_compacted');
    assert.equal(compacted.replayed, false);
  });

  test('the hook/stream replay holds the epoch and stays cold', async () => {
    const owner = new ContextEpochOwner(new InMemoryContextEpochStore());
    await owner.resolve({
      ...SCOPE,
      disposition: { state: 'unknown', reason: 'signal_unavailable', evidenceRef: 'launch:unknown' },
    });
    const event = {
      eventId: 'context-compaction:session-1:1',
      runtimeSessionId: 'runtime-1',
      evidenceRef: 'claude-precompact:session-1:1',
    };
    const first = await owner.observeCompaction({ ...SCOPE, event });
    const replay = await owner.observeCompaction({
      ...SCOPE,
      event: { ...event, evidenceRef: 'claude-compact-boundary:session-1:1' },
    });

    assert.equal(replay.contextEpoch, first.contextEpoch, 'one provider event cannot advance twice');
    assert.equal(replay.contextMode, 'cold', 'dedupe must not turn a compacted runtime hot');
    assert.equal(replay.transition, 'context_compaction_replay');
    assert.equal(replay.replayed, true);
  });

  test('a typed event for a different bound runtime is rejected', async () => {
    const owner = new ContextEpochOwner(new InMemoryContextEpochStore());
    await owner.resolve({
      ...SCOPE,
      disposition: {
        state: 'fresh',
        reason: 'no_prior_session',
        evidenceRef: 'launch:fresh',
        runtimeSessionId: 'runtime-a',
      },
    });

    await assert.rejects(
      owner.observeCompaction({
        ...SCOPE,
        event: {
          eventId: 'context-compaction:session-2:1',
          runtimeSessionId: 'runtime-b',
          evidenceRef: 'claude-precompact:session-2:1',
        },
      }),
      /context_compaction_binding_mismatch/,
    );
  });
});

describe('F296 B3b-3: declaration and routable event are separate capabilities', () => {
  test('Claude print accepts its typed stream boundary and authenticated hook', () => {
    const print = capability('anthropic', 'print_sdk', true);
    assert.equal(
      resolveAuthoritativeCompactionSupport({ capability: print, eventSource: 'claude_compact_boundary' }).status,
      'supported',
    );
    assert.equal(
      resolveAuthoritativeCompactionSupport({ capability: print, eventSource: 'claude_precompact_hook' }).status,
      'supported',
    );
  });

  test('every other production carrier stays unsupported, including observesCompression declarations', () => {
    for (const candidate of [
      capability('openai', 'exec_json', true),
      capability('openai', 'app_server', false),
      capability('google', 'gemini_cli', true),
      capability('google', 'antigravity', false),
      capability('kimi', 'stream_json', true),
      capability('opencode', 'run_json', false),
      capability('antigravity', 'cdp_bridge', false),
      capability('catagent', 'direct_api', false),
      capability('a2a', 'a2a', false),
      capability('acp', 'acp', false),
      capability('kimi', 'acp', false),
      capability('opencode', 'acp', false),
    ]) {
      const result = resolveAuthoritativeCompactionSupport({
        capability: candidate,
        eventSource: 'claude_compact_boundary',
      });
      assert.equal(result.status, 'unsupported');
      assert.equal(result.reason, 'typed_event_unroutable');
    }
  });

  test('Claude bg/PTY hook remains unsupported until carrier-parity evidence exists', () => {
    for (const candidate of [capability('anthropic', 'bg', true), capability('anthropic', 'interactive_pty', false)]) {
      const result = resolveAuthoritativeCompactionSupport({
        capability: candidate,
        eventSource: 'claude_precompact_hook',
      });
      assert.equal(result.status, 'unsupported');
      assert.equal(result.reason, 'carrier_event_delivery_unproven');
    }
  });
});
