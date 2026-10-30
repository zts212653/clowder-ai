import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../../scripts/compile-system-prompt-l0.mjs', import.meta.url));
const data = {
  schemaVersion: 1,
  compilerVersion: 'member-l0/v1',
  catId: 'frozen-only-member',
  projection: 'owner',
  template: '{{L1_CONTENT}}\n{{IDENTITY_BLOCK}}\n{{USER_CAPSULE}}',
  sections: { L1_CONTENT: 'captured rule' },
  variables: { IDENTITY_BLOCK: 'captured role', USER_CAPSULE: '{{IDENTITY_BLOCK}} stays opaque' },
};
function input(value = data) {
  return { ...value, inputDigest: createHash('sha256').update(JSON.stringify(value)).digest('hex') };
}
function render(snapshot) {
  return spawnSync(process.execPath, [script, '--frozen-input'], {
    encoding: 'utf8',
    input: JSON.stringify(snapshot),
    env: {
      ...process.env,
      CAT_TEMPLATE_PATH: 'Z:/nonexistent-catalog.json',
      CAT_CAFE_DATA_DIR: 'Z:/nonexistent-profile',
    },
    timeout: 20_000,
  });
}

test('the real L0 child renders captured bytes without loading a live registry or owner profile', () => {
  const result = render(input());
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'captured rule\ncaptured role\n{{IDENTITY_BLOCK}} stays opaque');
});

test('the frozen child rejects a changed input digest and unsupported compiler generation', () => {
  const changed = input();
  changed.variables = { ...changed.variables, IDENTITY_BLOCK: 'changed after admission' };
  assert.notEqual(render(changed).status, 0);
  assert.match(render(changed).stderr, /digest/i);
  assert.notEqual(render(input({ ...data, compilerVersion: 'unrecognized/v9' })).status, 0);
});

test('a required frozen compile cannot silently use live mode', async () => {
  const { compileL0ViaSubprocess } = await import('../dist/domains/cats/services/agents/providers/l0-compiler.js');
  await assert.rejects(
    compileL0ViaSubprocess({ catId: 'frozen-only-member', requireFrozenInput: true }),
    /frozen.*required/i,
  );
});

test('parent capture preserves the existing owner/public L0 output and actual child consumes only that input', async () => {
  await import('./helpers/setup-cat-registry.js');
  const { catRegistry } = await import('@cat-cafe/shared');
  const { captureFrozenL0Input } = await import('@cat-cafe/shared/l0-input-capture');
  const { compileL0 } = await import('../../../scripts/compile-system-prompt-l0.mjs');
  const { loadCatConfig, isCatAvailable, getCoCreatorConfig } = await import('../dist/config/cat-config-loader.js');
  const { getCatModel } = await import('../dist/config/cat-models.js');
  const { loadCompiledGovernanceL0Sync } = await import('../dist/domains/cats/services/context/governance-l0.js');
  const { clearL0Cache, compileL0ViaSubprocess } = await import(
    '../dist/domains/cats/services/agents/providers/l0-compiler.js'
  );
  const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const profileDir = mkdtempSync(join(tmpdir(), 'frozen-l0-profile-'));
  const config = loadCatConfig();
  const all = catRegistry.getAllConfigs();
  clearL0Cache();
  for (const projection of ['owner', 'public']) {
    const snapshot = captureFrozenL0Input({
      catId: 'codex',
      member: all.codex,
      model: getCatModel('codex'),
      teammates: Object.entries(all)
        .filter(([id]) => isCatAvailable(id, config))
        .map(([catId, member]) => ({ catId, config: member, model: getCatModel(catId) })),
      coCreator: getCoCreatorConfig(config),
      installRoot: projectRoot,
      overlayRoot: projectRoot,
      profileDir,
      dossierRoot: projectRoot,
      projection,
      governanceText: projection === 'owner' ? loadCompiledGovernanceL0Sync(projectRoot).content : undefined,
    });
    const legacy = await compileL0({ catId: 'codex', profileDir, dossierRoot: projectRoot, projection });
    const actual = await compileL0ViaSubprocess({
      catId: 'codex',
      userId: 'isolated-owner',
      projection,
      frozenInput: snapshot,
      requireFrozenInput: true,
    });
    assert.equal(actual.replace(/\r\n/g, '\n'), legacy.replace(/\r\n/g, '\n'));
    assert.equal(Object.isFrozen(snapshot.variables), true);
  }
  console.log(`Retained isolated frozen L0 profile: ${profileDir}`);
});
