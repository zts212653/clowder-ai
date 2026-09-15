import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inspectPawFeelMessage } from '../../dist/infrastructure/harness-eval/friction/paw-feel-source.js';
import { PawFeelContinuingResponsibilityResolver } from '../../dist/infrastructure/harness-eval/paw-feel-disposition/continuation/follow-up-resolver.js';
import { PawFeelDispositionReadModel } from '../../dist/infrastructure/harness-eval/paw-feel-disposition/read-model.js';

const HOUR = 3_600_000;
const NOW_MS = Date.parse('2026-09-07T12:00:00.000Z');
const DISCOVERED_AT = new Date(NOW_MS - 80 * HOUR).toISOString();

function sourceMessage(id, content = '[爪感差: rg+continuing responsibility]') {
  return {
    id,
    threadId: 'thread-source',
    userId: 'user-1',
    catId: 'codex-sol',
    content,
    mentions: [],
    timestamp: Date.parse(DISCOVERED_AT),
  };
}

function lifecycle(message, transitions = [], candidateIndex = 0) {
  const inspection = inspectPawFeelMessage(message);
  assert.equal(inspection.kind, 'canonical');
  const candidate = inspection.candidates[candidateIndex];
  assert.ok(candidate);
  return {
    signalId: candidate.signalId,
    events: [
      {
        eventId: `discover:${candidate.signalId}`,
        signalId: candidate.signalId,
        type: 'discovered',
        actor: { kind: 'automation', id: 'paw-feel-capture' },
        occurredAt: DISCOVERED_AT,
        source: {
          sourceMessageId: candidate.sourceMessageId,
          sourceThreadId: candidate.sourceThreadId,
          sourceCatId: candidate.sourceCatId,
          markerDigest: candidate.markerDigest,
          sameDigestOrdinal: candidate.sameDigestOrdinal,
          markerIndex: candidate.markerIndex,
        },
        backfilled: false,
        captureMethod: 'typed',
        captureAssessment: 'confirmed',
      },
      ...transitions.map((event, index) => ({
        eventId: `transition:${candidate.signalId}:${index}`,
        signalId: candidate.signalId,
        actor: { kind: 'cat', id: 'opus' },
        occurredAt: new Date(Date.parse(DISCOVERED_AT) + (index + 1) * 1_000).toISOString(),
        ...event,
      })),
    ],
  };
}

function readModel(rows, options = {}) {
  const messages = new Map(rows.map((row) => [row.message.id, row.message]));
  const eventMap = new Map(rows.map((row) => [row.lifecycle.signalId, row.lifecycle.events]));
  return new PawFeelDispositionReadModel({
    eventLog: {
      async listSignalIds() {
        return [...eventMap.keys()].sort();
      },
      async read(signalId) {
        return eventMap.get(signalId) ?? [];
      },
      async readMany(signalIds) {
        return new Map(signalIds.map((signalId) => [signalId, eventMap.get(signalId) ?? []]));
      },
    },
    messageStore: {
      async getById(messageId) {
        options.onSourceRead?.(messageId);
        return messages.get(messageId) ?? null;
      },
    },
    ...(options.followUpResolver ? { followUpResolver: options.followUpResolver } : {}),
    now: () => new Date(NOW_MS).toISOString(),
  });
}

describe('F313 continuing responsibility projection', () => {
  it('keeps a duty-valid legacy blocker open and keeps issue age running', async () => {
    const message = sourceMessage('message-blocked');
    const blocked = lifecycle(message, [{ type: 'blocked', blockerCode: 'external_wait', blockerRef: 'case:123' }]);

    const model = readModel([{ message, lifecycle: blocked }]);
    const page = await model.list();
    const item = page.items[0];

    assert.equal(item.responsibility.validExit, true, 'the duty review receipt remains backwards compatible');
    assert.equal(item.issue.resolution, 'open');
    assert.equal(item.issue.continuation.kind, 'legacy_blocker_unbound');
    assert.equal(item.issue.ageMs, 80 * HOUR, 'issue age must not stop at the duty exit');
    assert.equal(page.bundles[0].issue.resolution, 'open');
    assert.deepEqual(page.issueCounts, { open: 1, resolved: 0, overdue: 1 });
    assert.equal((await model.list({ resolution: 'open', issueOverdueOnly: true })).items.length, 1);
  });

  it('resolves a reasoned no-action without changing duty receipt semantics', async () => {
    const message = sourceMessage('message-no-action');
    const noAction = lifecycle(message, [{ type: 'no_action', reasonCode: 'not_actionable', ownerCatId: 'opus' }]);

    const model = readModel([{ message, lifecycle: noAction }]);
    const page = await model.list();
    const item = page.items[0];

    assert.equal(item.responsibility.validExit, true);
    assert.equal(item.issue.resolution, 'resolved');
    assert.equal(item.issue.continuation.kind, 'no_action');
    assert.equal(item.issue.ageMs, 1_000);
    assert.deepEqual(page.issueCounts, { open: 0, resolved: 1, overdue: 0 });
    assert.equal((await model.list({ resolution: 'open' })).items.length, 0);
    assert.equal((await model.list({ resolution: 'resolved' })).items.length, 1);
  });

  it('filters on issue truth instead of treating a legacy closed disposition as resolved', async () => {
    const message = sourceMessage('message-legacy-closed');
    const closed = lifecycle(message, [
      { type: 'seen' },
      { type: 'closed', reasonCode: 'legacy_transport_closed', outcomeRef: 'legacy:receipt' },
    ]);
    const model = readModel([{ message, lifecycle: closed }]);

    const open = await model.list({ resolution: 'open' });
    const resolved = await model.list({ resolution: 'resolved' });

    assert.equal(open.items.length, 1);
    assert.equal(open.items[0].disposition.state, 'closed');
    assert.equal(open.items[0].issue.continuation.kind, 'done_unverified');
    assert.equal(resolved.items.length, 0);
  });

  it('reuses one MessageStore read for source projection and F266 join across same-message markers', async () => {
    const message = sourceMessage(
      'message-two-markers',
      '[爪感差: rg+first symptom]\n[爪感差: cat_cafe_hold_ball+second symptom]',
    );
    const first = lifecycle(message, [], 0);
    const second = lifecycle(message, [], 1);
    let sourceReads = 0;
    const seenSources = [];
    const followUpResolver = new PawFeelContinuingResponsibilityResolver({
      sourceCaseResolver: {
        async resolveFollowUp(input) {
          seenSources.push(input.source);
          return null;
        },
      },
    });
    const model = readModel(
      [
        { message, lifecycle: first },
        { message, lifecycle: second },
      ],
      { onSourceRead: () => (sourceReads += 1), followUpResolver },
    );

    const page = await model.list();
    assert.equal(page.items.length, 2);
    assert.equal(sourceReads, 1);
    assert.equal(seenSources.length, 2);
    assert.ok(seenSources.every((source) => source?.sourceSignalRef));
  });
});
