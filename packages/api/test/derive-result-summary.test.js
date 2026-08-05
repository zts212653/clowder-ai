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

  test('search_evidence: successful results may contain failure words in hit titles', async () => {
    const { deriveResultSummary } = await import('../dist/domains/cats/services/tool-usage/derive-result-summary.js');
    const text = 'Found 1 result(s): [high] F999 — Failed callback handling retrospective';
    const result = deriveResultSummary('search_evidence', text);

    assert.equal(result.isError, undefined);
    assert.equal(result.resultCount, 1);
    assert.equal(result.resultStatus, 'counted');
    assert.equal(result.topConfidence, 'high');
  });

  test('search_evidence: preserves the top rank from the current match header', async () => {
    const { deriveResultSummary } = await import('../dist/domains/cats/services/tool-usage/derive-result-summary.js');
    const text =
      'Evidence search results: Found 1 result(s):\n[match:mid · authority:validated · updated:2026-07-12T00:00:00Z] F263 result';

    const result = deriveResultSummary('search_evidence', text);

    assert.equal(result.topConfidence, 'mid');
  });

  test('search_evidence: preserves the top rank from a compacted recall sidecar', async () => {
    const { deriveResultSummary } = await import('../dist/domains/cats/services/tool-usage/derive-result-summary.js');
    const text =
      'Evidence search results: Found 1 result(s):\n<recall-meta>{"resultStatus":"counted","resultCount":1,"previewItems":[{"title":"F263 result","matchRank":"high"}]}</recall-meta>';

    const result = deriveResultSummary('search_evidence', text);

    assert.equal(result.topConfidence, 'high');
  });

  test('search_evidence: parses producer recall-meta sidecar before free-text fallback', async () => {
    const { deriveResultSummary } = await import('../dist/domains/cats/services/tool-usage/derive-result-summary.js');
    const text = [
      'Evidence search request failed: Error: result exceeds maximum allowed tokens.',
      'Full result saved to /tmp/cat-cafe/search-evidence-result.txt',
      '<recall-meta>{"resultStatus":"overflow","resultCount":12,"artifactRef":{"path":"/tmp/cat-cafe/search-evidence-result.txt"},"readNextHint":"Read the artifact file for the complete result set."}</recall-meta>',
    ].join('\n');

    const result = deriveResultSummary('search_evidence', text);

    assert.equal(result.resultStatus, 'overflow');
    assert.equal(result.resultCount, 12);
    assert.deepEqual(result.artifactRef, { path: '/tmp/cat-cafe/search-evidence-result.txt' });
    assert.equal(result.readNextHint, 'Read the artifact file for the complete result set.');
  });

  test('search_evidence: parses recall-meta before freshness notice trailer', async () => {
    const { deriveResultSummary } = await import('../dist/domains/cats/services/tool-usage/derive-result-summary.js');
    const text = [
      'Evidence search request failed: Error: result exceeds maximum allowed tokens.',
      'Full result saved to /tmp/cat-cafe/search-evidence-result.txt',
      '<recall-meta>{"resultStatus":"overflow","resultCount":12,"artifactRef":{"path":"/tmp/cat-cafe/search-evidence-result.txt"},"readNextHint":"Read the artifact file for the complete result set."}</recall-meta>',
      '',
      '📬 提醒：你有 2 条未读消息（当前 thread）',
      '来自：landy, opus48',
      '调 get_thread_context 查看完整内容',
    ].join('\n');

    const result = deriveResultSummary('search_evidence', text);

    assert.equal(result.resultStatus, 'overflow');
    assert.equal(result.resultCount, 12);
    assert.deepEqual(result.artifactRef, { path: '/tmp/cat-cafe/search-evidence-result.txt' });
    assert.equal(result.readNextHint, 'Read the artifact file for the complete result set.');
  });

  test('search_evidence: parses appended recall-meta when result text contains an earlier unclosed marker', async () => {
    const { deriveResultSummary } = await import('../dist/domains/cats/services/tool-usage/derive-result-summary.js');
    const text = [
      'Evidence search request failed: Error: result exceeds maximum allowed tokens.',
      'Full result saved to /tmp/cat-cafe/search-evidence-result.txt',
      'preview: reviewer mentioned a literal <recall-meta> marker in prose',
      '<recall-meta>{"resultStatus":"overflow","resultCount":12,"artifactRef":{"path":"/tmp/cat-cafe/search-evidence-result.txt"}}</recall-meta>',
    ].join('\n');

    const result = deriveResultSummary('search_evidence', text);

    assert.equal(result.resultStatus, 'overflow');
    assert.equal(result.resultCount, 12);
    assert.deepEqual(result.artifactRef, { path: '/tmp/cat-cafe/search-evidence-result.txt' });
  });

  test('search_evidence: rejects invalid recall-meta invariants and falls back to text', async () => {
    const { deriveResultSummary } = await import('../dist/domains/cats/services/tool-usage/derive-result-summary.js');
    const text = [
      'Found 2 result(s):',
      '[high] F102 — valid text fallback',
      '<recall-meta>{"resultStatus":"counted"}</recall-meta>',
    ].join('\n');

    const result = deriveResultSummary('search_evidence', text);

    assert.equal(result.resultStatus, 'counted');
    assert.equal(result.resultCount, 2);
  });

  test('search_evidence: no results has explicit no_results status', async () => {
    const { deriveResultSummary } = await import('../dist/domains/cats/services/tool-usage/derive-result-summary.js');
    const result = deriveResultSummary('search_evidence', 'Evidence search results: No results found for: missing');

    assert.equal(result.resultStatus, 'no_results');
    assert.equal(result.resultCount, 0);
  });

  test('list_recent: parses since + count', async () => {
    const { deriveResultSummary } = await import('../dist/domains/cats/services/tool-usage/derive-result-summary.js');
    const text = 'Recent items (last 7d): 5 found';
    const result = deriveResultSummary('list_recent', text);
    assert.equal(result.since, '7d');
    assert.equal(result.resultCount, 5);
    assert.equal(result.resultStatus, 'counted');
  });

  test('F256 Wave 1b: uses typed recall-meta targets instead of lossy rendered anchors', async () => {
    const { deriveResultSummary } = await import('../dist/domains/cats/services/tool-usage/derive-result-summary.js');
    const text = [
      'Found 2 result(s) for "routing"',
      '',
      '1. [high] Routing System',
      '   anchor: F102-routing',
      '',
      '2. [mid] Thread Digest',
      '   anchor: thread-abc123',
      '',
      '📎 Related directions:',
      '   - F208-capability-profile: Capability Profile Routing [frontmatter-alias: keyword:routing]',
      '   - thread-def456-digest: Discussion about routing [source-thread: thread-def456]',
      '',
      '📊 本轮第 1 次搜索',
      '<recall-meta>{"resultStatus":"counted","resultCount":2,"expansionFunnel":{"schemaVersion":1,"cohort":"natural_topk","sourceRevision":"f256-health-v2","eligible":true,"gateReason":"eligible","followupWindow":{"maxToolDistance":20,"maxWallClockMs":300000},"attempted":true,"keyword":{"probed":1,"added":1,"deduped":0},"sourceThread":{"probed":1,"added":1,"deduped":0},"conventionEdge":{"attempted":false,"added":0,"deduped":0,"staleSkipped":0},"presented":2,"hints":[{"anchor":"F208-capability-profile","targetRef":{"kind":"doc","sourcePath":"docs/features/F208-cat-capability-profile.md","anchor":"F208-capability-profile"}},{"anchor":"thread-def456-digest","targetRef":{"kind":"thread","threadId":"thread-def456"}}]}}</recall-meta>',
    ].join('\n');

    const result = deriveResultSummary('search_evidence', text);
    assert.equal(result.resultCount, 2);
    assert.equal(result.expansionHintAnchors, undefined);
    assert.deepEqual(result.expansionFunnel.hints[1].targetRef, {
      kind: 'thread',
      threadId: 'thread-def456',
    });
  });

  test('F256 Wave 1b: rendered related directions without a sidecar do not create a lossy signal', async () => {
    const { deriveResultSummary } = await import('../dist/domains/cats/services/tool-usage/derive-result-summary.js');
    const text = [
      'Found 1 result(s) for "test"',
      '',
      '1. [high] Test Feature',
      '   anchor: F100',
      '',
      '📎 Related directions:',
      '   - F208: Capability Profile [frontmatter-alias: keyword:routing]',
      '',
      '📊 本轮第 1 次搜索',
    ].join('\n');

    const result = deriveResultSummary('search_evidence', text);
    assert.equal(result.expansionHintAnchors, undefined);
    assert.equal(result.expansionFunnel, undefined);
  });

  test('generic MCP errors: parses non-memory tool failure text', async () => {
    const { deriveResultSummary } = await import('../dist/domains/cats/services/tool-usage/derive-result-summary.js');
    const result = deriveResultSummary('publish_verdict', 'Callback failed (404): no_trials_in_window');

    assert.equal(result.isError, true);
    assert.equal(result.errorMessage, 'Callback failed (404): no_trials_in_window');
  });

  test('memory tool errors: preserves error markers when recall-meta sidecar is present', async () => {
    const { deriveResultSummary } = await import('../dist/domains/cats/services/tool-usage/derive-result-summary.js');
    const text = [
      'Evidence search request failed: Error: datastore unavailable',
      '<recall-meta>{"resultStatus":"error","resultCount":null,"readNextHint":"Retry after memory service recovers."}</recall-meta>',
    ].join('\n');

    const result = deriveResultSummary('search_evidence', text);

    assert.equal(result.resultStatus, 'error');
    assert.equal(result.resultCount, null);
    assert.equal(result.isError, true);
    assert.equal(
      result.errorMessage,
      'Evidence search request failed: Error: datastore unavailable',
      'sidecar must not hide the textual failure marker from telemetry',
    );
    assert.equal(result.readNextHint, 'Retry after memory service recovers.');
  });

  test('search_evidence: explicit null resultCount in recall-meta is not overwritten by text fallback', async () => {
    const { deriveResultSummary } = await import('../dist/domains/cats/services/tool-usage/derive-result-summary.js');
    const text = [
      'Evidence search request failed: Error: upstream response said No results found',
      '<recall-meta>{"resultStatus":"error","resultCount":null,"readNextHint":"Retry after memory service recovers."}</recall-meta>',
    ].join('\n');

    const result = deriveResultSummary('search_evidence', text);

    assert.equal(result.resultStatus, 'error');
    assert.equal(result.resultCount, null);
    assert.equal(result.isError, true);
    assert.equal(result.errorMessage, 'Evidence search request failed: Error: upstream response said No results found');
  });

  test('graph_resolve: explicit null resultCount in recall-meta is not overwritten by candidate count', async () => {
    const { deriveResultSummary } = await import('../dist/domains/cats/services/tool-usage/derive-result-summary.js');
    const text = [
      'Graph resolve failed: Error response echoed: Candidates for "memory" (3 matches, ranked by relevance):',
      '<recall-meta>{"resultStatus":"error","resultCount":null,"readNextHint":"Retry graph lookup."}</recall-meta>',
    ].join('\n');

    const result = deriveResultSummary('graph_resolve', text);

    assert.equal(result.resultStatus, 'error');
    assert.equal(result.resultCount, null);
    assert.equal(result.candidateCount, 3);
    assert.equal(result.isError, true);
  });

  test('list_recent: explicit null resultCount in recall-meta is not overwritten by recent count', async () => {
    const { deriveResultSummary } = await import('../dist/domains/cats/services/tool-usage/derive-result-summary.js');
    const text = [
      'List recent failed: Error response echoed: Recent items (last 7d): 5 found',
      '<recall-meta>{"resultStatus":"error","resultCount":null,"readNextHint":"Retry recent lookup."}</recall-meta>',
    ].join('\n');

    const result = deriveResultSummary('list_recent', text);

    assert.equal(result.resultStatus, 'error');
    assert.equal(result.resultCount, null);
    assert.equal(result.since, '7d');
    assert.equal(result.isError, true);
  });

  test('command_execution: parses command status and stdout for convention graph results', async () => {
    const { deriveResultSummary } = await import('../dist/domains/cats/services/tool-usage/derive-result-summary.js');
    const graphOutput = JSON.stringify({
      targets: [{ domainId: 'mcp-tool', filePath: 'packages/mcp-server/src/tools/callback-tools.ts' }],
      freshness: { stale: false },
    });
    const text = [
      'command: pnpm convention-graph:code-consumers -- --repo . --domain mcp-tool --kind mcp_tool',
      'status: completed',
      'exit_code: 0',
      graphOutput,
    ].join('\n');

    const result = deriveResultSummary('command_execution', text);

    assert.equal(result.command, 'pnpm convention-graph:code-consumers -- --repo . --domain mcp-tool --kind mcp_tool');
    assert.equal(result.status, 'completed');
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, graphOutput);
  });

  test('F282: recognizes a server-confirmed person-memory proposal result', async () => {
    const { deriveResultSummary } = await import('../dist/domains/cats/services/tool-usage/derive-result-summary.js');
    const result = deriveResultSummary(
      'propose_person_memory',
      JSON.stringify({
        candidateId: 'person_candidate_1',
        status: 'pending_approval',
        messageId: 'card_1',
      }),
    );

    assert.deepEqual(result, { proactiveMemoryOutcome: 'proposal_submitted' });
  });

  test('F282: recognizes only the local abstention success receipt', async () => {
    const { deriveResultSummary } = await import('../dist/domains/cats/services/tool-usage/derive-result-summary.js');

    assert.deepEqual(deriveResultSummary('record_proactive_memory_abstention', '{"status":"recorded"}'), {
      proactiveMemoryOutcome: 'abstention_recorded',
    });
    assert.deepEqual(
      deriveResultSummary(
        'record_proactive_memory_abstention',
        '{"status":"recorded","opportunityRef":"opp_0123456789abcdef0123456789abcdef"}',
      ),
      {},
    );
    assert.deepEqual(deriveResultSummary('record_proactive_memory_abstention', '{"status":"ok"}'), {});
  });

  test('F282: stale and callback failures cannot be merged as proposal success', async () => {
    const { deriveResultSummary } = await import('../dist/domains/cats/services/tool-usage/derive-result-summary.js');
    const stale = deriveResultSummary(
      'propose_person_memory',
      'Person-memory proposal was NOT created: this invocation has been superseded by a newer one (stale_ignored).',
    );
    const preflight = deriveResultSummary(
      'propose_person_memory',
      'Callback failed (422): person_memory_preflight_failed',
    );

    assert.equal(stale.isError, true);
    assert.equal(stale.proactiveMemoryOutcome, undefined);
    assert.equal(preflight.isError, true);
    assert.equal(preflight.proactiveMemoryOutcome, undefined);
  });

  test('F282: arbitrary successful-looking JSON remains unmerged', async () => {
    const { deriveResultSummary } = await import('../dist/domains/cats/services/tool-usage/derive-result-summary.js');

    assert.deepEqual(deriveResultSummary('propose_person_memory', '{"status":"pending_approval"}'), {});
    assert.deepEqual(
      deriveResultSummary(
        'propose_person_memory',
        '{"candidateId":"person_candidate_1","status":"pending_approval","messageId":"card_1","unexpected":true}',
      ),
      {},
    );
  });
});
