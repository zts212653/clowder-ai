import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  captureAppendedPawFeelMessage,
  capturePawFeelSourceMessage,
  PawFeelCaptureIntentSidecar,
} from '../../dist/infrastructure/harness-eval/paw-feel-disposition/hot-intake.js';

function message(overrides = {}) {
  return {
    id: 'message-live',
    threadId: 'thread-source',
    userId: 'user-1',
    catId: 'codex-sol',
    content: '[爪感差: cat_cafe_hold_ball+new report was not visible]',
    mentions: [],
    timestamp: Date.parse('2026-07-27T12:00:00.000Z'),
    ...overrides,
  };
}

describe('F278 typed paw-feel capture', () => {
  it('captures an authenticated reporter message as confirmed without copying its body', async () => {
    const calls = [];
    const result = await capturePawFeelSourceMessage({ kind: 'cat', id: 'codex-sol' }, message(), {
      async discover(candidate, options) {
        calls.push({ candidate, options });
        return { outcome: 'appended', projection: { signalId: candidate.signalId } };
      },
    });

    assert.equal(result.kind, 'canonical');
    assert.equal(result.discoveredSignals, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].candidate.sourceMessageId, 'message-live');
    assert.deepEqual(calls[0].options, {
      backfilled: false,
      captureMethod: 'typed',
      captureAssessment: 'confirmed',
    });
    assert.equal('marker' in calls[0].options, false);
  });

  it('rejects capture of another cat, user prose, placeholders, and cross-post copies', async () => {
    let discoveries = 0;
    const service = {
      async discover() {
        discoveries += 1;
        return { outcome: 'appended' };
      },
    };

    await assert.rejects(capturePawFeelSourceMessage({ kind: 'cat', id: 'opus' }, message(), service), /source cat/i);
    await assert.rejects(
      capturePawFeelSourceMessage({ kind: 'cat', id: 'codex-sol' }, message({ catId: null }), service),
      /cat-authored/i,
    );
    const placeholder = await capturePawFeelSourceMessage(
      { kind: 'cat', id: 'codex-sol' },
      message({ content: '[爪感差: 工具+现象]' }),
      service,
    );
    const copy = await capturePawFeelSourceMessage(
      { kind: 'cat', id: 'codex-sol' },
      message({
        threadId: 'thread-copy',
        extra: { crossPost: { sourceThreadId: 'thread-origin' } },
      }),
      service,
    );

    assert.equal(placeholder.kind, 'ignored');
    assert.equal(copy.kind, 'cross_post_copy');
    assert.equal(discoveries, 0);
  });

  it('keeps a standalone agent-key report visible through bounded ambiguous compatibility intake', async () => {
    const calls = [];
    const dispositionService = {
      async discover(candidate, options) {
        calls.push({ candidate, options });
        return { outcome: 'appended', projection: { signalId: candidate.signalId } };
      },
    };
    const sidecar = new PawFeelCaptureIntentSidecar({
      dispositionService,
    });
    const result = await captureAppendedPawFeelMessage(message(), sidecar, dispositionService);

    assert.equal(result.kind, 'compatible');
    assert.equal(result.discoveredSignals, 1);
    assert.equal(calls.length, 1);
    assert.deepEqual(
      calls[0].options,
      {
        backfilled: false,
        captureMethod: 'legacy_parser',
        captureAssessment: 'ambiguous',
      },
      'no invocation proof must never be upgraded to confirmed',
    );
  });

  it('does not let bounded compatibility collect inline, fenced, quoted, or cross-post examples', async () => {
    let discoveries = 0;
    const dispositionService = {
      async discover() {
        discoveries += 1;
        return { outcome: 'appended' };
      },
    };
    const sidecar = new PawFeelCaptureIntentSidecar({ dispositionService });
    const marker = '[爪感差: rg+copied example]';

    for (const content of [`inline \`${marker}\``, `\`\`\`\n${marker}\n\`\`\``, `> ${marker}`]) {
      const result = await captureAppendedPawFeelMessage(message({ content }), sidecar, dispositionService);
      assert.equal(result.kind, 'ignored');
    }
    const copied = await captureAppendedPawFeelMessage(
      message({ extra: { crossPost: { sourceThreadId: 'thread-origin' } } }),
      sidecar,
      dispositionService,
    );
    assert.equal(copied.kind, 'cross_post_copy');
    assert.equal(discoveries, 0);
  });

  it('binds one declared invocation intent to its persisted final message without a second call', async () => {
    const discoveries = [];
    const sidecar = new PawFeelCaptureIntentSidecar({
      dispositionService: {
        async discover(candidate, options) {
          discoveries.push({ candidate, options });
          return { outcome: 'appended', projection: { signalId: candidate.signalId } };
        },
      },
    });
    sidecar.declare({
      kind: 'invocation',
      invocationId: 'inv-final',
      threadId: 'thread-source',
      userId: 'user-1',
      catId: 'codex-sol',
    });

    const result = await sidecar.capturePersistedMessage(
      message({
        id: 'message-generated-by-store',
        origin: 'stream',
        extra: { stream: { invocationId: 'inv-parent', turnInvocationId: 'inv-final' } },
      }),
    );

    assert.deepEqual(result, {
      kind: 'captured',
      invocationId: 'inv-final',
      sourceMessageId: 'message-generated-by-store',
      discoveredSignals: 1,
    });
    assert.equal(discoveries.length, 1);
    assert.equal(discoveries[0].candidate.sourceMessageId, 'message-generated-by-store');
    assert.equal(discoveries[0].options.captureMethod, 'typed');
    assert.equal(discoveries[0].options.captureAssessment, 'confirmed');
  });

  it('does not confirm an instructional inline marker beside the intentional standalone report', async () => {
    const candidates = [];
    const sidecar = new PawFeelCaptureIntentSidecar({
      dispositionService: {
        async discover(candidate) {
          candidates.push(candidate);
          return { outcome: 'appended', projection: { signalId: candidate.signalId } };
        },
      },
    });
    sidecar.declare({
      kind: 'invocation',
      invocationId: 'inv-mixed',
      threadId: 'thread-source',
      userId: 'user-1',
      catId: 'codex-sol',
    });
    const raw = '[爪感差: rg+same bytes]';
    const result = await sidecar.capturePersistedMessage(
      message({
        origin: 'stream',
        content: `示例 \`${raw}\`\n\n${raw}`,
        extra: { stream: { turnInvocationId: 'inv-mixed' } },
      }),
    );

    assert.equal(result.kind, 'captured');
    assert.equal(result.discoveredSignals, 1);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].sameDigestOrdinal, 1);
  });

  it('prefers typed capture and keeps typed plus compatibility replay exactly once by signal identity', async () => {
    const events = new Map();
    const dispositionService = {
      async discover(candidate, options) {
        const existing = events.get(candidate.signalId);
        if (existing) return { outcome: 'duplicate', projection: existing };
        const projection = { signalId: candidate.signalId, ...options };
        events.set(candidate.signalId, projection);
        return { outcome: 'appended', projection };
      },
    };
    const sidecar = new PawFeelCaptureIntentSidecar({ dispositionService });
    sidecar.declare({
      kind: 'invocation',
      invocationId: 'inv-replay',
      threadId: 'thread-source',
      userId: 'user-1',
      catId: 'codex-sol',
    });
    const persisted = message({
      origin: 'stream',
      extra: { stream: { turnInvocationId: 'inv-replay' } },
    });

    const typed = await captureAppendedPawFeelMessage(persisted, sidecar, dispositionService);
    const replay = await captureAppendedPawFeelMessage(persisted, sidecar, dispositionService);

    assert.equal(typed.kind, 'captured');
    assert.equal(replay.kind, 'compatible');
    assert.equal(events.size, 1);
    assert.equal([...events.values()][0].captureAssessment, 'confirmed');
  });

  it('does not bind an intent to callback chatter, another cat/thread, or a marker-free stream message', async () => {
    let discoveries = 0;
    const sidecar = new PawFeelCaptureIntentSidecar({
      dispositionService: {
        async discover() {
          discoveries += 1;
          return { outcome: 'appended' };
        },
      },
    });
    const principal = {
      kind: 'invocation',
      invocationId: 'inv-final',
      threadId: 'thread-source',
      userId: 'user-1',
      catId: 'codex-sol',
    };
    sidecar.declare(principal);
    const invocationExtra = {
      stream: { invocationId: 'inv-parent', turnInvocationId: 'inv-final' },
    };

    assert.equal(
      (await sidecar.capturePersistedMessage(message({ origin: 'callback', extra: invocationExtra }))).kind,
      'ignored',
    );
    assert.equal(
      (await sidecar.capturePersistedMessage(message({ catId: 'opus', origin: 'stream', extra: invocationExtra })))
        .kind,
      'ignored',
    );
    assert.equal(
      (
        await sidecar.capturePersistedMessage(
          message({ threadId: 'other-thread', origin: 'stream', extra: invocationExtra }),
        )
      ).kind,
      'ignored',
    );
    assert.equal(
      (
        await sidecar.capturePersistedMessage(
          message({ content: 'normal final without a report', origin: 'stream', extra: invocationExtra }),
        )
      ).kind,
      'ignored',
    );
    assert.equal(discoveries, 0);

    const captured = await sidecar.capturePersistedMessage(
      message({ id: 'actual-final', origin: 'stream', extra: invocationExtra }),
    );
    assert.equal(captured.kind, 'captured', 'non-matching messages must leave the intent available');
    assert.equal(discoveries, 1);
  });

  it('expires pending intent and captures the matching persisted message at most once', async () => {
    let now = 1_000;
    let discoveries = 0;
    const sidecar = new PawFeelCaptureIntentSidecar({
      ttlMs: 50,
      now: () => now,
      dispositionService: {
        async discover() {
          discoveries += 1;
          return { outcome: 'appended' };
        },
      },
    });
    const principal = {
      kind: 'invocation',
      invocationId: 'inv-expired',
      threadId: 'thread-source',
      userId: 'user-1',
      catId: 'codex-sol',
    };
    const extra = { stream: { turnInvocationId: principal.invocationId } };
    sidecar.declare(principal);
    now += 51;
    assert.equal((await sidecar.capturePersistedMessage(message({ origin: 'stream', extra }))).kind, 'ignored');

    const active = { ...principal, invocationId: 'inv-once' };
    const activeExtra = { stream: { turnInvocationId: active.invocationId } };
    sidecar.declare(active);
    const first = await sidecar.capturePersistedMessage(message({ origin: 'stream', extra: activeExtra }));
    const replay = await sidecar.capturePersistedMessage(message({ origin: 'stream', extra: activeExtra }));
    assert.equal(first.kind, 'captured');
    assert.equal(replay.kind, 'ignored');
    assert.equal(discoveries, 1);
  });
});
