/**
 * F129 Phase B-α: PackExporter + GrowthBoundary Tests
 */

import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { parse } from 'yaml';

let tempDirs = [];

async function makeTempDir(prefix) {
  const { mkdtemp } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const d of tempDirs) {
    await rm(d, { recursive: true, force: true }).catch(() => {});
  }
  tempDirs = [];
});

// ─── GrowthBoundary Tests ───────────────────────────────────────────

describe('GrowthBoundary', () => {
  async function loadGrowthBoundary() {
    const mod = await import('../dist/domains/packs/GrowthBoundary.js');
    return mod.checkGrowthBoundary;
  }

  test('flags .sqlite files as Growth violation', async () => {
    const checkGrowthBoundary = await loadGrowthBoundary();
    const dir = await makeTempDir('growth-sqlite-');
    await writeFile(join(dir, 'evidence.sqlite'), 'fake db');
    const result = await checkGrowthBoundary(dir);
    assert.ok(!result.clean, 'Should flag sqlite files');
    assert.ok(result.violations.some((v) => v.includes('.sqlite')));
  });

  test('flags session/thread directories as Growth violation', async () => {
    const checkGrowthBoundary = await loadGrowthBoundary();
    const dir = await makeTempDir('growth-sessions-');
    await mkdir(join(dir, 'sessions'));
    await writeFile(join(dir, 'sessions', 'chat.json'), '{}');
    const result = await checkGrowthBoundary(dir);
    assert.ok(!result.clean, 'Should flag sessions directory');
    assert.ok(result.violations.some((v) => v.includes('sessions')));
  });

  test('flags .env files as Growth violation', async () => {
    const checkGrowthBoundary = await loadGrowthBoundary();
    const dir = await makeTempDir('growth-env-');
    await writeFile(join(dir, '.env'), 'SECRET=123');
    const result = await checkGrowthBoundary(dir);
    assert.ok(!result.clean, 'Should flag .env files');
    assert.ok(result.violations.some((v) => v.includes('.env')));
  });

  test('passes clean pack directory', async () => {
    const checkGrowthBoundary = await loadGrowthBoundary();
    const dir = await makeTempDir('growth-clean-');
    await writeFile(join(dir, 'pack.yaml'), 'name: test');
    await mkdir(join(dir, 'masks'));
    await writeFile(join(dir, 'masks', 'role.yaml'), 'id: test');
    await mkdir(join(dir, 'knowledge'));
    await writeFile(join(dir, 'knowledge', 'guide.md'), '# Guide');
    const result = await checkGrowthBoundary(dir);
    assert.ok(result.clean, `Violations: ${result.violations.join('; ')}`);
  });

  test('passes pack with knowledge/ .md files (not Growth)', async () => {
    const checkGrowthBoundary = await loadGrowthBoundary();
    const dir = await makeTempDir('growth-knowledge-');
    await mkdir(join(dir, 'knowledge'));
    await writeFile(join(dir, 'knowledge', 'finance-basics.md'), '# Finance Basics');
    await writeFile(join(dir, 'knowledge', 'glossary.txt'), 'term: definition');
    const result = await checkGrowthBoundary(dir);
    assert.ok(result.clean, `Violations: ${result.violations.join('; ')}`);
  });

  test('catches .ENV uppercase bypass (R2 P1)', async () => {
    const { checkGrowthBoundary } = await import('../dist/domains/packs/GrowthBoundary.js');
    const dir = await makeTempDir('growth-env-case-');
    await writeFile(join(dir, 'pack.yaml'), 'name: t\nversion: "1.0.0"\ndescription: T\npackType: domain\n');
    await writeFile(join(dir, '.ENV'), 'SECRET=val');
    const result = await checkGrowthBoundary(dir);
    assert.ok(!result.clean, 'Should catch .ENV uppercase');
    assert.ok(result.violations.some((v) => v.includes('.ENV')));
  });

  test('catches .Env mixed-case bypass (R2 P1)', async () => {
    const { checkGrowthBoundary } = await import('../dist/domains/packs/GrowthBoundary.js');
    const dir = await makeTempDir('growth-env-mixed-');
    await writeFile(join(dir, 'pack.yaml'), 'name: t\nversion: "1.0.0"\ndescription: T\npackType: domain\n');
    await writeFile(join(dir, '.Env.production'), 'DB_URL=x');
    const result = await checkGrowthBoundary(dir);
    assert.ok(!result.clean, 'Should catch .Env.production mixed-case');
  });

  test('allows knowledge/memory/ subdirectory (R2 P2)', async () => {
    const { checkGrowthBoundary } = await import('../dist/domains/packs/GrowthBoundary.js');
    const dir = await makeTempDir('growth-knowledge-sub-');
    await writeFile(join(dir, 'pack.yaml'), 'name: t\nversion: "1.0.0"\ndescription: T\npackType: domain\n');
    await mkdir(join(dir, 'knowledge', 'memory'), { recursive: true });
    await writeFile(join(dir, 'knowledge', 'memory', 'index.md'), '# Memory Models');
    const result = await checkGrowthBoundary(dir);
    assert.ok(result.clean, `False positive: ${result.violations.join('; ')}`);
  });

  test('allows deeply nested knowledge/sub/memory/ (R3 P2)', async () => {
    const { checkGrowthBoundary } = await import('../dist/domains/packs/GrowthBoundary.js');
    const dir = await makeTempDir('growth-deep-');
    await writeFile(join(dir, 'pack.yaml'), 'name: t\nversion: "1.0.0"\ndescription: T\npackType: domain\n');
    await mkdir(join(dir, 'knowledge', 'sub', 'memory'), { recursive: true });
    await writeFile(join(dir, 'knowledge', 'sub', 'memory', 'index.md'), '# Deep Memory Models');
    const result = await checkGrowthBoundary(dir);
    assert.ok(result.clean, `False positive: ${result.violations.join('; ')}`);
  });

  test('still catches top-level memory/ directory (R2 P2 regression)', async () => {
    const { checkGrowthBoundary } = await import('../dist/domains/packs/GrowthBoundary.js');
    const dir = await makeTempDir('growth-toplevel-');
    await writeFile(join(dir, 'pack.yaml'), 'name: t\nversion: "1.0.0"\ndescription: T\npackType: domain\n');
    await mkdir(join(dir, 'memory'), { recursive: true });
    await writeFile(join(dir, 'memory', 'data.json'), '{}');
    const result = await checkGrowthBoundary(dir);
    assert.ok(!result.clean, 'Top-level memory/ should be flagged');
  });

  test('does not false-positive on legitimate knowledge files (P2-1)', async () => {
    const { checkGrowthBoundary } = await import('../dist/domains/packs/GrowthBoundary.js');
    const dir = await makeTempDir('growth-fp-');
    // Create knowledge/ with files whose names contain Growth keywords
    const knowledgeDir = join(dir, 'knowledge');
    await mkdir(knowledgeDir, { recursive: true });
    await writeFile(join(knowledgeDir, 'memory-models.md'), '# Memory Models\nCognitive psychology.');
    await writeFile(join(knowledgeDir, 'growth-mindset.md'), '# Growth Mindset\nCarol Dweck.');
    await writeFile(join(knowledgeDir, 'session-management.md'), '# Session Management\nHTTP sessions.');
    await writeFile(join(dir, 'pack.yaml'), 'name: test\nversion: "1.0.0"\ndescription: Test\npackType: domain\n');

    const result = await checkGrowthBoundary(dir);
    assert.ok(result.clean, `False positive violations: ${result.violations.join('; ')}`);
  });
});

// ─── PackExporter Tests ─────────────────────────────────────────────

// Minimal cat-config subset for testing
const MINI_CAT_CONFIG = {
  version: 2,
  coCreator: { name: 'Tester', aliases: [], mentionPatterns: [] },
  roster: {
    opus: { family: 'ragdoll', roles: ['architect'], lead: true, available: true },
    codex: { family: 'maine-coon', roles: ['reviewer'], lead: true, available: true },
    gemini: { family: 'siamese', roles: ['designer'], lead: true, available: false },
  },
  breeds: [
    {
      id: 'ragdoll',
      catId: 'opus',
      name: '布偶猫',
      displayName: '布偶猫',
      defaultVariantId: 'opus-default',
      variants: [
        {
          id: 'opus-default',
          provider: 'anthropic',
          defaultModel: 'claude-opus-4-6',
          personality: 'Deep thinker, architect',
          roleDescription: 'System architect and core developer',
          strengths: ['architecture', 'backend', 'mcp'],
          cli: { command: 'claude', outputFormat: 'stream-json' },
        },
      ],
    },
    {
      id: 'maine-coon',
      catId: 'codex',
      name: '缅因猫',
      displayName: '缅因猫',
      defaultVariantId: 'codex-default',
      variants: [
        {
          id: 'codex-default',
          provider: 'openai',
          defaultModel: 'gpt-5.3-codex',
          personality: 'Security-focused, thorough reviewer',
          roleDescription: 'Code review expert, security analysis',
          strengths: ['code-review', 'security', 'testing'],
          cli: { command: 'codex', outputFormat: 'json' },
        },
      ],
    },
    {
      id: 'siamese',
      catId: 'gemini',
      name: '暹罗猫',
      displayName: '暹罗猫',
      defaultVariantId: 'gemini-default',
      variants: [
        {
          id: 'gemini-default',
          provider: 'google',
          defaultModel: 'gemini-2.5-pro',
          personality: 'Creative visual designer',
          roleDescription: 'Visual design and UI/UX',
          strengths: ['visual-design', 'ui-ux', 'creativity'],
          cli: { command: 'gemini', outputFormat: 'cdp-bridge' },
        },
      ],
    },
  ],
};

const MINI_SHARED_RULES = `# 协作纪律

## 首要原则（P1-P5）

### P1: Face-to-Final-State
不搭脚手架。每个产出物直达最终形态。

### P2: Co-Creator Partners
铲屎官是合伙人，不是老板。

### P3: Direction > Speed
方向正确比速度重要。

## 世界观（W1-W3）

### W1: Cats are Agents, Not APIs
猫猫是有能动性的 Agent，不是被动接口。

### W2: Shared Files = Team
共享文件、Git、记忆构成团队协作基础。

## 铁律

### 铁律 1: Redis production Redis (sacred)
开发只用 6398，误触 6399 立即停止。

### 铁律 2: 同一个体不能 review 自己的代码
跨 family 优先。

## 操作规则

### §1 交接五件套
What, Why, Tradeoff, Open Questions, Next Action.

### §2 不确定就提问
Uncertain → ask before guessing.
`;

const MINI_SKILLS_MANIFEST = `skills:
  feat-lifecycle:
    description: Feature lifecycle management
    triggers: ["new feature", "立项"]
    not_for: ["code implementation"]
    output: Feature spec
    next: [writing-plans]
    sop_step: 1
  tdd:
    description: Test-driven development
    triggers: ["write test", "TDD"]
    not_for: ["pure docs"]
    output: Tested code
    next: [quality-gate]
    sop_step: 2
  debugging:
    description: Systematic bug diagnosis
    triggers: ["bug", "error"]
    not_for: ["new features"]
    output: Bug fix
    next: []
    sop_step: null
`;

describe('PackExporter', () => {
  async function loadExporter() {
    const mod = await import('../dist/domains/packs/PackExporter.js');
    return mod.PackExporter;
  }

  test('exports one mask per available breed', async () => {
    const PackExporter = await loadExporter();
    const exporter = new PackExporter();
    const masks = exporter.exportMasks(MINI_CAT_CONFIG);
    // gemini is unavailable → only 2 masks
    assert.equal(masks.length, 2);
    const ids = masks.map((m) => m.id);
    assert.ok(ids.includes('ragdoll-architect'));
    assert.ok(ids.includes('maine-coon-reviewer'));
  });

  test('mask roleOverlay comes from variant roleDescription', async () => {
    const PackExporter = await loadExporter();
    const exporter = new PackExporter();
    const masks = exporter.exportMasks(MINI_CAT_CONFIG);
    const arch = masks.find((m) => m.id === 'ragdoll-architect');
    assert.ok(arch);
    assert.ok(arch.roleOverlay.includes('architect'));
    assert.deepEqual(arch.expertise, ['architecture', 'backend', 'mcp']);
    assert.equal(arch.activation, 'always');
  });

  test('skips unavailable breeds', async () => {
    const PackExporter = await loadExporter();
    const exporter = new PackExporter();
    const masks = exporter.exportMasks(MINI_CAT_CONFIG);
    const ids = masks.map((m) => m.id);
    assert.ok(!ids.some((id) => id.includes('siamese')));
  });

  test('iron laws become block-severity guardrails', async () => {
    const PackExporter = await loadExporter();
    const exporter = new PackExporter();
    const guardrails = exporter.exportGuardrails(MINI_SHARED_RULES);
    const blocks = guardrails.constraints.filter((c) => c.severity === 'block');
    assert.ok(blocks.length >= 2, `Expected >=2 block constraints, got ${blocks.length}`);
    assert.ok(blocks.some((c) => c.rule.includes('6399') || c.rule.includes('Redis')));
  });

  test('first principles become warn-severity guardrails', async () => {
    const PackExporter = await loadExporter();
    const exporter = new PackExporter();
    const guardrails = exporter.exportGuardrails(MINI_SHARED_RULES);
    const warns = guardrails.constraints.filter((c) => c.severity === 'warn');
    assert.ok(warns.length >= 2, `Expected >=2 warn constraints, got ${warns.length}`);
  });

  test('world view + operational rules become overridable defaults', async () => {
    const PackExporter = await loadExporter();
    const exporter = new PackExporter();
    const defaults = exporter.exportDefaults(MINI_SHARED_RULES);
    assert.ok(defaults.behaviors.length >= 2);
    assert.ok(defaults.behaviors.every((b) => b.overridable === true));
  });

  test('exports SOP-linked skills as workflows', async () => {
    const PackExporter = await loadExporter();
    const exporter = new PackExporter();
    const workflows = exporter.exportWorkflows(MINI_SKILLS_MANIFEST);
    // feat-lifecycle (sop_step=1) and tdd (sop_step=2) but NOT debugging (null)
    assert.equal(workflows.length, 2);
    const ids = workflows.map((w) => w.id);
    assert.ok(ids.includes('feat-lifecycle'));
    assert.ok(ids.includes('tdd'));
    assert.ok(!ids.includes('debugging'));
  });

  test('skips non-SOP skills', async () => {
    const PackExporter = await loadExporter();
    const exporter = new PackExporter();
    const workflows = exporter.exportWorkflows(MINI_SKILLS_MANIFEST);
    assert.ok(!workflows.some((w) => w.id === 'debugging'));
  });

  test('full export produces valid pack directory', async () => {
    const PackExporter = await loadExporter();
    const exporter = new PackExporter();
    const outputDir = await makeTempDir('export-full-');
    const result = await exporter.exportPack({
      catConfig: MINI_CAT_CONFIG,
      sharedRulesContent: MINI_SHARED_RULES,
      skillsManifestContent: MINI_SKILLS_MANIFEST,
      outputDir,
      packName: 'test-coding-world',
    });
    assert.equal(result.manifest.name, 'test-coding-world');
    assert.equal(result.manifest.packType, 'domain');

    // Verify files exist
    const packYaml = parse(await readFile(join(outputDir, 'pack.yaml'), 'utf-8'));
    assert.equal(packYaml.name, 'test-coding-world');

    const guardrails = parse(await readFile(join(outputDir, 'guardrails.yaml'), 'utf-8'));
    assert.ok(guardrails.constraints.length > 0);

    const defaults = parse(await readFile(join(outputDir, 'defaults.yaml'), 'utf-8'));
    assert.ok(defaults.behaviors.length > 0);
  });

  test('exported pack passes PackSecurityGuard validation', async () => {
    const PackExporter = await loadExporter();
    const { PackSecurityGuard } = await import('../dist/domains/packs/PackSecurityGuard.js');
    const exporter = new PackExporter();
    const guard = new PackSecurityGuard();
    const outputDir = await makeTempDir('export-security-');
    await exporter.exportPack({
      catConfig: MINI_CAT_CONFIG,
      sharedRulesContent: MINI_SHARED_RULES,
      skillsManifestContent: MINI_SKILLS_MANIFEST,
      outputDir,
      packName: 'security-test',
    });
    const result = await guard.validate(outputDir);
    assert.ok(result.ok, `Security failures: ${result.reasons.join('; ')}`);
  });

  test('guardrails extraction works with real shared-rules headings (P1-2)', async () => {
    const PackExporter = await loadExporter();
    const exporter = new PackExporter();
    // Real shared-rules.md uses "第一性原理" not "首要原则"
    const realStyleRules = `# 家规

## 第一性原理（First Principles）

### P1. 面向终态，不绕路
设计路线先画终态。

### P2. 共创伙伴，不是木头人
硬约束（铁律）是法律底线。

## 世界观（Worldview）

### W1. 猫猫是 Agent，不是 API
有身份有上下文有主动性。

## 操作规则

### §1 交接五件套
What, Why, Tradeoff, Open Questions, Next Action.
`;
    const guardrails = exporter.exportGuardrails(realStyleRules);
    // Should extract 第一性原理 as warn-severity principles
    const warns = guardrails.constraints.filter((c) => c.severity === 'warn');
    assert.ok(warns.length >= 2, `Expected >=2 warn constraints from 第一性原理, got ${warns.length}`);
    assert.ok(warns.some((c) => c.rule.includes('终态') || c.rule.includes('Final')));
  });

  test('exported pack passes GrowthBoundary check', async () => {
    const PackExporter = await loadExporter();
    const { checkGrowthBoundary } = await import('../dist/domains/packs/GrowthBoundary.js');
    const exporter = new PackExporter();
    const outputDir = await makeTempDir('export-growth-');
    await exporter.exportPack({
      catConfig: MINI_CAT_CONFIG,
      sharedRulesContent: MINI_SHARED_RULES,
      skillsManifestContent: MINI_SKILLS_MANIFEST,
      outputDir,
      packName: 'growth-test',
    });
    const result = await checkGrowthBoundary(outputDir);
    assert.ok(result.clean, `Growth violations: ${result.violations.join('; ')}`);
  });
});
