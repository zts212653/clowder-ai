import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { createServer } = await import('../dist/index.js');

/**
 * sol reproduced this live: registering with `when` / `expiresAt` returned success and the
 * keys were silently stripped. The existing contract tests passed only because they wrapped
 * the raw shape in `.strict()` themselves — they asserted a strictness the server never
 * applied. So this suite reads the schema the SERVER registered, not one a test built.
 *
 * Silently dropping a retired parameter is the #1392 defect verbatim: the caller believes it
 * asked for something, and the failure shows up as no notification rather than an error.
 */
function registeredSchema(toolName) {
  const server = createServer();
  const tools = server._registeredTools ?? {};
  const tool = tools[toolName];
  assert.ok(tool, `${toolName} must be registered; got ${Object.keys(tools).slice(0, 5).join(', ')}`);
  return tool.inputSchema;
}

const RETIRED = [
  ['when', [{ kind: 'pr_ci_terminal' }]],
  ['expiresAt', Date.now() + 60_000],
  ['autoRenew', true],
  ['triggerCommentId', 4936000001],
];

describe('F280 — the registered PR tracking schema rejects retired parameters', () => {
  for (const [key, value] of RETIRED) {
    it(`rejects \`${key}\` instead of dropping it`, () => {
      const result = registeredSchema('cat_cafe_register_pr_tracking').safeParse({
        repoFullName: 'zts212653/clowder-ai',
        prNumber: 1394,
        [key]: value,
      });
      assert.equal(result.success, false, `\`${key}\` was accepted and silently stripped`);
    });
  }

  it('still accepts the two-argument contract', () => {
    const result = registeredSchema('cat_cafe_register_pr_tracking').safeParse({
      repoFullName: 'zts212653/clowder-ai',
      prNumber: 1394,
    });
    assert.equal(result.success, true, 'the supported shape must keep working');
  });
});

describe('F280 — the registered issue tracking schema rejects retired parameters', () => {
  it('rejects `when` instead of dropping it', () => {
    const result = registeredSchema('cat_cafe_register_issue_tracking').safeParse({
      repoFullName: 'zts212653/clowder-ai',
      issueNumber: 1392,
      when: [{ kind: 'issue_comment_added' }],
    });
    assert.equal(result.success, false, '`when` was accepted and silently stripped');
  });

  it('still accepts the two-argument contract', () => {
    const result = registeredSchema('cat_cafe_register_issue_tracking').safeParse({
      repoFullName: 'zts212653/clowder-ai',
      issueNumber: 1392,
    });
    assert.equal(result.success, true, 'the supported shape must keep working');
  });
});
