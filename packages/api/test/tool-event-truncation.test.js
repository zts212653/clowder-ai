/**
 * F102 Issue 3: tool_result detail truncation must preserve enough text
 * for RecallFeed to parse search_evidence results.
 *
 * Bug: 220 char limit cuts off multi-result evidence output.
 * Structural guarantee: evidence-tools.ts caps each snippet to 200 chars
 * (line 119), so each result entry is bounded at ~280 chars.
 * 5 results = max ~1400 chars + header ≈ 1420. Limit 1500 covers this.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { truncateDetail, toStoredToolEvent } = await import(
  '../dist/domains/cats/services/agents/routing/route-helpers.js'
);

/** Build a realistic worst-case 5-result evidence output with max-length snippets */
function buildMaxLengthEvidence(count = 5) {
  const lines = [`Found ${count} result(s):`, ''];
  for (let i = 0; i < count; i++) {
    const conf = i < 2 ? 'high' : i < 4 ? 'mid' : 'low';
    const title = `Result Title That Is Reasonably Long Number ${i + 1}`;
    // evidence-tools.ts:119 caps snippets to 200 chars
    const snippet = 'A'.repeat(200);
    lines.push(`[${conf}] ${title}`);
    lines.push(`  anchor: some-anchor-${i + 1}`);
    lines.push(`  type: decision`);
    lines.push(`  > ${snippet}`);
    lines.push('');
  }
  return lines.join('\n');
}

describe('tool_result truncation (F102 Issue 3)', () => {
  it('preserves all 5 result headers with max-length snippets', () => {
    const evidence = buildMaxLengthEvidence(5);
    assert.ok(evidence.length > 800, `worst-case evidence is ${evidence.length} chars, exceeds old 800 limit`);

    const msg = {
      type: 'tool_result',
      catId: 'opus',
      content: evidence,
      timestamp: Date.now(),
    };
    const event = toStoredToolEvent(msg);
    assert.ok(event, 'should produce a StoredToolEvent');

    const resultHeaders = event.detail.match(/^\[(?:high|mid|low)\] .+$/gm) ?? [];
    assert.equal(
      resultHeaders.length,
      5,
      `should preserve all 5 result headers, got ${resultHeaders.length}. Detail length: ${event.detail.length}`,
    );
  });

  it('still truncates very long output beyond 1500', () => {
    const longText = 'x'.repeat(3000);
    const result = truncateDetail(longText, 1500);
    assert.ok(result.length <= 1501, 'should be truncated');
  });
});
