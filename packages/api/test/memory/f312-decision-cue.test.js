import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { DecisionCueResolver } from '../../dist/domains/memory/cue/resolvers/DecisionCueResolver.js';
import { DecisionMemoryCueSource } from '../../dist/domains/memory/cue/sources/DecisionMemoryCueSource.js';

const ownerUserId = 'owner-1';
const scope = { ownerUserId, threadId: 'thread-1', invocationId: 'invocation-1' };

function evidence(anchor, sourcePath) {
  return {
    anchor,
    kind: 'decision',
    status: 'active',
    title: 'INDEX_TITLE_ONLY',
    summary: 'INDEX_SUMMARY_ONLY',
    sourcePath,
    updatedAt: '2026-09-02T00:00:00.000Z',
    authority: 'constitutional',
  };
}

describe('F312 Decision cue vertical slice', () => {
  it('uses one accepted ADR as authority and invalidates its exact revision', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'f312-decision-cue-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    // IndexBuilder stores source_path relative to its docs/ scan root.
    const sourcePath = 'decisions/020-memory.md';
    mkdirSync(join(root, 'decisions'), { recursive: true });
    const writeDecision = (decision, body = 'CANONICAL_DECISION_BODY_ONLY') =>
      writeFileSync(
        join(root, sourcePath),
        [
          '---',
          'decision_id: ADR-020',
          'feature_ids: [F312]',
          '---',
          '',
          `> **Status**: ${decision}`,
          '',
          body,
          '',
        ].join('\n'),
      );
    writeDecision('accepted', `CANONICAL_DECISION_BODY_ONLY\n${'x'.repeat(4_500)}\nCANONICAL_TAIL_OUTSIDE_WINDOW`);

    const item = evidence('ADR-020', sourcePath);
    const terminalRevisions = new Set();
    const source = new DecisionMemoryCueSource({
      projectDocsRoot: root,
      evidenceStore: { getByAnchor: async (anchor) => (anchor === item.anchor ? item : null) },
      episodeStore: {
        hasTerminalConsumptionForSource: (input) => terminalRevisions.has(input.sourceRevision),
      },
    });
    const opportunity = {
      v: 1,
      kind: 'accepted_decision_required',
      opportunityId: 'decision-opportunity-1',
      producer: 'owner_message',
      consumer: 'agent_route',
      scope,
      occurredAt: 1_000,
      payload: { decisionAnchor: 'ADR-020', sourceMessageId: 'message-current' },
    };
    const cues = await new DecisionCueResolver(source).resolve(opportunity, {
      now: 1_000,
      expiresAt: 301_000,
      createDrillHandle: ({ family, anchor, revision }) => `opaque:${family}:${anchor}:${revision}`,
    });
    assert.equal(cues.length, 1);
    assert.equal(cues[0].resolverFamily, 'decision');
    assert.equal(cues[0].drill.family, 'evidence');
    assert.equal(cues[0].source.anchor, 'ADR-020');
    assert.match(cues[0].source.revision, /^sha256:/);

    const drilled = await source.read({
      anchor: cues[0].source.anchor,
      expectedRevision: cues[0].source.revision,
    });
    assert.equal(drilled.status, 'ok');
    assert.equal(drilled.payload.accepted, true);
    assert.equal(drilled.payload.sourcePath, sourcePath);
    assert.match(drilled.payload.content, /CANONICAL_DECISION_BODY_ONLY/);
    assert.doesNotMatch(drilled.payload.content, /INDEX_(?:TITLE|SUMMARY)_ONLY/);
    assert.equal(drilled.payload.content.length, 4_000, 'canonical source payload must stay bounded');
    assert.doesNotMatch(drilled.payload.content, /CANONICAL_TAIL_OUTSIDE_WINDOW/);
    assert.equal(drilled.payload.contentTruncated, true);

    terminalRevisions.add(cues[0].source.revision);
    assert.equal(
      await source.resolve({ ownerUserId, decisionAnchor: 'ADR-020' }),
      null,
      'an applied or dismissed exact revision must not be presented again',
    );

    writeDecision('superseded', 'CORRECTED_CANONICAL_BODY_ONLY');
    assert.deepEqual(await source.read({ anchor: 'ADR-020', expectedRevision: cues[0].source.revision }), {
      status: 'not_available',
      invalidationReason: 'source_corrected',
    });
  });

  it('does not turn draft decision documents into accepted authority', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'f312-decision-draft-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const sourcePath = 'decisions/031-draft.md';
    mkdirSync(join(root, 'decisions'), { recursive: true });
    writeFileSync(join(root, sourcePath), '---\ndecision_id: ADR-031\n---\n\n> **Status**: draft\n');
    const source = new DecisionMemoryCueSource({
      projectDocsRoot: root,
      evidenceStore: { getByAnchor: async () => evidence('ADR-031', sourcePath) },
      episodeStore: { hasTerminalConsumptionForSource: () => false },
    });
    assert.equal(await source.resolve({ ownerUserId, decisionAnchor: 'ADR-031' }), null);
  });
});
