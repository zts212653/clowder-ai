import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

function basePlan(steps) {
  return {
    schemaVersion: 1,
    id: 'F209/f209-phase-d-orientation',
    title: 'F209 Phase D Orientation',
    featureIds: ['F209'],
    ownerCatId: 'codex',
    intent: 'Orient a fresh cat on F209 Phase D evidence.',
    steps,
    outputPolicy: {
      storesResults: false,
      returnsConclusion: false,
      requiresAnchors: true,
    },
  };
}

function evidenceItem(
  anchor,
  index,
  drillDown = { tool: 'cat_cafe_read_file_slice', params: { path: `docs/${index}.md` }, hint: 'Read source' },
) {
  return {
    anchor,
    kind: 'feature',
    status: 'active',
    title: `Result ${index}`,
    summary: `Summary ${index}`,
    updatedAt: `2026-05-24T00:00:0${index}.000Z`,
    sourcePath: `docs/${index}.md`,
    drillDown,
  };
}

describe('PerspectiveRunner', () => {
  let PerspectiveRunner;

  beforeEach(async () => {
    ({ PerspectiveRunner } = await import('../../dist/domains/memory/PerspectiveRunner.js'));
  });

  it('reruns search steps on every invocation', async () => {
    let searchCalls = 0;
    const runner = new PerspectiveRunner({
      searchEvidence: async () => {
        searchCalls += 1;
        return { items: [evidenceItem('doc:first', searchCalls)], meta: { degraded: false, effectiveMode: 'hybrid' } };
      },
      openAnchor: async (candidate) => ({ anchor: candidate.anchor, status: 'opened', content: 'opened fresh' }),
      now: () => new Date('2026-05-24T00:00:00.000Z'),
      randomId: () => `run-${searchCalls + 1}`,
    });
    const plan = basePlan([
      {
        id: 'search-f209',
        type: 'search_evidence',
        query: 'F209 Phase D',
        scope: 'docs',
        mode: 'hybrid',
        depth: 'raw',
        limit: 5,
      },
    ]);

    await runner.run(plan, { actorCatId: 'codex' });
    await runner.run(plan, { actorCatId: 'codex' });

    assert.equal(searchCalls, 2);
  });

  it('records run metadata, search trace, degraded metadata, candidate anchors, and opened anchors', async () => {
    const runner = new PerspectiveRunner({
      searchEvidence: async (_query, options) => {
        assert.equal(options.scope, 'docs');
        assert.equal(options.mode, 'hybrid');
        assert.equal(options.depth, 'raw');
        return {
          items: [evidenceItem('doc:first', 1), evidenceItem('doc:second', 2)],
          meta: { degraded: true, degradeReason: 'passage_embedding_unavailable', effectiveMode: 'lexical' },
        };
      },
      openAnchor: async (candidate) => ({
        anchor: candidate.anchor,
        status: 'opened',
        tool: candidate.drillDown?.tool,
        content: `opened ${candidate.anchor}`,
      }),
      now: () => new Date('2026-05-24T00:00:00.000Z'),
      randomId: () => 'run-fixed',
    });
    const plan = basePlan([
      {
        id: 'search-f209',
        type: 'search_evidence',
        query: 'F209 Phase D',
        scope: 'docs',
        mode: 'hybrid',
        depth: 'raw',
        limit: 5,
      },
      {
        id: 'open-top',
        type: 'open_anchor',
        source: 'previous_step',
        selector: 'top',
        maxOpen: 1,
      },
    ]);

    const run = await runner.run(plan, { actorCatId: 'codex' });

    assert.equal(run.planId, 'F209/f209-phase-d-orientation');
    assert.equal(run.runId, 'run-fixed');
    assert.equal(run.actorCatId, 'codex');
    assert.equal(run.startedAt, '2026-05-24T00:00:00.000Z');
    assert.equal(run.steps[0].id, 'search-f209');
    assert.equal(run.steps[0].hitCount, 2);
    assert.equal(run.steps[0].degraded, true);
    assert.equal(run.steps[0].degradeReason, 'passage_embedding_unavailable');
    assert.equal(run.steps[0].effectiveMode, 'lexical');
    assert.equal(run.candidateAnchors.length, 2);
    assert.equal(run.candidateAnchors[0].anchor, 'doc:first');
    assert.equal(run.candidateAnchors[0].sourceStepId, 'search-f209');
    assert.equal(run.candidateAnchors[0].drillDown.tool, 'cat_cafe_read_file_slice');
    assert.equal(run.openedAnchors.length, 1);
    assert.equal(run.openedAnchors[0].anchor, 'doc:first');
    assert.equal(run.openedAnchors[0].status, 'opened');
    assert.equal('conclusion' in run, false);
    assert.equal('storedResults' in run, false);
    assert.equal('resultSet' in run, false);
  });

  it('bounds top anchor opening by maxOpen', async () => {
    const opened = [];
    const runner = new PerspectiveRunner({
      searchEvidence: async () => ({
        items: [1, 2, 3, 4, 5].map((index) => evidenceItem(`doc:${index}`, index)),
        meta: { degraded: false, effectiveMode: 'hybrid' },
      }),
      openAnchor: async (candidate) => {
        opened.push(candidate.anchor);
        return { anchor: candidate.anchor, status: 'opened', content: candidate.title };
      },
      now: () => new Date('2026-05-24T00:00:00.000Z'),
      randomId: () => 'run-open-bounded',
    });
    const plan = basePlan([
      { id: 'search-many', type: 'search_evidence', query: 'many', mode: 'hybrid', depth: 'raw' },
      { id: 'open-three', type: 'open_anchor', source: 'previous_step', selector: 'top', maxOpen: 3 },
    ]);

    const run = await runner.run(plan, { actorCatId: 'codex' });

    assert.deepEqual(opened, ['doc:1', 'doc:2', 'doc:3']);
    assert.equal(run.steps[1].openedCount, 3);
  });

  it('does not reuse stale search anchors after a graph_resolve previous step', async () => {
    const opened = [];
    const runner = new PerspectiveRunner({
      searchEvidence: async () => ({
        items: [evidenceItem('doc:stale', 1)],
        meta: { degraded: false, effectiveMode: 'hybrid' },
      }),
      resolveGraph: async () => ({ status: 'no_match' }),
      openAnchor: async (candidate) => {
        opened.push(candidate.anchor);
        return { anchor: candidate.anchor, status: 'opened', content: candidate.title };
      },
      now: () => new Date('2026-05-24T00:00:00.000Z'),
      randomId: () => 'run-graph-reset',
    });
    const plan = basePlan([
      { id: 'search-stale', type: 'search_evidence', query: 'old anchors', mode: 'hybrid', depth: 'raw' },
      { id: 'resolve-empty', type: 'graph_resolve', anchor: 'missing:anchor' },
      { id: 'open-after-graph', type: 'open_anchor', source: 'previous_step', selector: 'top', maxOpen: 1 },
    ]);

    const run = await runner.run(plan, { actorCatId: 'codex' });

    assert.deepEqual(opened, []);
    assert.equal(run.openedAnchors.length, 0);
    assert.equal(run.steps[2].openedCount, 0);
  });

  it('feeds graph_resolve anchors to a following open_anchor step', async () => {
    const opened = [];
    const runner = new PerspectiveRunner({
      searchEvidence: async () => {
        throw new Error('search should not run');
      },
      resolveGraph: async () => ({ status: 'graph', anchor: 'doc:from-graph' }),
      openAnchor: async (candidate) => {
        opened.push(candidate.anchor);
        return { anchor: candidate.anchor, status: 'opened', content: candidate.title };
      },
      now: () => new Date('2026-05-24T00:00:00.000Z'),
      randomId: () => 'run-graph-open',
    });
    const plan = basePlan([
      { id: 'resolve-graph', type: 'graph_resolve', anchor: 'F209' },
      { id: 'open-graph', type: 'open_anchor', source: 'previous_step', selector: 'top', maxOpen: 1 },
    ]);

    const run = await runner.run(plan, { actorCatId: 'codex' });

    assert.deepEqual(opened, ['doc:from-graph']);
    assert.equal(run.candidateAnchors.length, 1);
    assert.equal(run.candidateAnchors[0].sourceStepId, 'resolve-graph');
    assert.equal(run.candidateAnchors[0].rank, 1);
    assert.equal(run.steps[0].hitCount, 1);
    assert.equal(run.steps[1].openedCount, 1);
  });

  it('feeds graph_resolve candidate lists to a following open_anchor step', async () => {
    const opened = [];
    const runner = new PerspectiveRunner({
      searchEvidence: async () => {
        throw new Error('search should not run');
      },
      resolveGraph: async () => ({
        status: 'candidates',
        candidates: [{ anchor: 'doc:first', title: 'First graph hit' }, { anchor: 'doc:second' }],
      }),
      openAnchor: async (candidate) => {
        opened.push({ anchor: candidate.anchor, title: candidate.title, rank: candidate.rank });
        return { anchor: candidate.anchor, status: 'opened', content: candidate.title };
      },
      now: () => new Date('2026-05-24T00:00:00.000Z'),
      randomId: () => 'run-graph-candidates-open',
    });
    const plan = basePlan([
      { id: 'resolve-graph-candidates', type: 'graph_resolve', anchor: 'F209' },
      { id: 'open-graph-candidates', type: 'open_anchor', source: 'previous_step', selector: 'top', maxOpen: 2 },
    ]);

    const run = await runner.run(plan, { actorCatId: 'codex' });

    assert.deepEqual(opened, [
      { anchor: 'doc:first', title: 'First graph hit', rank: 1 },
      { anchor: 'doc:second', title: 'doc:second', rank: 2 },
    ]);
    assert.equal(run.candidateAnchors.length, 2);
    assert.equal(run.candidateAnchors[1].sourceStepId, 'resolve-graph-candidates');
    assert.equal(run.steps[0].hitCount, 2);
    assert.equal(run.steps[1].openedCount, 2);
  });

  it('turns unsupported anchor open failures into warnings without failing the run', async () => {
    const runner = new PerspectiveRunner({
      searchEvidence: async () => ({
        items: [evidenceItem('doc:unsupported', 1, undefined)],
        meta: { degraded: false, effectiveMode: 'lexical' },
      }),
      openAnchor: async () => {
        throw new Error('Unsupported anchor type: doc:unsupported');
      },
      now: () => new Date('2026-05-24T00:00:00.000Z'),
      randomId: () => 'run-warning',
    });
    const plan = basePlan([
      { id: 'search-unsupported', type: 'search_evidence', query: 'unsupported', mode: 'lexical' },
      { id: 'open-unsupported', type: 'open_anchor', source: 'previous_step', selector: 'top', maxOpen: 1 },
    ]);

    const run = await runner.run(plan, { actorCatId: 'codex' });

    assert.equal(run.runId, 'run-warning');
    assert.equal(run.steps[1].status, 'warning');
    assert.equal(run.steps[1].openedCount, 0);
    assert.equal(run.openedAnchors[0].status, 'unsupported');
    assert.match(run.warnings[0].message, /Unsupported anchor type/);
  });

  it('marks returned unsuccessful anchor open statuses as warnings', async () => {
    const runner = new PerspectiveRunner({
      searchEvidence: async () => ({
        items: [evidenceItem('doc:returned-unsupported', 1)],
        meta: { degraded: false, effectiveMode: 'lexical' },
      }),
      openAnchor: async (candidate) => ({
        anchor: candidate.anchor,
        status: 'unsupported',
        error: 'reader unavailable',
      }),
      now: () => new Date('2026-05-24T00:00:00.000Z'),
      randomId: () => 'run-returned-warning',
    });
    const plan = basePlan([
      { id: 'search-returned-unsupported', type: 'search_evidence', query: 'unsupported', mode: 'lexical' },
      { id: 'open-returned-unsupported', type: 'open_anchor', source: 'previous_step', selector: 'top', maxOpen: 1 },
    ]);

    const run = await runner.run(plan, { actorCatId: 'codex' });

    assert.equal(run.runId, 'run-returned-warning');
    assert.equal(run.steps[1].status, 'warning');
    assert.equal(run.steps[1].openedCount, 0);
    assert.equal(run.openedAnchors[0].status, 'unsupported');
    assert.equal(run.warnings[0].stepId, 'open-returned-unsupported');
    assert.equal(run.warnings[0].code, 'open_anchor_unsuccessful');
    assert.match(run.warnings[0].message, /reader unavailable/);
  });

  it('turns graph resolver failures into warnings without failing the run', async () => {
    const runner = new PerspectiveRunner({
      searchEvidence: async () => ({
        items: [evidenceItem('doc:first', 1)],
        meta: { degraded: false, effectiveMode: 'hybrid' },
      }),
      resolveGraph: async () => {
        throw new Error('graph backend unavailable');
      },
      openAnchor: async (candidate) => ({ anchor: candidate.anchor, status: 'opened', content: candidate.title }),
      now: () => new Date('2026-05-24T00:00:00.000Z'),
      randomId: () => 'run-graph-warning',
    });
    const plan = basePlan([
      { id: 'search-before-graph', type: 'search_evidence', query: 'keep earlier output', mode: 'hybrid' },
      { id: 'resolve-failing', type: 'graph_resolve', anchor: 'F209' },
    ]);

    const run = await runner.run(plan, { actorCatId: 'codex' });

    assert.equal(run.runId, 'run-graph-warning');
    assert.equal(run.steps[0].status, 'ok');
    assert.equal(run.steps[1].status, 'warning');
    assert.equal(run.steps[1].queryOrAnchor, 'F209');
    assert.equal(run.warnings[0].stepId, 'resolve-failing');
    assert.equal(run.warnings[0].code, 'graph_resolve_failed');
    assert.match(run.warnings[0].message, /graph backend unavailable/);
  });
});
