import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { loadPawFeelSourceFindingArtifactSnapshot } from '../../dist/infrastructure/harness-eval/paw-feel-disposition/continuation/source-case-artifact-snapshot.js';
import {
  scanLifecycleRootArtifacts,
  scanLifecycleRootArtifactsAsync,
} from '../../dist/infrastructure/harness-eval/publish-verdict/lifecycle-root-artifact.js';
import {
  cleanupSourceCaseFixtures,
  harnessState,
  projection,
  writeCase,
} from './helpers/paw-feel-source-case-fixture.js';

afterEach(cleanupSourceCaseFixtures);

async function editRoot(root, verdictId, edit) {
  const path = join(root, 'bundles', verdictId, 'lifecycle-root.json');
  const value = JSON.parse(await readFile(path, 'utf8'));
  edit(value);
  await writeFile(path, JSON.stringify(value));
}

describe('asynchronous inbox artifact snapshot boundaries', () => {
  it('preserves CLI ordering and v1/v2/v3 validation across multiple IO batches', async () => {
    const specs = Array.from({ length: 19 }, (_, index) => ({
      findingKey: `key-${index}`,
      verdictId: `verdict-${index}`,
    }));
    const { root } = await harnessState(specs);
    await editRoot(root, 'verdict-0', (value) => {
      value.schemaVersion = 1;
      for (const key of ['caseId', 'findingKey', 'findingBinding', 'repairTarget']) delete value[key];
    });
    await editRoot(root, 'verdict-1', (value) => {
      value.schemaVersion = 2;
      delete value.findingBinding;
      delete value.repairTarget;
    });
    await mkdir(join(root, 'bundles', 'not-yet-published'));
    await writeFile(join(root, 'bundles', 'ordinary-file'), 'not a bundle');

    const roots = await scanLifecycleRootArtifactsAsync(root);
    assert.deepEqual(roots, scanLifecycleRootArtifacts(root));
    assert.equal(roots.length, 19);
    assert.deepEqual(
      roots.map((value) => value.verdictId),
      specs.map((value) => value.verdictId).sort((a, b) => a.localeCompare(b)),
    );
    const records = await loadPawFeelSourceFindingArtifactSnapshot(root);
    assert.equal(records.length, 17);
    assert.ok(
      records.every((record) => record.root.schemaVersion === 3 && record.digestVerified && record.sourceRefsValid),
    );
  });

  it('treats an absent bundles directory as empty', async () => {
    const { root } = await harnessState();
    await rm(join(root, 'bundles'), { recursive: true });
    assert.deepEqual(await scanLifecycleRootArtifactsAsync(root), []);
  });

  it('rejects corrupt roots and directory identity mismatches rather than returning partial success', async () => {
    const state = await harnessState([{ findingKey: 'valid', verdictId: 'valid' }]);
    await mkdir(join(state.root, 'bundles', 'broken'));
    const path = join(state.root, 'bundles', 'broken', 'lifecycle-root.json');
    await writeFile(path, '{');
    const first = state.resolver.snapshot();
    await assert.rejects(first.resolve({ projection }), SyntaxError);
    assert.throws(() => scanLifecycleRootArtifacts(state.root), SyntaxError);
    await rm(join(state.root, 'bundles', 'broken'), { recursive: true });
    await assert.rejects(first.resolve({ projection }), SyntaxError);
    assert.equal((await state.resolver.snapshot().resolve({ projection })).kind, 'approval_required');

    await editRoot(state.root, 'valid', (value) => {
      value.verdictId = 'another-directory';
    });
    await assert.rejects(scanLifecycleRootArtifactsAsync(state.root), /does not match bundle directory/);
    assert.throws(() => scanLifecycleRootArtifacts(state.root), /does not match bundle directory/);
  });

  it('keeps untrusted finding bytes out of joins while retaining auditable stale digests', async () => {
    const specs = ['valid', 'missing', 'malformed', 'escape', 'digest'].map((name) => ({
      findingKey: name,
      verdictId: name,
    }));
    const state = await harnessState(specs);
    const outside = await harnessState([{ findingKey: 'escape', verdictId: 'escape' }]);
    await rm(join(state.root, 'bundles', 'missing', 'finding.json'));
    await writeFile(join(state.root, 'bundles', 'malformed', 'finding.json'), '{}');
    await editRoot(state.root, 'escape', (value) => {
      value.findingBinding.artifactRef = join(outside.root, 'bundles', 'escape', 'finding.json');
    });
    await editRoot(state.root, 'digest', (value) => {
      value.findingBinding.artifactSha256 = 'b'.repeat(64);
    });

    const records = await loadPawFeelSourceFindingArtifactSnapshot(state.root);
    assert.deepEqual(
      records.map((record) => [record.root.verdictId, record.digestVerified]),
      [
        ['digest', false],
        ['valid', true],
      ],
    );
    assert.equal((await state.resolver.snapshot().resolve({ projection })).caseActionRef, 'case-action:valid');
  });

  it('pins artifact membership only for one request and admits newly published findings on the next', async () => {
    const state = await harnessState();
    const first = state.resolver.snapshot();
    assert.equal((await first.resolve({ projection })).kind, 'analysis_required');
    const value = await writeCase(state.root, 'new', 'new');
    state.events.set(value.caseId, [
      {
        type: 'case_ready_for_proposal',
        caseId: value.caseId,
        verdictId: value.verdictId,
        caseActionRef: 'case-action:new',
        findingArtifactRef: value.artifactRef,
        occurredAt: '2026-09-01T00:00:01.000Z',
      },
    ]);
    assert.equal((await first.resolve({ projection })).kind, 'analysis_required');
    assert.equal((await state.resolver.snapshot().resolve({ projection })).caseActionRef, 'case-action:new');
  });
});
