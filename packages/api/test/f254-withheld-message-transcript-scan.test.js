import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { parseRecoveryCensus } from '../dist/scripts/f254-withheld-message-recovery/census.js';
import { scanRecoveryTranscriptFiles } from '../dist/scripts/f254-withheld-message-recovery/transcript-scan.js';

const tempRoots = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function events(invocationId, content, sessionId = 'session-1') {
  const base = {
    v: 1,
    threadId: 'thread_recovery',
    catId: 'fable-5',
    sessionId,
    cliSessionId: 'cli-session-1',
    invocationId,
  };
  return [
    { ...base, t: 100, eventNo: 1, event: { type: 'session_init' } },
    { ...base, t: 110, eventNo: 2, event: { type: 'text', content } },
    { ...base, t: 120, eventNo: 3, event: { type: 'done' } },
  ];
}

async function writeEvents(root, relativePath, records) {
  const path = join(root, relativePath);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
  return path;
}

describe('F254 unified transcript scanner', () => {
  test('validates the forensic census before transcript lookup', () => {
    const parsed = parseRecoveryCensus({
      total: 1,
      entries: [
        {
          invocationId: 'invocation-recovery-1',
          userId: 'default-user',
          threadId: 'thread_recovery',
          catId: 'fable-5',
          withheldAtUtc: '2026-07-12T01:00:00.000Z',
          closureId: 'closure-recovery-1',
          kind: 'superseded_positive_stale',
          associationMethod: 'time-window-last-created',
        },
      ],
    });
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].associationMethod, 'time-window-last-created');
    assert.throws(() => parseRecoveryCensus({ total: 2, entries: [parsed[0]] }), /census total does not match entries/);
  });

  test('prefers a sealed transcript over its live duplicate and reconstructs exact text', async () => {
    const root = await mkdtemp(join(tmpdir(), 'f254-transcript-scan-'));
    tempRoots.push(root);
    const invocationId = 'invocation-recovery-1';
    const live = await writeEvents(root, 'threads/t/c/s/events.live.jsonl', events(invocationId, 'draft'));
    const sealed = await writeEvents(root, 'threads/t/c/s/events.jsonl', events(invocationId, 'exact final'));

    const result = await scanRecoveryTranscriptFiles({
      targets: [{ invocationId, userId: 'default-user' }],
      files: [live, sealed],
      sourceRoot: root,
    });

    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].content, 'exact final');
    assert.equal(result.entries[0].timestamp, 100);
    assert.equal(result.entries[0].sourceProof.transcriptPath, 'threads/t/c/s/events.jsonl');
    assert.equal(result.entries[0].sourceProof.terminalKind, 'transcript_done');
  });

  test('uses an F254 withheld decision as terminal evidence when the recorder missed done', async () => {
    const root = await mkdtemp(join(tmpdir(), 'f254-transcript-scan-'));
    tempRoots.push(root);
    const invocationId = 'invocation-recovery-2';
    const records = events(invocationId, 'complete text').filter((record) => record.event.type !== 'done');
    const file = await writeEvents(root, 'threads/t/c/s/events.live.jsonl', records);

    const result = await scanRecoveryTranscriptFiles({
      targets: [
        {
          invocationId,
          userId: 'default-user',
          withheldDecision: {
            withheldAtUtc: '2026-07-12T01:00:00.000Z',
            closureId: 'closure-recovery-2',
            decisionKind: 'superseded_positive_stale',
          },
        },
      ],
      files: [file],
      sourceRoot: root,
    });

    assert.equal(result.entries[0].content, 'complete text');
    assert.equal(result.entries[0].sourceProof.terminalKind, 'f254_withheld_decision');
    assert.equal(result.entries[0].sourceProof.withheldDecision.closureId, 'closure-recovery-2');
  });

  test('accounts for a tool-only withheld turn as an explicit no-text omission', async () => {
    const root = await mkdtemp(join(tmpdir(), 'f254-transcript-scan-'));
    tempRoots.push(root);
    const invocationId = 'invocation-recovery-3';
    const records = events(invocationId, 'unused').filter((record) => record.event.type !== 'text');
    const file = await writeEvents(root, 'threads/t/c/s/events.jsonl', records);

    const result = await scanRecoveryTranscriptFiles({
      targets: [{ invocationId, userId: 'default-user' }],
      files: [file],
      sourceRoot: root,
    });

    assert.deepEqual(result.entries, []);
    assert.deepEqual(result.omittedNoTextInvocations, [invocationId]);
  });

  test('fails closed when any requested invocation has no complete transcript', async () => {
    const root = await mkdtemp(join(tmpdir(), 'f254-transcript-scan-'));
    tempRoots.push(root);
    const found = await writeEvents(root, 'threads/t/c/s/events.jsonl', events('invocation-found-1', 'found'));

    await assert.rejects(
      () =>
        scanRecoveryTranscriptFiles({
          targets: [
            { invocationId: 'invocation-found-1', userId: 'default-user' },
            { invocationId: 'invocation-missing-1', userId: 'default-user' },
          ],
          files: [found],
          sourceRoot: root,
        }),
      /missing complete transcripts: invocation-missing-1/,
    );
  });
});
