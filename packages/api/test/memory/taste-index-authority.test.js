import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { test } from 'node:test';
import { parse as parseYaml } from 'yaml';

const ROOT = resolve(import.meta.dirname, '../../../..');
const CONTRACT_PATH = 'assets/memory-surfaces/taste/content-read.yaml';

function validateContract(contract, runtimeCoordinates, root = ROOT) {
  assert.deepEqual(Object.keys(contract).sort(), [
    'authorityDirectory',
    'indexHrefPrefix',
    'indexPath',
    'readerContractRef',
    'sourceAnchorPrefix',
    'surfaceId',
    'v',
  ]);
  assert.equal(contract.v, 1);
  assert.equal(contract.surfaceId, 'taste');
  for (const field of [
    'authorityDirectory',
    'indexHrefPrefix',
    'indexPath',
    'readerContractRef',
    'sourceAnchorPrefix',
  ]) {
    assert.equal(typeof contract[field], 'string');
    assert.ok(contract[field].trim(), `${field} must be a non-empty string`);
  }
  assert.equal(
    contract.sourceAnchorPrefix,
    runtimeCoordinates.sourceAnchorPrefix,
    'sourceAnchorPrefix must equal the runtime Taste anchor prefix',
  );
  assert.equal(
    contract.readerContractRef,
    runtimeCoordinates.readerContractRef,
    'readerContractRef must equal the TasteMemoryReader source coordinate',
  );
  assert.ok(existsSync(resolve(root, contract.readerContractRef)), 'readerContractRef must resolve');
  return contract;
}

function loadContract(runtimeCoordinates) {
  return validateContract(parseYaml(readFileSync(resolve(ROOT, CONTRACT_PATH), 'utf8')), runtimeCoordinates);
}

async function loadRuntimeCoordinates() {
  const [catalog, reader] = await Promise.all([
    import('../../dist/domains/memory/cue/ExplicitApprovedTasteTriggerCatalog.js'),
    import('../../dist/domains/memory/taste/TasteMemoryReader.js'),
  ]);
  return {
    sourceAnchorPrefix: catalog.EXPLICIT_APPROVED_TASTE_SOURCE_ANCHOR_PREFIX,
    readerContractRef: reader.TASTE_MEMORY_READER_CONTRACT_REF,
  };
}

function houseSharedAuthorityPaths(authorityDirectory) {
  return readdirSync(resolve(ROOT, authorityDirectory), { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => `${authorityDirectory}/${entry.name}`)
    .sort();
}

function indexedSourcePaths(contract, content = readFileSync(resolve(ROOT, contract.indexPath), 'utf8')) {
  const hrefs = [...content.matchAll(/\]\(([^\n)]+\.md)\)/gu)].map((match) => match[1]);
  assert.ok(
    hrefs.every((href) => href.startsWith(contract.indexHrefPrefix)),
    `every Markdown anchor in ${contract.indexPath} must use ${contract.indexHrefPrefix}`,
  );
  assert.ok(
    hrefs.every((href) => href === `${contract.indexHrefPrefix}${posix.basename(href)}`),
    `every Markdown anchor in ${contract.indexPath} must use a canonical direct href`,
  );
  return hrefs.map((href) => posix.join(posix.dirname(contract.indexPath), href)).sort();
}

function assertClosedWorldSetEquality({ authorityPaths, indexPaths, readablePaths }) {
  assert.deepEqual(
    indexPaths,
    authorityPaths,
    'the generated Taste index must contain every authority file exactly once and no dangling source',
  );
  assert.deepEqual(
    readablePaths,
    authorityPaths,
    'every indexed Taste authority file must resolve through the owner-prescribed reader',
  );
}

test('F221 Taste content/read contract rejects a drifted runtime anchor prefix', async () => {
  const runtimeCoordinates = await loadRuntimeCoordinates();
  const contract = loadContract(runtimeCoordinates);
  assert.throws(
    () => validateContract({ ...contract, sourceAnchorPrefix: 'drifted-prefix:' }, runtimeCoordinates),
    /sourceAnchorPrefix/u,
  );
});

test('F221 Taste content/read contract rejects a non-reader source coordinate', async () => {
  const runtimeCoordinates = await loadRuntimeCoordinates();
  const contract = loadContract(runtimeCoordinates);
  assert.throws(
    () => validateContract({ ...contract, readerContractRef: 'docs/features/F221-taste-lane.md' }, runtimeCoordinates),
    /readerContractRef/u,
  );
});

test('F221 Taste index rejects non-canonical Markdown href aliases', async () => {
  const contract = loadContract(await loadRuntimeCoordinates());
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

test('F221 owner-prescribed Taste authority, index, and readable anchors stay set-equal', async (t) => {
  const contractExists = existsSync(resolve(ROOT, CONTRACT_PATH));
  const privateSurfaceExists = existsSync(resolve(ROOT, 'docs/taste'));
  if (!contractExists && !privateSurfaceExists) {
    t.skip('private Clowder AI Taste authority is not installed in this distribution');
    return;
  }
  assert.ok(contractExists, `${CONTRACT_PATH} is required when the Taste authority is installed`);

  const runtimeCoordinates = await loadRuntimeCoordinates();
  const contract = loadContract(runtimeCoordinates);
  const authorityPaths = houseSharedAuthorityPaths(contract.authorityDirectory);
  const indexPaths = indexedSourcePaths(contract);
  const authorityAnchors = authorityPaths.map((sourcePath) => `${contract.sourceAnchorPrefix}${sourcePath}`);
  const indexAnchors = indexPaths.map((sourcePath) => `${contract.sourceAnchorPrefix}${sourcePath}`);

  const { TasteMemoryReader } = await import('../../dist/domains/memory/taste/TasteMemoryReader.js');
  const repository = { canonicalRoot: () => ROOT };
  const reader = new TasteMemoryReader(repository, 'f221-authority-guard');
  const readable = authorityPaths.flatMap((sourcePath) => {
    const result = reader.read({ ownerUserId: 'f221-authority-guard', sourcePath });
    return result ? [result] : [];
  });
  assert.ok(readable.every((result) => /^sha256:[0-9a-f]{64}$/.test(result.revision)));
  assertClosedWorldSetEquality({
    authorityPaths: authorityAnchors,
    indexPaths: indexAnchors,
    readablePaths: readable.map((result) => `${contract.sourceAnchorPrefix}${result.sourcePath}`),
  });
});
