import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { digestMcpInputSchema, normalizeMcpInputSchema } from '../src/tool-governance-snapshot.js';
import {
  callbackTools,
  registerIssueTrackingInputSchema,
  registerPrTrackingInputSchema,
} from '../src/tools/callback-tools.js';

describe('#1394 public tracking schemas', () => {
  it('register_pr_tracking has no typed predicate, deadline, or renewal controls', () => {
    const schema = z.object(registerPrTrackingInputSchema).strict();
    const rejected = schema.safeParse({
      repoFullName: 'owner/repo',
      prNumber: 7,
      when: [{ kind: 'pr_conversation_comment_added' }],
    });
    assert.equal(rejected.success, false);
    const accepted = schema.safeParse({
      repoFullName: 'owner/repo',
      prNumber: 7,
      include: ['head_changed'],
      exclude: ['ci_terminal'],
    });
    assert.equal(accepted.success, true);
  });

  it('register_issue_tracking has no event-selection or deadline controls', () => {
    const schema = z.object(registerIssueTrackingInputSchema).strict();
    const rejected = schema.safeParse({
      repoFullName: 'owner/repo',
      issueNumber: 42,
      expiresAt: Date.now() + 60_000,
    });
    assert.equal(rejected.success, false);
  });

  it('does not expose a preview/typed-audience detour', () => {
    const preview = callbackTools.find((tool) => tool.name === 'cat_cafe_preview_github_tracking');
    assert.equal(preview, undefined);
  });

  /*
   * The canonical zod schema above is only half of the public contract. The committed MCP
   * surface baseline is what the governance surface ADVERTISES, and for a while it still
   * promised `when` and `expiresAt is required` after both had been deleted from the schema —
   * two published contracts, one of them a lie, and nothing in this repo noticed.
   *
   * The official regenerator (`tool-governance-cli write/check`) cannot run in this checkout:
   * its bootstrap attestation pins a `bootstrapFrom` commit from the private origin repository,
   * so the ancestry gate rejects both `write` and `check` here by design. This assertion is
   * therefore the only enforcement that actually executes, so it has to be the real comparison
   * — advertised property names against the live schema — not a spot-check of one string.
   */
  it('the committed MCP surface baseline advertises exactly the live tracking schemas', () => {
    const baselinePath = fileURLToPath(new URL('../governance/mcp-surface-baseline.json', import.meta.url));
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as {
      tools: { name: string; description?: string; inputSchema?: unknown; inputSchemaDigest?: string }[];
    };
    const live = [
      { name: 'cat_cafe_register_pr_tracking', schema: registerPrTrackingInputSchema },
      { name: 'cat_cafe_register_issue_tracking', schema: registerIssueTrackingInputSchema },
    ];
    for (const { name, schema } of live) {
      const entry = baseline.tools.find((tool) => tool.name === name);
      assert.ok(entry, `${name} missing from the committed MCP surface baseline`);
      // WHOLE schema, through the same normalizer the generator uses: property names alone would
      // still pass while required/optional, enums or bounds drifted, and a governance guard that
      // only compares key names is a guard you can walk straight through.
      assert.deepEqual(
        entry.inputSchema,
        normalizeMcpInputSchema(schema),
        `${name}: committed baseline schema differs from the live tool schema`,
      );
      assert.equal(entry.inputSchemaDigest, digestMcpInputSchema(schema), `${name}: schema digest is stale`);
    }
  });

  it('the baseline description does not promise a default set that no longer exists', () => {
    const baselinePath = fileURLToPath(new URL('../governance/mcp-surface-baseline.json', import.meta.url));
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as {
      tools: { name: string; description?: string }[];
    };
    const entry = baseline.tools.find((tool) => tool.name === 'cat_cafe_register_pr_tracking');
    const advertised = entry?.description ?? '';
    // Match the PARAMETER, not the English word: an earlier version of this assertion tripped on
    // "Use when:" in the prose, which is a guard that cries wolf rather than one that catches drift.
    for (const retired of [/`when`/, /\bwhen=/, /\bexpiresAt\b/, /pr_review_result_available/]) {
      assert.ok(!retired.test(advertised), `register_pr_tracking still advertises ${retired}`);
    }
    assert.ok(
      /bot_interaction/.test(advertised),
      'the role-dependent seventh event must be described, not silently implied',
    );
  });
});
