/**
 * deriveResultSummary Tests — F188 Phase F (砚砚 cloud P2 regression guard)
 *
 * Verifies tool_result text → summary extraction for search_evidence,
 * graph_resolve, list_recent. Includes the anchor-regex broadening fix
 * so multi-segment anchors (with `:`, `/`) survive into rankedCandidateAnchors.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('deriveResultSummary — graph_resolve anchor parsing (砚砚 cloud P2)', () => {
  test('parses standard alphanumeric anchors (F186, ADR-019)', async () => {
    const { deriveResultSummary } = await import('../dist/domains/cats/services/tool-usage/derive-result-summary.js');
    const text = [
      'Candidates for "memory" (3 matches, ranked by relevance):',
      '',
      '[0] F186 — Memory Cache Layer',
      '[1] ADR-019 — Memory Adapter Decision',
      '[2] F102 — Library Stewardship',
    ].join('\n');

    const result = deriveResultSummary('graph_resolve', text);
    assert.equal(result.candidateCount, 3);
    assert.deepEqual(result.rankedCandidateAnchors, ['F186', 'ADR-019', 'F102']);
  });

  test('parses multi-segment anchors with colons (world:lexander:dragon)', async () => {
    const { deriveResultSummary } = await import('../dist/domains/cats/services/tool-usage/derive-result-summary.js');
    const text = [
      'Candidates for "dragon" (2 matches, ranked by relevance):',
      '',
      '[0] world:lexander:dragon — Dragon entity',
      '[1] world:lexander:archer — Archer NPC',
    ].join('\n');

    const result = deriveResultSummary('graph_resolve', text);
    assert.equal(result.candidateCount, 2);
    assert.deepEqual(
      result.rankedCandidateAnchors,
      ['world:lexander:dragon', 'world:lexander:archer'],
      'colons must survive — required for FM-2 selection linking',
    );
  });

  test('parses path-style anchors with slashes (docs/decisions/019)', async () => {
    const { deriveResultSummary } = await import('../dist/domains/cats/services/tool-usage/derive-result-summary.js');
    const text = [
      'Candidates for "decision" (2 matches, ranked by relevance):',
      '',
      '[0] docs/decisions/019 — Memory adapter',
      '[1] docs/decisions/033 — Eval contract',
    ].join('\n');

    const result = deriveResultSummary('graph_resolve', text);
    assert.deepEqual(result.rankedCandidateAnchors, ['docs/decisions/019', 'docs/decisions/033']);
  });

  test('parses graph subgraph mode (centerAnchor + node/edge counts)', async () => {
    const { deriveResultSummary } = await import('../dist/domains/cats/services/tool-usage/derive-result-summary.js');
    const text = 'Graph for "F188":  12 nodes, 27 edges (depth=2)';
    const result = deriveResultSummary('graph_resolve', text);
    assert.equal(result.centerAnchor, 'F188');
    assert.equal(result.nodeCount, 12);
    assert.equal(result.edgeCount, 27);
    assert.equal(result.selectedCandidateIndex, 0);
  });

  test('search_evidence: nudgeEmitted detected from marker', async () => {
    const { deriveResultSummary } = await import('../dist/domains/cats/services/tool-usage/derive-result-summary.js');
    const text = ['Found 1 result(s):', '[low] F042 — fuzzy match', '', '🧭 Memory navigation hint: ...'].join('\n');
    const result = deriveResultSummary('search_evidence', text);
    assert.equal(result.resultCount, 1);
    assert.equal(result.nudgeEmitted, true);
    assert.equal(result.topConfidence, 'low');
  });

  test('list_recent: parses since + count', async () => {
    const { deriveResultSummary } = await import('../dist/domains/cats/services/tool-usage/derive-result-summary.js');
    const text = 'Recent items (last 7d): 5 found';
    const result = deriveResultSummary('list_recent', text);
    assert.equal(result.since, '7d');
    assert.equal(result.resultCount, 5);
  });
});
