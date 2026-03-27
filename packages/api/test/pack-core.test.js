/**
 * F129 Pack Core Tests — PackStore + PackSecurityGuard + PackCompiler + PackLoader
 * Tests Tasks 2-5 in a single file (they share fixtures).
 */

import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';

const FIXTURES = join(import.meta.dirname, '__fixtures__');
const VALID_PACK = join(FIXTURES, 'valid-packs', 'quant-cats');
const MALICIOUS_INJECTION = join(FIXTURES, 'malicious-packs', 'prompt-injection');
const MALICIOUS_IDENTITY = join(FIXTURES, 'malicious-packs', 'identity-override');
const MALICIOUS_CAPS = join(FIXTURES, 'malicious-packs', 'capabilities-present');
const MALICIOUS_UNKNOWN = join(FIXTURES, 'malicious-packs', 'unknown-fields');
const MALICIOUS_RELAX = join(FIXTURES, 'malicious-packs', 'relaxation');

// ─── Dynamic imports after build ─────────────────────────────────────

async function loadModules() {
  const { PackStore } = await import('../dist/domains/packs/PackStore.js');
  const { PackSecurityGuard } = await import('../dist/domains/packs/PackSecurityGuard.js');
  const { PackCompiler } = await import('../dist/domains/packs/PackCompiler.js');
  const { PackLoader, PackSecurityError } = await import('../dist/domains/packs/PackLoader.js');
  return { PackStore, PackSecurityGuard, PackCompiler, PackLoader, PackSecurityError };
}

// ─── Temp directory management ───────────────────────────────────────

const tmpDirs = [];

async function createTmpDir() {
  const dir = await mkdtemp(join(tmpdir(), 'pack-test-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tmpDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
});

// ═══════════════════════════════════════════════════════════════════════
// PackStore
// ═══════════════════════════════════════════════════════════════════════

describe('PackStore', () => {
  test('install + get round-trips a valid pack', async () => {
    const { PackStore } = await loadModules();
    const storeDir = await createTmpDir();
    const store = new PackStore(storeDir);

    await store.install('quant-cats', VALID_PACK);
    const pack = await store.get('quant-cats');
    assert.ok(pack, 'Pack should be found after install');
    assert.equal(pack.manifest.name, 'quant-cats');
    assert.equal(pack.manifest.packType, 'domain');
  });

  test('list returns installed packs', async () => {
    const { PackStore } = await loadModules();
    const storeDir = await createTmpDir();
    const store = new PackStore(storeDir);

    await store.install('quant-cats', VALID_PACK);
    const packs = await store.list();
    assert.equal(packs.length, 1);
    assert.equal(packs[0].name, 'quant-cats');
  });

  test('remove deletes a pack', async () => {
    const { PackStore } = await loadModules();
    const storeDir = await createTmpDir();
    const store = new PackStore(storeDir);

    await store.install('quant-cats', VALID_PACK);
    const removed = await store.remove('quant-cats');
    assert.ok(removed);
    assert.ok(!(await store.has('quant-cats')));
  });

  test('get returns null for non-installed pack', async () => {
    const { PackStore } = await loadModules();
    const storeDir = await createTmpDir();
    const store = new PackStore(storeDir);

    const pack = await store.get('non-existent');
    assert.equal(pack, null);
  });

  test('install overwrites existing (upgrade)', async () => {
    const { PackStore } = await loadModules();
    const storeDir = await createTmpDir();
    const store = new PackStore(storeDir);

    await store.install('quant-cats', VALID_PACK);
    await store.install('quant-cats', VALID_PACK); // re-install
    const pack = await store.get('quant-cats');
    assert.ok(pack, 'Pack should still exist after re-install');
  });

  test('remove returns false for non-existent pack', async () => {
    const { PackStore } = await loadModules();
    const storeDir = await createTmpDir();
    const store = new PackStore(storeDir);

    const removed = await store.remove('ghost');
    assert.equal(removed, false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// PackSecurityGuard
// ═══════════════════════════════════════════════════════════════════════

describe('PackSecurityGuard', () => {
  test('accepts clean valid pack', async () => {
    const { PackSecurityGuard } = await loadModules();
    const guard = new PackSecurityGuard();
    const result = await guard.validate(VALID_PACK);
    assert.ok(result.ok, `Expected ok, got reasons: ${result.reasons.join('; ')}`);
  });

  test('rejects prompt injection in guardrails (AC-A7)', async () => {
    const { PackSecurityGuard } = await loadModules();
    const guard = new PackSecurityGuard();
    const result = await guard.validate(MALICIOUS_INJECTION);
    assert.ok(!result.ok, 'Should reject prompt injection');
    assert.ok(
      result.reasons.some((r) => r.includes('injection')),
      `Reasons: ${result.reasons.join('; ')}`,
    );
  });

  test('rejects identity override in masks (AC-A7)', async () => {
    const { PackSecurityGuard } = await loadModules();
    const guard = new PackSecurityGuard();
    const result = await guard.validate(MALICIOUS_IDENTITY);
    assert.ok(!result.ok, 'Should reject identity override');
    assert.ok(
      result.reasons.some((r) => r.includes('immutable identity field')),
      `Reasons: ${result.reasons.join('; ')}`,
    );
  });

  test('rejects capabilities/ directory (AC-A9)', async () => {
    const { PackSecurityGuard } = await loadModules();
    const guard = new PackSecurityGuard();
    const result = await guard.validate(MALICIOUS_CAPS);
    assert.ok(!result.ok, 'Should reject capabilities/');
    assert.ok(
      result.reasons.some((r) => r.includes('capabilities/')),
      `Reasons: ${result.reasons.join('; ')}`,
    );
  });

  test('rejects unknown fields in pack.yaml (AC-A8)', async () => {
    const { PackSecurityGuard } = await loadModules();
    const guard = new PackSecurityGuard();
    const result = await guard.validate(MALICIOUS_UNKNOWN);
    assert.ok(!result.ok, 'Should reject unknown fields');
    assert.ok(
      result.reasons.some((r) => r.includes('schema error')),
      `Reasons: ${result.reasons.join('; ')}`,
    );
  });

  test('rejects guardrail relaxation attempts', async () => {
    const { PackSecurityGuard } = await loadModules();
    const guard = new PackSecurityGuard();
    const result = await guard.validate(MALICIOUS_RELAX);
    assert.ok(!result.ok, 'Should reject relaxation');
    assert.ok(
      result.reasons.some((r) => r.includes('relaxation')),
      `Reasons: ${result.reasons.join('; ')}`,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════
// PackCompiler
// ═══════════════════════════════════════════════════════════════════════

describe('PackCompiler', () => {
  test('compiles valid pack into all block types', async () => {
    const { PackCompiler, PackStore } = await loadModules();
    const storeDir = await createTmpDir();
    const store = new PackStore(storeDir);
    await store.install('quant-cats', VALID_PACK);
    const pack = await store.get('quant-cats');
    assert.ok(pack);

    const compiler = new PackCompiler();
    const blocks = await compiler.compile(pack);

    assert.equal(blocks.packName, 'quant-cats');

    // Guardrails block
    assert.ok(blocks.guardrailBlock, 'Should have guardrail block');
    assert.ok(blocks.guardrailBlock.includes('硬约束'));
    assert.ok(blocks.guardrailBlock.includes('risk disclosure'));

    // Defaults block
    assert.ok(blocks.defaultsBlock, 'Should have defaults block');
    assert.ok(blocks.defaultsBlock.includes('默认行为'));
    assert.ok(blocks.defaultsBlock.includes('financial terminology'));

    // Masks block
    assert.ok(blocks.masksBlock, 'Should have masks block');
    assert.ok(blocks.masksBlock.includes('角色叠加'));
    assert.ok(blocks.masksBlock.includes('Quantitative Analyst'));

    // Workflows block
    assert.ok(blocks.workflowsBlock, 'Should have workflows block');
    assert.ok(blocks.workflowsBlock.includes('Research Workflow'));

    // World Driver summary
    assert.ok(blocks.worldDriverSummary, 'Should have world driver summary');
    assert.ok(blocks.worldDriverSummary.includes('hybrid'));
    assert.ok(blocks.worldDriverSummary.includes('只读摘要'));
  });

  test('guardrail block does NOT contain raw YAML', async () => {
    const { PackCompiler, PackStore } = await loadModules();
    const storeDir = await createTmpDir();
    const store = new PackStore(storeDir);
    await store.install('quant-cats', VALID_PACK);
    const pack = await store.get('quant-cats');

    const compiler = new PackCompiler();
    const blocks = await compiler.compile(pack);

    // Should be compiled markdown, not raw YAML
    assert.ok(!blocks.guardrailBlock.includes('constraints:'), 'Should not contain raw YAML keys');
    assert.ok(!blocks.guardrailBlock.includes('scope: all-cats'), 'Should not contain raw YAML');
  });

  test('knowledge/ produces no prompt block', async () => {
    const { PackCompiler, PackStore } = await loadModules();
    const storeDir = await createTmpDir();
    const store = new PackStore(storeDir);
    await store.install('quant-cats', VALID_PACK);
    const pack = await store.get('quant-cats');

    const compiler = new PackCompiler();
    const blocks = await compiler.compile(pack);

    // Knowledge should NOT appear in any block (pack-scoped RAG only)
    const allBlocks = [
      blocks.guardrailBlock,
      blocks.defaultsBlock,
      blocks.masksBlock,
      blocks.workflowsBlock,
      blocks.worldDriverSummary,
    ]
      .filter(Boolean)
      .join('\n');
    assert.ok(!allBlocks.includes('Finance Basics'), 'Knowledge content must not enter prompt blocks');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// PackLoader
// ═══════════════════════════════════════════════════════════════════════

describe('PackLoader', () => {
  test('loads pack from local directory', async () => {
    const { PackStore, PackSecurityGuard, PackLoader } = await loadModules();
    const storeDir = await createTmpDir();
    const store = new PackStore(storeDir);
    const guard = new PackSecurityGuard();
    const loader = new PackLoader(store, guard);

    const manifest = await loader.add(VALID_PACK);
    assert.equal(manifest.name, 'quant-cats');
    assert.ok(await store.has('quant-cats'));
  });

  test('rejects malicious pack at install (AC-A7)', async () => {
    const { PackStore, PackSecurityGuard, PackLoader, PackSecurityError } = await loadModules();
    const storeDir = await createTmpDir();
    const store = new PackStore(storeDir);
    const guard = new PackSecurityGuard();
    const loader = new PackLoader(store, guard);

    await assert.rejects(
      async () => loader.add(MALICIOUS_INJECTION),
      (err) => {
        assert.ok(err instanceof PackSecurityError);
        assert.ok(!err.result.ok);
        return true;
      },
    );
  });

  test('list and remove work through loader', async () => {
    const { PackStore, PackSecurityGuard, PackLoader } = await loadModules();
    const storeDir = await createTmpDir();
    const store = new PackStore(storeDir);
    const guard = new PackSecurityGuard();
    const loader = new PackLoader(store, guard);

    await loader.add(VALID_PACK);
    const list = await loader.list();
    assert.equal(list.length, 1);

    const removed = await loader.remove('quant-cats');
    assert.ok(removed);
    assert.equal((await loader.list()).length, 0);
  });

  test('rejects non-existent source path', async () => {
    const { PackStore, PackSecurityGuard, PackLoader } = await loadModules();
    const storeDir = await createTmpDir();
    const store = new PackStore(storeDir);
    const guard = new PackSecurityGuard();
    const loader = new PackLoader(store, guard);

    await assert.rejects(async () => loader.add('/non/existent/path'), /not found/);
  });

  test('rejects git URLs in Phase A (P2-2 review fix)', async () => {
    const { PackStore, PackSecurityGuard, PackLoader } = await loadModules();
    const storeDir = await createTmpDir();
    const store = new PackStore(storeDir);
    const guard = new PackSecurityGuard();
    const loader = new PackLoader(store, guard);

    await assert.rejects(async () => loader.add('https://github.com/example/pack.git'), /not supported in Phase A/);
    await assert.rejects(async () => loader.add('http://example.com/pack'), /not supported in Phase A/);
  });
});
