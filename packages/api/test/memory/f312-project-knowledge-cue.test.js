import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ProjectKnowledgeCueResolver } from '../../dist/domains/memory/cue/resolvers/ProjectKnowledgeCueResolver.js';
import { ProjectKnowledgeMemoryCueSource } from '../../dist/domains/memory/cue/sources/ProjectKnowledgeMemoryCueSource.js';

const ownerUserId = 'owner-1';
const scope = { ownerUserId, threadId: 'thread-1', invocationId: 'invocation-1' };

function evidence(anchor, sourcePath) {
  return {
    anchor,
    kind: 'feature',
    status: 'active',
    title: 'INDEX_TITLE_ONLY',
    summary: 'INDEX_SUMMARY_ONLY',
    sourcePath,
    updatedAt: '2026-09-02T00:00:00.000Z',
    authority: 'validated',
  };
}

describe('F312 Project Knowledge cue vertical slice', () => {
  it('uses the exact feature source without giving the F209 index authority', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'f312-project-cue-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    // IndexBuilder stores source_path relative to its docs/ scan root.
    const sourcePath = 'features/F312-memory.md';
    mkdirSync(join(root, 'features'), { recursive: true });
    const writeFeature = (goal) =>
      writeFileSync(
        join(root, sourcePath),
        ['---', 'feature_ids: [F312]', 'status: doing', '---', '', '# F312 Memory', '', goal, ''].join('\n'),
      );
    writeFeature('CANONICAL_PROJECT_BODY_ONLY');

    const item = evidence('F312', sourcePath);
    const terminalRevisions = new Set();
    const source = new ProjectKnowledgeMemoryCueSource({
      projectDocsRoot: root,
      evidenceStore: { getByAnchor: async (anchor) => (anchor === item.anchor ? item : null) },
      episodeStore: {
        hasTerminalConsumptionForSource: (input) => terminalRevisions.has(input.sourceRevision),
      },
    });
    const opportunity = {
      v: 1,
      kind: 'project_source_required',
      opportunityId: 'project-opportunity-1',
      producer: 'task_context',
      consumer: 'agent_route',
      scope,
      occurredAt: 1_000,
      payload: {
        featureId: 'F312',
        selectionSource: 'workflow_feature',
        sourceMessageId: 'message-current',
      },
    };
    const cues = await new ProjectKnowledgeCueResolver(source).resolve(opportunity, {
      now: 1_000,
      expiresAt: 301_000,
      createDrillHandle: ({ family, anchor, revision }) => `opaque:${family}:${anchor}:${revision}`,
    });
    assert.equal(cues.length, 1);
    assert.equal(cues[0].resolverFamily, 'project_knowledge');
    assert.equal(cues[0].drill.family, 'evidence');
    assert.equal(cues[0].source.anchor, 'F312');

    const drilled = await source.read({ anchor: 'F312', expectedRevision: cues[0].source.revision });
    assert.equal(drilled.status, 'ok');
    assert.deepEqual(Object.keys(drilled.payload).sort(), [
      'anchor',
      'content',
      'contentTruncated',
      'sourcePath',
      'sourceRevision',
      'summary',
      'title',
    ]);
    assert.match(drilled.payload.content, /CANONICAL_PROJECT_BODY_ONLY/);
    assert.doesNotMatch(drilled.payload.content, /INDEX_(?:TITLE|SUMMARY)_ONLY/);
    assert.ok(drilled.payload.content.length <= 4_000, 'canonical source payload must stay bounded');
    assert.equal(drilled.payload.contentTruncated, false);

    terminalRevisions.add(cues[0].source.revision);
    assert.equal(await source.resolve({ ownerUserId, featureId: 'F312' }), null);

    writeFeature('CORRECTED_CANONICAL_BODY_ONLY');
    assert.deepEqual(await source.read({ anchor: 'F312', expectedRevision: cues[0].source.revision }), {
      status: 'not_available',
      invalidationReason: 'source_corrected',
    });
  });

  it('rejects an index row that points outside the canonical feature authority', async () => {
    const source = new ProjectKnowledgeMemoryCueSource({
      projectDocsRoot: '/tmp',
      evidenceStore: { getByAnchor: async () => evidence('F312', '../private/F312.md') },
      episodeStore: { hasTerminalConsumptionForSource: () => false },
    });
    assert.equal(await source.resolve({ ownerUserId, featureId: 'F312' }), null);
  });

  it('rejects a lexically contained source path whose symlink escapes the project root', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'f312-project-symlink-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'f312-project-symlink-outside-'));
    t.after(() => {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    });
    mkdirSync(join(root, 'features'), { recursive: true });
    writeFileSync(join(outside, 'F312-private.md'), '# CANONICAL_OUTSIDE_ROOT_ONLY\n');
    const sourcePath = 'features/F312-linked.md';
    symlinkSync(join(outside, 'F312-private.md'), join(root, sourcePath));
    const source = new ProjectKnowledgeMemoryCueSource({
      projectDocsRoot: root,
      evidenceStore: { getByAnchor: async () => evidence('F312', sourcePath) },
      episodeStore: { hasTerminalConsumptionForSource: () => false },
    });

    assert.equal(await source.resolve({ ownerUserId, featureId: 'F312' }), null);
  });
});
