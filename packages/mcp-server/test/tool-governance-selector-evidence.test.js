import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { discoverAdmissionSourcePaths, resolveToolGovernanceEvidence } from '../dist/tool-governance-evidence.js';

const path = 'docs/architecture/ownership/cells/mcp-surface-governance.md';
const ref = 'architecture-cell:mcp-surface-governance';
function truth({ status = 'accepted', claimRef = ref, role = 'read-strategy' } = {}) {
  return `---\ncell_id: mcp-surface-governance\ndoc_kind: architecture\nmcp_selector_status: ${status}\nmcp_selector_claims:\n  - ref: ${claimRef}\n    toolName: cat_cafe_search_evidence\n    resourceFamily: evidence-navigation\n    field: mode\n    role: ${role}\n    decision: accepted\n---\n# Accepted read strategy\n`;
}
async function fixture(content, run) {
  const root = await mkdtemp(join(tmpdir(), 'f286-read-selector-'));
  try {
    await mkdir(join(root, 'docs/architecture/ownership/cells'), { recursive: true });
    await writeFile(join(root, path), content);
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
it('resolves an accepted selector from architecture truth with exact subject and source digest', async () => {
  const content = truth();
  await fixture(content, async (repoRoot) => {
    assert.deepEqual(await discoverAdmissionSourcePaths(repoRoot), [path]);
    const catalog = await resolveToolGovernanceEvidence({ repoRoot, refs: [ref] });
    assert.equal(catalog.existingRefs.has(ref), true);
    assert.deepEqual(catalog.selectorClaims.get(ref), [
      {
        ref,
        decision: 'accepted',
        sourceDigest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
        subject: {
          toolName: 'cat_cafe_search_evidence',
          resourceFamily: 'evidence-navigation',
          field: 'mode',
          role: 'read-strategy',
        },
      },
    ]);
  });
});
it('cannot turn an unrelated existing path into subject-bound selector admission', async () => {
  await fixture(truth({ claimRef: 'test:packages/mcp-server/test/message-search-tools.test.js' }), async (repoRoot) => {
    await assert.rejects(resolveToolGovernanceEvidence({ repoRoot, refs: [ref] }), /match its accepted source/);
  });
});
it('rejects proposed decisions and unknown selector roles', async () => {
  for (const options of [{ status: 'proposed' }, { role: 'write-strategy' }]) {
    await fixture(truth(options), async (repoRoot) => {
      await assert.rejects(resolveToolGovernanceEvidence({ repoRoot, refs: [ref] }), /accepted/);
    });
  }
});

it('rejects another document impersonating the canonical architecture evidence address', async () => {
  await fixture(truth(), async (repoRoot) => {
    await writeFile(join(repoRoot, 'docs/architecture/ownership/cells/impostor.md'), truth());
    await assert.rejects(resolveToolGovernanceEvidence({ repoRoot, refs: [ref] }), /canonical source path/);
  });
});
