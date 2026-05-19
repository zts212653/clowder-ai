import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

describe('F200 candidate extraction in deriveResultSummary', () => {
  let deriveResultSummary;

  before(async () => {
    const mod = await import('../../dist/domains/cats/services/tool-usage/derive-result-summary.js');
    deriveResultSummary = mod.deriveResultSummary;
  });

  it('search_evidence extracts candidates with anchor and docKind', () => {
    const text = `Evidence search results: Found 2 result(s) for "memory adapter":

[high] Feature Memory Adapter v2
  anchor: F102
  type: feature
  authority: validated
  > Snippet text here

[mid] Library Stewardship
  anchor: F188
  type: feature
  authority: validated
  > Another snippet`;

    const summary = deriveResultSummary('search_evidence', text);
    assert.equal(summary['resultCount'], 2);
    const candidates = summary['_f200Candidates'];
    assert.ok(candidates, '_f200Candidates present');
    assert.equal(candidates.length, 2);
    assert.equal(candidates[0].anchor, 'F102');
    assert.equal(candidates[0].rank, 0);
    assert.equal(candidates[0].docKind, 'feature');
    assert.equal(candidates[1].anchor, 'F188');
    assert.equal(candidates[1].rank, 1);
  });

  it('graph_resolve extracts candidates from candidate list', () => {
    const text = `Candidates for "F200" (3 matches — pick one then call graph_resolve again):

[0] F200 — Memory Recall Eval
     kind=feature | source=project:cat-cafe | match: anchor_exact
     > Spec v3 updated
[1] F192 — Socio-Technical Harness Eval
     kind=feature | source=project:cat-cafe | match: title_partial
[2] F153 — Observability Infrastructure
     kind=feature | source=project:cat-cafe | match: title_partial`;

    const summary = deriveResultSummary('graph_resolve', text);
    const candidates = summary['_f200Candidates'];
    assert.ok(candidates, '_f200Candidates present');
    assert.equal(candidates.length, 3);
    assert.equal(candidates[0].anchor, 'F200');
    assert.equal(candidates[0].rank, 0);
    assert.equal(candidates[0].docKind, 'feature');
    assert.equal(candidates[1].anchor, 'F192');
    assert.equal(candidates[2].anchor, 'F153');
  });

  it('list_recent extracts candidates', () => {
    const text = `Recent items (last 7d): 3 found

  2026-05-12 | F102 — Feature Memory Adapter (feature) [source: project:cat-cafe]
  2026-05-10 | ADR-019 — Cache Decision (decision) [source: project:cat-cafe]
  2026-05-08 | L-08 — Lesson: Pitfall (lesson) [source: project:cat-cafe]

— Clowder AI 7-tool memory family —`;

    const summary = deriveResultSummary('list_recent', text);
    const candidates = summary['_f200Candidates'];
    assert.ok(candidates, '_f200Candidates present');
    assert.equal(candidates.length, 3);
    assert.equal(candidates[0].anchor, 'F102');
    assert.equal(candidates[0].docKind, 'feature');
    assert.equal(candidates[1].anchor, 'ADR-019');
    assert.equal(candidates[1].docKind, 'decision');
  });

  it('search_evidence extracts sourcePath into candidates (HW-4 根因②b)', () => {
    // 砚砚 P1-2: structured chain — evidence.ts now passes item.sourcePath
    // (interfaces.ts:79) → EvidenceResult → MCP renders `  sourcePath: <path>`
    // machine line → deriveSearchEvidence parses it so path-based shell/Read
    // consumption can match without relying solely on anchor.
    const text = `Evidence search results: Found 2 result(s) for "F200":

[high] F200 Memory Recall Eval
  anchor: F200
  type: feature
  sourcePath: docs/features/F200-memory-recall-eval.md
  > Snippet

[mid] Socio-Technical Harness
  anchor: F192
  type: feature
  sourcePath: docs/features/F192-socio-technical-harness-eval.md
  > Another`;
    const summary = deriveResultSummary('search_evidence', text);
    const candidates = summary['_f200Candidates'];
    assert.ok(candidates, '_f200Candidates present');
    assert.equal(candidates[0].anchor, 'F200');
    assert.equal(
      candidates[0].sourcePath,
      'docs/features/F200-memory-recall-eval.md',
      'sourcePath parsed from machine line for candidate 0',
    );
    assert.equal(candidates[1].anchor, 'F192');
    assert.equal(candidates[1].sourcePath, 'docs/features/F192-socio-technical-harness-eval.md');
  });

  it('search_evidence with no results has no candidates', () => {
    const text = 'No results found for "nonexistent query"';
    const summary = deriveResultSummary('search_evidence', text);
    assert.equal(summary['resultCount'], 0);
    assert.equal(summary['_f200Candidates'], undefined);
  });

  it('graph_resolve subgraph mode extracts center as candidate', () => {
    const text = `Graph for "F102":  5 nodes, 3 edges (depth=1)

★ F102 — Feature Memory Adapter (feature)[restricted]
  F042 — Architecture Overview (design)

Edges:
  F102 -[feature_ref]-> F042`;

    const summary = deriveResultSummary('graph_resolve', text);
    assert.equal(summary['centerAnchor'], 'F102');
    const candidates = summary['_f200Candidates'];
    assert.ok(candidates, '_f200Candidates present for graph mode');
    assert.equal(candidates.length, 2, 'center + neighbor from edges');
    assert.equal(candidates[0].anchor, 'F102');
    assert.equal(candidates[1].anchor, 'F042');

    const edges = summary['_f200Edges'];
    assert.ok(edges, '_f200Edges present for graph mode');
    assert.equal(edges.length, 1);
    assert.equal(edges[0].from, 'F102');
    assert.equal(edges[0].to, 'F042');
    assert.equal(edges[0].relation, 'feature_ref');
  });

  it('search_evidence sets _f200HasPrivateHits when redacted marker present', () => {
    const text = [
      'Found 2 result(s)',
      '[high] Public Feature Doc',
      '  anchor: F102',
      '  type: feature',
      '[mid] [redacted — private collection]',
      '  anchor: world:lexander:doc/secret-plot',
      '  type: doc',
    ].join('\n');
    const summary = deriveResultSummary('search_evidence', text);
    assert.equal(summary._f200HasPrivateHits, true);
  });
});
