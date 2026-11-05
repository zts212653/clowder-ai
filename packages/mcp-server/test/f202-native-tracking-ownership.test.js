import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The installed package owns these names. Registering them in the Host MCP
// competes with the authenticated, activation-scoped native MCP contribution.
test('Host MCP leaves tracking tools to installed native contributions', async () => {
  const { createServer } = await import('../dist/index.js');
  const server = createServer();
  try {
    for (const name of [
      'cat_cafe_register_pr_tracking', // mcp-cutover-negative-reference: absence
      'cat_cafe_register_issue_tracking', // mcp-cutover-negative-reference: absence
      'cat_cafe_unregister_tracking', // mcp-cutover-negative-reference: absence
    ]) {
      assert.equal(Object.hasOwn(server._registeredTools, name), false, `${name} has a legacy Host owner`);
    }
    assert.ok(server._registeredTools.cat_cafe_register_deployment_wait, 'Host deployment wait remains available');
    assert.ok(server._registeredTools.cat_cafe_list_tasks, 'neutral task access remains available');
  } finally {
    await server.close();
  }
});

test('fixed admission truth roots follow C1 tool retirement and installed identities', async (t) => {
  const { resolveToolGovernanceEvidence } = await import('../dist/tool-governance-evidence.js');
  const evidence = await resolveToolGovernanceEvidence({
    repoRoot: fileURLToPath(new URL('../../../', import.meta.url)),
    refs: [],
  });
  const claims = [...evidence.admissionClaims.values()].flat();
  const acceptedNames = new Set(claims.map((claim) => claim.subject.toolName));
  const obsolete = [
    'cat_cafe_recover_external_review_verdict', // mcp-cutover-negative-reference: absence
    'cat_cafe_transfer_external_review', // mcp-cutover-negative-reference: absence
    'cat_cafe_collective_reply', // mcp-cutover-negative-reference: absence
    'cat_cafe_read_meeting_artifact', // mcp-cutover-negative-reference: absence
  ];
  for (const name of obsolete) {
    await t.test(`${name} has no accepted claim in any fixed truth root`, () => {
      assert.equal(acceptedNames.has(name), false);
    });
  }
  await t.test('installed replacement claims and same-name Collective capabilities remain accepted', async () => {
    const namesFor = (path) =>
      new Set(
        (evidence.admissionClaims.get(`file:docs/features/${path}`) ?? []).map((claim) => claim.subject.toolName),
      );
    const collectiveCutover = JSON.parse(
      await readFile(new URL('../governance/cutovers/f202-collective-participation.json', import.meta.url), 'utf8'),
    );
    // Host retirement does not withdraw identities still supplied by the installed plugin.
    assert.deepEqual(
      namesFor('F290-ai-native-collective.md'),
      new Set([
        ...collectiveCutover.retiredNames.filter((name) => !obsolete.includes(name)),
        'cat_cafe_collective_submit_reply',
      ]),
    );
    assert.deepEqual(namesFor('F292-feishu-meeting-intake-plugin.md'), new Set(['cat_cafe_meeting_records_read']));
    assert.equal(namesFor('F167-a2a-chain-quality.md').size, 5, 'core lifecycle admission claims remain');
    assert.equal(namesFor('F168-community-ops-board.md').size, 0, 'withdrawn transfer has no replacement claim');
  });
});
