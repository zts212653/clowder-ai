import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  assertClosedWorldSetEquality,
  assertTasteAuthorityReadSet,
  indexedSourcePaths,
  loadContract,
  loadRuntimeCoordinates,
  validateContract,
} from '../helpers/taste-authority-contract.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'taste-authority-fixture-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, body) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  };
  write(
    'assets/memory-surfaces/taste/content-read.yaml',
    `v: 1
surfaceId: taste
authorityDirectory: docs/taste/vignettes
indexPath: docs/taste/index.md
indexHrefPrefix: vignettes/
sourceAnchorPrefix: "taste-vignette:"
readerContractRef: packages/api/src/domains/memory/taste/TasteMemoryReader.ts
`,
  );
  // This leaf represents the contract coordinate. The actual reader executes from dist below.
  write('packages/api/src/domains/memory/taste/TasteMemoryReader.ts', '// source-coordinate fixture\n');
  write('docs/taste/index.md', '[A](vignettes/fixture-a.md)\n[B](vignettes/fixture-b.md)\n');
  for (const name of ['fixture-a', 'fixture-b']) {
    write(
      `docs/taste/vignettes/${name}.md`,
      `---
when: "2000-01-01"
quotes: ["fixture-approved-quote"]
scene: "fixture-authority-scene"
tags: [fixture]
privacy: public
---
`,
    );
  }
  return root;
}

test('F221 Taste content/read contract rejects a drifted runtime anchor prefix', async (t) => {
  const root = fixture(t);
  const runtimeCoordinates = await loadRuntimeCoordinates();
  const contract = loadContract(root, runtimeCoordinates);
  assert.throws(
    () => validateContract({ ...contract, sourceAnchorPrefix: 'drifted-prefix:' }, runtimeCoordinates, root),
    /sourceAnchorPrefix/u,
  );
});

test('F221 Taste content/read contract rejects a non-reader source coordinate', async (t) => {
  const root = fixture(t);
  const runtimeCoordinates = await loadRuntimeCoordinates();
  const contract = loadContract(root, runtimeCoordinates);
  assert.throws(
    () =>
      validateContract(
        { ...contract, readerContractRef: 'docs/features/F221-taste-lane.md' },
        runtimeCoordinates,
        root,
      ),
    /readerContractRef/u,
  );
});

test('F221 Taste index rejects non-canonical Markdown href aliases', async (t) => {
  const contract = loadContract(fixture(t), await loadRuntimeCoordinates());
  assert.throws(() => indexedSourcePaths(contract, '[alias](vignettes/./visual-quality-ELI5-pcpjsd.md)'), /canonical/u);
  assert.throws(
    () => indexedSourcePaths(contract, '[private](../../private/taste/private-house-memory.md)'),
    /indexHrefPrefix|must use vignettes/u,
  );
});

test('F316 Taste closed-world equality fails on add, delete, rename, duplicate, dangling, or unreadable drift', () => {
  const canonical = ['docs/taste/vignettes/a.md', 'docs/taste/vignettes/b.md'];
  const driftCases = [
    {
      authorityPaths: [...canonical, 'docs/taste/vignettes/added.md'],
      indexPaths: canonical,
      readablePaths: canonical,
    },
    { authorityPaths: canonical, indexPaths: canonical.slice(0, 1), readablePaths: canonical },
    {
      authorityPaths: canonical,
      indexPaths: ['docs/taste/vignettes/a.md', 'docs/taste/vignettes/renamed.md'],
      readablePaths: canonical,
    },
    { authorityPaths: canonical, indexPaths: [...canonical, canonical[1]], readablePaths: canonical },
    {
      authorityPaths: canonical,
      indexPaths: [...canonical, 'docs/taste/vignettes/dangling.md'],
      readablePaths: canonical,
    },
    { authorityPaths: canonical, indexPaths: canonical, readablePaths: canonical.slice(0, 1) },
  ];
  for (const drift of driftCases) {
    assert.throws(() => assertClosedWorldSetEquality(drift));
  }
});

test('F221 explicit Taste authority, index and real reader outputs stay set-equal', async (t) => {
  const result = await assertTasteAuthorityReadSet(fixture(t));
  assert.deepEqual(result.readablePaths, ['docs/taste/vignettes/fixture-a.md', 'docs/taste/vignettes/fixture-b.md']);
});
