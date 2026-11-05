import assert from 'node:assert/strict';
import { test } from 'node:test';
import { textDigest } from '../../src/infrastructure/harness-eval/watcher-offline/protocol.js';
import { runWatcherCase, type WatcherCall } from '../../src/infrastructure/harness-eval/watcher-offline/run-case.js';

const fixture = () => ({
  v: 1,
  id: 'private-label',
  group: 'quiet',
  cutoffAt: '2026-10-22T10:00:00Z',
  lastVisibleSourceRef: 'message:a',
  goal: 'Finish the current task.',
  observations: [
    {
      sourceRef: 'message:a',
      occurredAt: '2026-10-22T09:59:00Z',
      text: 'Current evidence',
      sha256: textDigest('Current evidence'),
    },
  ],
  sources: [
    {
      id: 'old',
      title: 'Earlier work',
      sourceRef: 'message:old',
      revision: 'r1',
      availableAt: '2026-10-20T10:00:00Z',
      text: 'PRIVATE SOURCE BODY',
      sha256: textDigest('PRIVATE SOURCE BODY'),
    },
  ],
});
const reply = (value: unknown, success = true): WatcherCall => ({
  success,
  text: JSON.stringify(value),
  elapsedMs: 10,
  requestedModel: 'test-model',
  servedModel: 'test-model',
  usage: [
    {
      provider: 'openai',
      inputTotal: 100,
      inputNew: 50,
      cacheRead: 50,
      cacheWrite: null,
      output: 10,
      reportedCostUsd: null,
      native: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 10 },
    },
  ],
});

test('the model selects a permitted source and receives that frozen body, without labels or answers', async () => {
  const prompts: string[] = [];
  const result = await runWatcherCase(fixture(), {
    next: async (prompt) => {
      prompts.push(prompt);
      return prompts.length === 1 ? reply({ kind: 'read', sourceIds: ['old'] }) : reply({ kind: 'silent' });
    },
  });
  assert.equal(result.state, 'complete');
  assert.deepEqual(result.decision, { kind: 'silent' });
  assert.equal(prompts.length, 2);
  assert.ok(!prompts[0].includes('PRIVATE SOURCE BODY'));
  assert.ok(prompts[1].includes('PRIVATE SOURCE BODY'));
  assert.ok(prompts.every((p) => !p.includes('private-label') && !p.includes('"quiet"')));
  assert.deepEqual(result.readSourceIds, ['old']);
});

test('an out-of-snapshot read fails with the spent call retained, never reading host paths', async () => {
  const result = await runWatcherCase(fixture(), {
    next: async () => reply({ kind: 'read', sourceIds: ['/outside/current.md'] }),
  });
  assert.equal(result.state, 'failed');
  assert.equal(result.reason, 'source_outside_snapshot');
  assert.equal(result.calls[0].usage[0].inputTotal, 100);
  assert.deepEqual(result.readSourceIds, []);
});

test('failure and call budget preserve all attempts instead of reporting an invented silent success', async () => {
  let count = 0;
  const failed = await runWatcherCase(fixture(), {
    next: async () => (++count === 1 ? reply({ kind: 'read', sourceIds: ['old'] }) : reply({}, false)),
  });
  assert.equal(failed.reason, 'native_call_failed');
  assert.equal(failed.calls.length, 2);
  assert.equal(failed.decision, undefined);
  const exhausted = await runWatcherCase(
    fixture(),
    { next: async () => reply({ kind: 'read', sourceIds: ['old'] }) },
    { maxCalls: 1, maxSources: 3, maxReadBytes: 1000 },
  );
  assert.equal(exhausted.reason, 'call_budget_exceeded');
});

test('a future observation is rejected before spending any model calls', async () => {
  const value = fixture();
  value.observations[0].occurredAt = '2026-10-23T00:00:00Z';
  let calls = 0;
  await assert.rejects(
    runWatcherCase(value, {
      next: async () => {
        calls++;
        return reply({ kind: 'silent' });
      },
    }),
    /observation_after_cutoff/,
  );
  assert.equal(calls, 0);
});

test('the offline handoff resolves the real coordinate and separates potential main-cat reading from watcher reads', async () => {
  let calls = 0;
  const result = await runWatcherCase(fixture(), {
    next: async () =>
      ++calls === 1
        ? reply({ kind: 'read', sourceIds: ['old'] })
        : reply({
            kind: 'hint',
            sourceId: 'old',
            message: 'An earlier case may apply.',
            basis: 'Same constraint.',
            recipient: 'working_cat',
            ownerReason: null,
          }),
  });
  assert.equal(result.state, 'complete');
  assert.ok(result.handoff);
  assert.equal(result.handoff?.sourceRef, 'message:old');
  assert.equal(result.handoff?.revision, 'r1');
  assert.equal(result.handoff?.delivered, false);
  assert.equal(result.handoff?.promptBytes, Buffer.byteLength(result.handoff.text));
  assert.equal(result.handoff?.linkedSourceBytes, Buffer.byteLength('PRIVATE SOURCE BODY'));
  assert.match(result.handoff.text, /不带授权/);
});

const hint = (sourceId: string) =>
  reply({
    kind: 'hint',
    sourceId,
    message: 'A prior may apply.',
    basis: 'Same constraint.',
    recipient: 'working_cat',
    ownerReason: null,
  });

test('a first-call hint cannot turn a catalog title into a verified source handoff', async () => {
  const result = await runWatcherCase(fixture(), { next: async () => hint('old') });
  assert.equal(result.state, 'failed');
  assert.equal(result.reason, 'source_not_read');
  assert.equal(result.handoff, undefined);
  assert.equal(result.decision, undefined);
  assert.equal(result.calls[0].usage[0].inputTotal, 100);
  assert.deepEqual(result.readSourceIds, []);
});

test('reading A cannot authorize a handoff citing unread B', async () => {
  const sample = fixture();
  sample.sources.push({ ...sample.sources[0], id: 'other', sourceRef: 'message:other' });
  let calls = 0;
  const result = await runWatcherCase(sample, {
    next: async () => (++calls === 1 ? reply({ kind: 'read', sourceIds: ['old'] }) : hint('other')),
  });
  assert.equal(result.state, 'failed');
  assert.equal(result.reason, 'source_not_read');
  assert.equal(result.handoff, undefined);
  assert.equal(result.calls.length, 2);
  assert.deepEqual(result.readSourceIds, ['old']);
});
