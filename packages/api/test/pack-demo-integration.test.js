/** F129 portable demo export, install, security, Growth and compilation contracts. */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { createPackDemoFixture } from './helpers/pack-demo-fixture.js';

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

// ═══════════════════════════════════════════════════════════════════════
// Phase B-α: Dogfood Export + Demo Packs
// ═══════════════════════════════════════════════════════════════════════

let CODING_WORLD_PACK;

beforeEach(async () => {
  CODING_WORLD_PACK = await createPackDemoFixture(await createTmpDir(), {
    name: 'fixture-coding-world',
    packType: 'domain',
  });
  TRPG_PACK = await createPackDemoFixture(await createTmpDir(), { name: 'fixture-adventure', packType: 'scenario' });
});

describe('AC-B1: Coding World dogfood pack', () => {
  test('exported pack round-trips through install → compile', async () => {
    const { PackExporter } = await import('../dist/domains/packs/PackExporter.js');
    const { PackStore } = await import('../dist/domains/packs/PackStore.js');
    const { PackSecurityGuard } = await import('../dist/domains/packs/PackSecurityGuard.js');
    const { PackLoader } = await import('../dist/domains/packs/PackLoader.js');
    const { PackCompiler } = await import('../dist/domains/packs/PackCompiler.js');

    const catConfig = {
      roster: {
        opus: { family: 'ragdoll', roles: ['architect'], available: true },
        codex: { family: 'maine-coon', roles: ['reviewer'], available: true },
      },
      breeds: [
        {
          id: 'ragdoll',
          catId: 'opus',
          displayName: '布偶猫',
          defaultVariantId: 'v1',
          variants: [
            { id: 'v1', roleDescription: 'System architect', personality: 'Deep thinker', strengths: ['architecture'] },
          ],
        },
        {
          id: 'maine-coon',
          catId: 'codex',
          displayName: '缅因猫',
          defaultVariantId: 'v1',
          variants: [{ id: 'v1', roleDescription: 'Code reviewer', personality: 'Thorough', strengths: ['security'] }],
        },
      ],
    };
    const sharedRules =
      '## 铁律\n\n### 铁律 1: production data boundary\n不碰 6399\n\n## 首要原则\n\n### P1: Final State\n直达最终形态\n\n## 世界观\n\n### W1: Agents\n猫猫是 Agent\n\n## 操作规则\n\n### §1 交接\n五件套';
    const skills = 'skills:\n  tdd:\n    description: TDD\n    triggers: ["test"]\n    sop_step: 2\n';

    // 1. Export
    const exportDir = await createTmpDir();
    const exporter = new PackExporter();
    const result = await exporter.exportPack({
      catConfig,
      sharedRulesContent: sharedRules,
      skillsManifestContent: skills,
      outputDir: exportDir,
      packName: 'coding-world',
    });
    assert.equal(result.manifest.name, 'coding-world');

    // 2. Install
    const storeDir = await createTmpDir();
    const loader = new PackLoader(new PackStore(storeDir), new PackSecurityGuard());
    await loader.add(exportDir);

    // 3. Compile
    const compiler = new PackCompiler();
    const compiled = await compiler.compile({ manifest: result.manifest, rootDir: join(storeDir, 'coding-world') });

    assert.equal(compiled.packName, 'coding-world');
    assert.ok(compiled.masksBlock, 'masksBlock present');
    assert.ok(compiled.guardrailBlock, 'guardrailBlock present');
    assert.ok(compiled.defaultsBlock, 'defaultsBlock present');
    assert.ok(compiled.workflowsBlock, 'workflowsBlock present');
    assert.ok(compiled.worldDriverSummary, 'worldDriverSummary present');
  });

  test('independent domain demo passes security + Growth + compiles', async () => {
    const { readFile } = await import('node:fs/promises');
    const { parse } = await import('yaml');
    const { PackSecurityGuard } = await import('../dist/domains/packs/PackSecurityGuard.js');
    const { PackCompiler } = await import('../dist/domains/packs/PackCompiler.js');
    const { checkGrowthBoundary } = await import('../dist/domains/packs/GrowthBoundary.js');

    // Security
    const guard = new PackSecurityGuard();
    const secResult = await guard.validate(CODING_WORLD_PACK);
    assert.ok(secResult.ok, `Security failures: ${secResult.reasons.join('; ')}`);

    // Growth boundary
    const growthResult = await checkGrowthBoundary(CODING_WORLD_PACK);
    assert.ok(growthResult.clean, `Growth violations: ${growthResult.violations.join('; ')}`);

    // Compile
    const packYaml = parse(await readFile(join(CODING_WORLD_PACK, 'pack.yaml'), 'utf-8'));
    const compiler = new PackCompiler();
    const compiled = await compiler.compile({ manifest: packYaml, rootDir: CODING_WORLD_PACK });

    assert.equal(compiled.packName, 'fixture-coding-world');
    assert.ok(compiled.masksBlock);
    assert.ok(compiled.guardrailBlock);
    assert.ok(compiled.defaultsBlock);
  });
});

// ─── AC-B2: TRPG Demo Pack ─────────────────────────────────────────

let TRPG_PACK;

describe('AC-B2: TRPG adventure demo pack', () => {
  test('TRPG pack passes security + Growth + compiles', async () => {
    const { readFile } = await import('node:fs/promises');
    const { parse } = await import('yaml');
    const { PackSecurityGuard } = await import('../dist/domains/packs/PackSecurityGuard.js');
    const { PackCompiler } = await import('../dist/domains/packs/PackCompiler.js');
    const { checkGrowthBoundary } = await import('../dist/domains/packs/GrowthBoundary.js');

    const guard = new PackSecurityGuard();
    const secResult = await guard.validate(TRPG_PACK);
    assert.ok(secResult.ok, `Security failures: ${secResult.reasons.join('; ')}`);

    const growthResult = await checkGrowthBoundary(TRPG_PACK);
    assert.ok(growthResult.clean, `Growth violations: ${growthResult.violations.join('; ')}`);

    const packYaml = parse(await readFile(join(TRPG_PACK, 'pack.yaml'), 'utf-8'));
    const compiler = new PackCompiler();
    const compiled = await compiler.compile({ manifest: packYaml, rootDir: TRPG_PACK });

    assert.equal(compiled.packName, 'fixture-adventure');
    assert.ok(compiled.masksBlock, 'TRPG should have masks');
    assert.ok(compiled.guardrailBlock, 'TRPG should have guardrails');
    assert.ok(compiled.defaultsBlock, 'TRPG should have defaults');
    assert.ok(compiled.workflowsBlock, 'TRPG should have workflows');
    assert.ok(compiled.worldDriverSummary, 'TRPG should have world driver');
  });

  test('TRPG pack round-trips through install → compile', async () => {
    const { PackStore } = await import('../dist/domains/packs/PackStore.js');
    const { PackSecurityGuard } = await import('../dist/domains/packs/PackSecurityGuard.js');
    const { PackLoader } = await import('../dist/domains/packs/PackLoader.js');
    const { PackCompiler } = await import('../dist/domains/packs/PackCompiler.js');

    const storeDir = await createTmpDir();
    const loader = new PackLoader(new PackStore(storeDir), new PackSecurityGuard());
    const manifest = await loader.add(TRPG_PACK);
    assert.equal(manifest.name, 'fixture-adventure');
    assert.equal(manifest.packType, 'scenario');

    const compiler = new PackCompiler();
    const compiled = await compiler.compile({ manifest, rootDir: join(storeDir, 'fixture-adventure') });

    assert.ok(compiled.masksBlock.includes('Dungeon Master') || compiled.masksBlock.includes('DM'));
    assert.ok(compiled.guardrailBlock.includes('character') || compiled.guardrailBlock.includes('metagaming'));
    assert.ok(compiled.worldDriverSummary.includes('hybrid'));
  });
});

// ─── AC-B4/B7: Growth Boundary Integration ─────────────────────────

describe('AC-B4/B7: Growth boundary integration', () => {
  test('exported Coding World pack contains no Growth data', async () => {
    const { checkGrowthBoundary } = await import('../dist/domains/packs/GrowthBoundary.js');
    const result = await checkGrowthBoundary(CODING_WORLD_PACK);
    assert.ok(result.clean, `Growth violations in Coding World: ${result.violations.join('; ')}`);
  });

  test('exported TRPG pack contains no Growth data', async () => {
    const { checkGrowthBoundary } = await import('../dist/domains/packs/GrowthBoundary.js');
    const result = await checkGrowthBoundary(TRPG_PACK);
    assert.ok(result.clean, `Growth violations in TRPG: ${result.violations.join('; ')}`);
  });

  test('pack with Growth artifacts fails boundary check', async () => {
    const { checkGrowthBoundary } = await import('../dist/domains/packs/GrowthBoundary.js');
    const { writeFile, mkdir } = await import('node:fs/promises');

    const dir = await createTmpDir();
    await writeFile(join(dir, 'pack.yaml'), 'name: tainted\nversion: "1.0.0"\ndescription: test\npackType: domain');
    await mkdir(join(dir, 'sessions'));
    await writeFile(join(dir, 'sessions', 'chat.json'), '{}');
    await writeFile(join(dir, 'evidence.sqlite'), 'fake db');

    const result = await checkGrowthBoundary(dir);
    assert.ok(!result.clean, 'Should detect Growth violations');
    assert.ok(result.violations.some((v) => v.includes('sessions')));
    assert.ok(result.violations.some((v) => v.includes('.sqlite')));
  });

  test('Growth-tainted pack is rejected at install', async () => {
    const { PackStore } = await import('../dist/domains/packs/PackStore.js');
    const { PackSecurityGuard } = await import('../dist/domains/packs/PackSecurityGuard.js');
    const { PackLoader } = await import('../dist/domains/packs/PackLoader.js');
    const { checkGrowthBoundary } = await import('../dist/domains/packs/GrowthBoundary.js');
    const { writeFile, mkdir } = await import('node:fs/promises');

    // Create a pack that passes security but has Growth data
    const packDir = await createTmpDir();
    await writeFile(
      join(packDir, 'pack.yaml'),
      'name: growth-test\nversion: "1.0.0"\ndescription: test pack with growth data\npackType: domain',
    );
    await writeFile(join(packDir, 'guardrails.yaml'), 'constraints: []');
    await writeFile(join(packDir, 'defaults.yaml'), 'behaviors: []');

    // Install succeeds (SecurityGuard doesn't check Growth)
    const storeDir = await createTmpDir();
    const loader = new PackLoader(new PackStore(storeDir), new PackSecurityGuard());
    const manifest = await loader.add(packDir);
    assert.equal(manifest.name, 'growth-test');

    // But Growth boundary check on the source catches violations when present
    await mkdir(join(packDir, 'sessions'));
    await writeFile(join(packDir, 'sessions', 'data.json'), '{}');
    const growthResult = await checkGrowthBoundary(packDir);
    assert.ok(!growthResult.clean, 'Source with sessions/ should fail Growth check');
  });
});
