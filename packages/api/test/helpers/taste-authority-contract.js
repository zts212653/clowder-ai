import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

const CONTRACT_PATH = 'assets/memory-surfaces/taste/content-read.yaml';

export function validateContract(contract, runtimeCoordinates, root) {
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

export function loadContract(root, runtimeCoordinates) {
  return validateContract(parseYaml(readFileSync(resolve(root, CONTRACT_PATH), 'utf8')), runtimeCoordinates, root);
}

export async function loadRuntimeCoordinates() {
  const [catalog, reader] = await Promise.all([
    import('../../dist/domains/memory/cue/ExplicitApprovedTasteTriggerCatalog.js'),
    import('../../dist/domains/memory/taste/TasteMemoryReader.js'),
  ]);
  return {
    sourceAnchorPrefix: catalog.EXPLICIT_APPROVED_TASTE_SOURCE_ANCHOR_PREFIX,
    readerContractRef: reader.TASTE_MEMORY_READER_CONTRACT_REF,
  };
}

function authoritySourcePaths(root, authorityDirectory) {
  return readdirSync(resolve(root, authorityDirectory), { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => `${authorityDirectory}/${entry.name}`)
    .sort();
}

export function indexedSourcePaths(contract, content) {
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

export function assertClosedWorldSetEquality({ authorityPaths, indexPaths, readablePaths }) {
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

export async function assertTasteAuthorityReadSet(root) {
  const runtimeCoordinates = await loadRuntimeCoordinates();
  const contract = loadContract(root, runtimeCoordinates);
  const authorityPaths = authoritySourcePaths(root, contract.authorityDirectory);
  const indexPaths = indexedSourcePaths(contract, readFileSync(resolve(root, contract.indexPath), 'utf8'));
  const authorityAnchors = authorityPaths.map((sourcePath) => `${contract.sourceAnchorPrefix}${sourcePath}`);
  const indexAnchors = indexPaths.map((sourcePath) => `${contract.sourceAnchorPrefix}${sourcePath}`);

  const { TasteMemoryReader } = await import('../../dist/domains/memory/taste/TasteMemoryReader.js');
  const repository = { canonicalRoot: () => root };
  const reader = new TasteMemoryReader(repository, 'f221-authority-guard');
  const readable = [];
  for (const sourcePath of authorityPaths) {
    const result = await reader.read({ ownerUserId: 'f221-authority-guard', sourcePath });
    if (result) readable.push(result);
  }
  assert.ok(readable.every((result) => /^sha256:[0-9a-f]{64}$/.test(result.revision)));
  assertClosedWorldSetEquality({
    authorityPaths: authorityAnchors,
    indexPaths: indexAnchors,
    readablePaths: readable.map((result) => `${contract.sourceAnchorPrefix}${result.sourcePath}`),
  });
  assert.ok(authorityPaths.length > 0, 'an installed authority must contain readable sources');
  return { authorityPaths, indexPaths, readablePaths: readable.map((item) => item.sourcePath) };
}
