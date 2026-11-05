/**
 * F129 Integration Test — End-to-End Pack Pipeline
 * AC coverage: AC-A1 through AC-A10
 *
 * install → security scan → compile → inject into SystemPromptBuilder
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';

const FIXTURES = join(import.meta.dirname, '__fixtures__');
const VALID_PACK = join(FIXTURES, 'valid-packs', 'quant-cats');
const MALICIOUS_INJECTION = join(FIXTURES, 'malicious-packs', 'prompt-injection');
const MALICIOUS_CAPS = join(FIXTURES, 'malicious-packs', 'capabilities-present');

const tmpDirs = [];

async function createTmpDir() {
  const dir = await mkdtemp(join(tmpdir(), 'pack-e2e-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tmpDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
});

describe('F129 End-to-End: Pack Pipeline', () => {
  test('install → compile → inject → verify prompt (AC-A1~A6)', async () => {
    const { PackStore } = await import('../dist/domains/packs/PackStore.js');
    const { PackSecurityGuard } = await import('../dist/domains/packs/PackSecurityGuard.js');
    const { PackLoader } = await import('../dist/domains/packs/PackLoader.js');
    const { PackCompiler } = await import('../dist/domains/packs/PackCompiler.js');
    const { buildSystemPrompt } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');

    // 1. Install via PackLoader (AC-A4)
    const storeDir = await createTmpDir();
    const store = new PackStore(storeDir);
    const guard = new PackSecurityGuard();
    const loader = new PackLoader(store, guard);

    const manifest = await loader.add(VALID_PACK);
    assert.equal(manifest.name, 'quant-cats'); // AC-A1: schema works
    assert.equal(manifest.packType, 'domain');

    // 2. List installed packs (AC-A5)
    const list = await loader.list();
    assert.equal(list.length, 1);

    // 3. Compile pack (AC-A3)
    const pack = await store.get('quant-cats');
    assert.ok(pack);
    const compiler = new PackCompiler();
    const blocks = await compiler.compile(pack);

    assert.equal(blocks.packName, 'quant-cats');
    assert.ok(blocks.guardrailBlock);
    assert.ok(blocks.defaultsBlock);
    assert.ok(blocks.masksBlock);
    assert.ok(blocks.workflowsBlock);
    assert.ok(blocks.worldDriverSummary);

    // 4. Inject into SystemPromptBuilder (AC-A6 dual-track)
    const prompt = buildSystemPrompt({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
      packBlocks: blocks,
    });

    // Guardrails in prompt (hard constraint track)
    assert.ok(prompt.includes('硬约束'), 'Prompt should include guardrail block');
    assert.ok(prompt.includes('risk disclosure'), 'Guardrail content should be present');

    // Defaults in prompt (soft default track)
    assert.ok(prompt.includes('默认行为'), 'Prompt should include defaults block');
    assert.ok(prompt.includes('financial terminology'), 'Default content should be present');

    // Masks in prompt
    assert.ok(prompt.includes('角色叠加'), 'Prompt should include masks block');
    assert.ok(prompt.includes('Quantitative Analyst'), 'Mask overlay should be present');

    // World Driver summary (read-only)
    assert.ok(prompt.includes('世界引擎'), 'Prompt should include world driver summary');
    assert.ok(prompt.includes('hybrid'), 'World driver resolver type should be present');

    // Core identity still present (not overwritten by pack)
    assert.ok(prompt.includes('布偶猫'), 'Core identity must survive pack injection');

    // No raw YAML in prompt
    assert.ok(!prompt.includes('constraints:'), 'No raw YAML keys in prompt');

    // Knowledge NOT in prompt (AC-A10)
    assert.ok(!prompt.includes('Finance Basics'), 'Knowledge content must not enter prompt');
  });

  test('malicious pack is rejected at install (AC-A7)', async () => {
    const { PackStore } = await import('../dist/domains/packs/PackStore.js');
    const { PackSecurityGuard } = await import('../dist/domains/packs/PackSecurityGuard.js');
    const { PackLoader, PackSecurityError } = await import('../dist/domains/packs/PackLoader.js');

    const storeDir = await createTmpDir();
    const store = new PackStore(storeDir);
    const guard = new PackSecurityGuard();
    const loader = new PackLoader(store, guard);

    await assert.rejects(
      async () => loader.add(MALICIOUS_INJECTION),
      (err) => {
        assert.ok(err instanceof PackSecurityError, 'Should throw PackSecurityError');
        assert.ok(!err.result.ok, 'Result should not be ok');
        assert.ok(
          err.result.reasons.some((r) => r.includes('injection')),
          `Should mention injection: ${err.result.reasons.join('; ')}`,
        );
        return true;
      },
    );

    // Pack should NOT be installed
    assert.ok(!(await store.has('prompt-injection-pack')));
  });

  test('pack with capabilities/ is rejected (AC-A9)', async () => {
    const { PackStore } = await import('../dist/domains/packs/PackStore.js');
    const { PackSecurityGuard } = await import('../dist/domains/packs/PackSecurityGuard.js');
    const { PackLoader, PackSecurityError } = await import('../dist/domains/packs/PackLoader.js');

    const storeDir = await createTmpDir();
    const store = new PackStore(storeDir);
    const guard = new PackSecurityGuard();
    const loader = new PackLoader(store, guard);

    await assert.rejects(
      async () => loader.add(MALICIOUS_CAPS),
      (err) => {
        assert.ok(err instanceof PackSecurityError);
        assert.ok(
          err.result.reasons.some((r) => r.includes('capabilities/')),
          `Should mention capabilities/: ${err.result.reasons.join('; ')}`,
        );
        return true;
      },
    );
  });

  test('dual-track priority: guardrails after governance, defaults after guardrails (AC-A6)', async () => {
    const { PackStore } = await import('../dist/domains/packs/PackStore.js');
    const { PackSecurityGuard } = await import('../dist/domains/packs/PackSecurityGuard.js');
    const { PackLoader } = await import('../dist/domains/packs/PackLoader.js');
    const { PackCompiler } = await import('../dist/domains/packs/PackCompiler.js');
    const { buildSystemPrompt } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');

    const storeDir = await createTmpDir();
    const store = new PackStore(storeDir);
    const guard = new PackSecurityGuard();
    const loader = new PackLoader(store, guard);

    await loader.add(VALID_PACK);
    const pack = await store.get('quant-cats');
    const compiler = new PackCompiler();
    const blocks = await compiler.compile(pack);

    const prompt = buildSystemPrompt({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
      packBlocks: blocks,
    });

    const identityPos = prompt.indexOf('布偶猫');
    const masksPos = prompt.indexOf('角色叠加');
    const govPos = prompt.indexOf('家规');
    const guardrailPos = prompt.indexOf('硬约束');
    const defaultsPos = prompt.indexOf('默认行为');

    // Priority order: Identity > Masks > Governance > Pack Guardrails > Pack Defaults
    assert.ok(identityPos < masksPos, 'Identity before masks');
    assert.ok(masksPos < govPos, 'Masks before governance');
    assert.ok(govPos < guardrailPos, 'Governance before pack guardrails');
    assert.ok(guardrailPos < defaultsPos, 'Pack guardrails before pack defaults');
  });

  test('remove uninstalls pack (AC-A5)', async () => {
    const { PackStore } = await import('../dist/domains/packs/PackStore.js');
    const { PackSecurityGuard } = await import('../dist/domains/packs/PackSecurityGuard.js');
    const { PackLoader } = await import('../dist/domains/packs/PackLoader.js');

    const storeDir = await createTmpDir();
    const store = new PackStore(storeDir);
    const guard = new PackSecurityGuard();
    const loader = new PackLoader(store, guard);

    await loader.add(VALID_PACK);
    assert.ok(await store.has('quant-cats'));

    const removed = await loader.remove('quant-cats');
    assert.ok(removed);
    assert.ok(!(await store.has('quant-cats')));
    assert.equal((await loader.list()).length, 0);
  });
});
