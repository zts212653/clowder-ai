import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { EvidenceRef } from '../src/tool-governance.js';
import { discoverAdmissionSourcePaths, resolveToolGovernanceEvidence } from '../src/tool-governance-evidence.js';

const sandboxes: string[] = [];

async function sandbox(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'f286-evidence-'));
  sandboxes.push(root);
  return root;
}

async function put(root: string, relativePath: string, content: string): Promise<void> {
  const path = join(root, relativePath);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content, 'utf8');
}

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('F286 governance evidence resolver', () => {
  it('resolves files, architecture cells, accepted ADRs, and exact subject-bound claims', async () => {
    const root = await sandbox();
    await put(root, 'packages/mcp-server/test/guard.test.ts', 'export {};\n');
    await put(
      root,
      'docs/architecture/ownership/cells/mcp-surface-governance.md',
      `---\ncell_id: mcp-surface-governance\ndoc_kind: architecture\ncreated: 2026-08-04\n---\n# Cell\n`,
    );
    await put(
      root,
      'docs/decisions/044-test.md',
      `---
adr: "044"
status: accepted
doc_kind: decision
created: 2026-08-04
mcp_admission_claims:
  - ref: "adr:44"
    toolName: cat_cafe_subject_update
    resourceFamily: subject
    boundaryKind: authority-boundary
    decision: accepted
---
# Accepted decision
`,
    );

    const refs = [
      'test:packages/mcp-server/test/guard.test.ts',
      'architecture-cell:mcp-surface-governance',
      'adr:44',
    ] as const satisfies readonly EvidenceRef[];
    const catalog = await resolveToolGovernanceEvidence({
      repoRoot: root,
      refs,
      admissionSourcePaths: ['docs/decisions/044-test.md'],
    });

    for (const ref of refs) assert.equal(catalog.existingRefs.has(ref), true, ref);
    const claims = catalog.admissionClaims.get('adr:44');
    assert.equal(claims?.length, 1);
    assert.deepEqual(claims?.[0].subject, {
      toolName: 'cat_cafe_subject_update',
      resourceFamily: 'subject',
      boundaryKind: 'authority-boundary',
    });
    assert.match(claims?.[0].sourceDigest ?? '', /^sha256:[a-f0-9]{64}$/);
  });

  it('discovers admission claims only from fixed accepted-truth roots', async () => {
    const root = await sandbox();
    await put(
      root,
      'docs/features/F999-subject.md',
      `---\nfeature_id: F999\ndoc_kind: feature\nmcp_admission_status: accepted\nmcp_admission_ref: "file:docs/features/F999-subject.md"\nmcp_admission_claims:\n  - ref: "file:docs/features/F999-subject.md"\n    toolName: cat_cafe_subject_create\n    resourceFamily: subject\n    boundaryKind: resource-entry\n    decision: accepted\n---\n# Subject\n`,
    );
    await put(
      root,
      'docs/plans/ignored.md',
      `---\ndoc_kind: plan\nmcp_admission_claims:\n  - ref: "file:docs/plans/ignored.md"\n---\n# Not an admission truth root\n`,
    );

    assert.deepEqual(await discoverAdmissionSourcePaths(root), ['docs/features/F999-subject.md']);
    const catalog = await resolveToolGovernanceEvidence({
      repoRoot: root,
      refs: ['file:docs/features/F999-subject.md'],
    });
    assert.equal(
      catalog.admissionClaims.get('file:docs/features/F999-subject.md')?.[0].subject.toolName,
      'cat_cafe_subject_create',
    );
  });

  it('does not accept a claim merely because its document exists', async () => {
    const root = await sandbox();
    await put(
      root,
      'docs/decisions/044-proposed.md',
      `---
adr: "044"
status: proposed
doc_kind: decision
created: 2026-08-04
mcp_admission_claims:
  - ref: "adr:44"
    toolName: cat_cafe_subject_update
    resourceFamily: subject
    boundaryKind: authority-boundary
    decision: accepted
---
# Proposed decision
`,
    );

    await assert.rejects(
      resolveToolGovernanceEvidence({
        repoRoot: root,
        refs: ['adr:44'],
        admissionSourcePaths: ['docs/decisions/044-proposed.md'],
      }),
      /not accepted/i,
    );
  });

  it('requires message references to have a durable in-repo provenance record', async () => {
    const root = await sandbox();
    const messageRef = 'message:0001785600399637-001062-9b03f289' as const;

    const missing = await resolveToolGovernanceEvidence({ repoRoot: root, refs: [messageRef] });
    assert.equal(missing.existingRefs.has(messageRef), false);

    await put(
      root,
      'docs/provenance/messages/0001785600399637-001062-9b03f289.md',
      `---\ndoc_kind: provenance\ncreated: 2026-08-04\nsource_message_id: 0001785600399637-001062-9b03f289\n---\n# Durable source\n`,
    );
    const present = await resolveToolGovernanceEvidence({ repoRoot: root, refs: [messageRef] });
    assert.equal(present.existingRefs.has(messageRef), true);
  });

  it('rejects malformed or unbound admission records', async () => {
    const root = await sandbox();
    await put(
      root,
      'docs/decisions/044-malformed.md',
      `---
adr: "044"
status: accepted
doc_kind: decision
created: 2026-08-04
mcp_admission_claims:
  - ref: "adr:45"
    toolName: cat_cafe_subject_update
    resourceFamily: subject
    boundaryKind: authority-boundary
    decision: accepted
---
# Wrong source binding
`,
    );

    await assert.rejects(
      resolveToolGovernanceEvidence({
        repoRoot: root,
        refs: ['adr:44'],
        admissionSourcePaths: ['docs/decisions/044-malformed.md'],
      }),
      /must match its source/i,
    );
  });
});
