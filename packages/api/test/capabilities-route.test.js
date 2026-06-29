// @ts-check
/**
 * Capabilities Route Tests — F041 统一能力看板 API
 *
 * Tests the GET and PATCH /api/capabilities endpoints.
 * Uses Fastify injection + tmp directories for isolation.
 */
import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, readdir, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { readAuditLog } from '../dist/config/capabilities/capability-audit.js';
import {
  readCapabilitiesConfig,
  writeCapabilitiesConfig,
} from '../dist/config/capabilities/capability-orchestrator.js';
import { writeMountRules } from '../dist/config/mount/mount-rules-store.js';

const AUTH_HEADERS = { 'x-cat-cafe-user': 'test-user' };
const OWNER_SESSION_HEADERS = { 'x-test-session-user': 'you' };
const NON_OWNER_SESSION_HEADERS = { 'x-test-session-user': 'codex' };
const REDACTED_SECRET = '••••••';

/** @param {string} prefix */
async function makeTmpDir(prefix) {
  const dir = join(tmpdir(), `cap-route-test-${prefix}-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (err) {
    if (err?.code === 'ENOENT') return false;
    throw err;
  }
}

function findRepoRoot() {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}

// ────────── PATCH logic (unit-level, no Fastify needed) ──────────

describe('scanProviderSkillDirs', () => {
  it('merges multi-source provider results deterministically', async () => {
    const { scanProviderSkillDirs } = await import('../dist/routes/capabilities.js');
    const root = join(process.cwd(), '.test-tmp-cap-scan-' + Date.now());
    const kimiProject = join(root, '.kimi', 'skills');
    const kimiUser = join(root, 'home', '.kimi', 'skills');
    await mkdir(join(kimiProject, 'alpha'), { recursive: true });
    await mkdir(join(kimiUser, 'beta'), { recursive: true });
    await Promise.all([
      writeFile(join(kimiProject, 'alpha', 'SKILL.md'), '# alpha'),
      writeFile(join(kimiUser, 'beta', 'SKILL.md'), '# beta'),
    ]);
    try {
      const result = await scanProviderSkillDirs([
        { key: 'kimi-project', provider: 'kimi', path: kimiProject },
        { key: 'kimi-user', provider: 'kimi', path: kimiUser },
      ]);
      assert.deepEqual(new Set(result.providerSkills.kimi), new Set(['alpha', 'beta']));
      assert.deepEqual(result.scanResults['kimi-project'], ['alpha']);
      assert.deepEqual(result.scanResults['kimi-user'], ['beta']);
      assert.equal(result.scansOk, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves null scan sentinels for failed project scans', async () => {
    const { scanProviderSkillDirs } = await import('../dist/routes/capabilities.js');
    const root = join(process.cwd(), '.test-tmp-cap-scan-fail-' + Date.now());
    const kimiUser = join(root, 'home', '.kimi', 'skills');
    await mkdir(join(kimiUser, 'beta'), { recursive: true });
    await writeFile(join(kimiUser, 'beta', 'SKILL.md'), '# beta');
    try {
      const result = await scanProviderSkillDirs([
        { key: 'kimi-project', provider: 'kimi', path: join(root, '.missing-unreadable') },
        { key: 'kimi-user', provider: 'kimi', path: kimiUser },
      ]);
      assert.equal(
        result.scanResults['kimi-project'] === null || Array.isArray(result.scanResults['kimi-project']),
        true,
      );
      assert.deepEqual(result.scanResults['kimi-user'], ['beta']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('shouldPropagateManagedSkillToggle', () => {
  it('propagates global toggles only, never project scope', async () => {
    const { shouldPropagateManagedSkillToggle } = await import('../dist/routes/capabilities.js');
    const mainRoot = '/repo/main';
    const externalRoot = '/repo/external';

    assert.equal(shouldPropagateManagedSkillToggle('global', true, mainRoot, mainRoot), true);
    assert.equal(shouldPropagateManagedSkillToggle('project', true, mainRoot, mainRoot), false);
    assert.equal(shouldPropagateManagedSkillToggle('project', true, externalRoot, mainRoot), false);
    assert.equal(shouldPropagateManagedSkillToggle('project', false, mainRoot, mainRoot), false);
    assert.equal(shouldPropagateManagedSkillToggle('cat', true, mainRoot, mainRoot), false);
  });
});

describe('PATCH capabilities logic', () => {
  /** @type {string} */ let dir;

  beforeEach(async () => {
    dir = await makeTmpDir('patch');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('toggles global enabled and persists', async () => {
    await writeCapabilitiesConfig(dir, {
      version: 1,
      capabilities: [
        {
          id: 'cat-cafe',
          type: 'mcp',
          enabled: true,
          source: 'cat-cafe',
          mcpServer: { command: 'node', args: ['server.js'] },
        },
        {
          id: 'external-tool',
          type: 'mcp',
          enabled: true,
          source: 'external',
          mcpServer: { command: 'echo', args: [] },
        },
      ],
    });

    // Read, mutate, write (simulating PATCH scope=global)
    const config = await readCapabilitiesConfig(dir);
    assert.ok(config);
    const cap = config.capabilities.find((c) => c.id === 'external-tool');
    assert.ok(cap);
    cap.enabled = false;
    await writeCapabilitiesConfig(dir, config);

    const updated = await readCapabilitiesConfig(dir);
    assert.ok(updated);
    assert.equal(updated.capabilities.find((c) => c.id === 'external-tool')?.enabled, false);
  });

  it('adds per-cat override', async () => {
    await writeCapabilitiesConfig(dir, {
      version: 1,
      capabilities: [
        { id: 'tool', type: 'mcp', enabled: true, source: 'external', mcpServer: { command: 'echo', args: [] } },
      ],
    });

    const config = await readCapabilitiesConfig(dir);
    assert.ok(config);
    const cap = config.capabilities[0];
    assert.ok(cap);
    cap.overrides = [{ catId: 'codex', enabled: false }];
    await writeCapabilitiesConfig(dir, config);

    const updated = await readCapabilitiesConfig(dir);
    assert.ok(updated);
    assert.equal(updated.capabilities[0]?.overrides?.[0]?.catId, 'codex');
    assert.equal(updated.capabilities[0]?.overrides?.[0]?.enabled, false);
  });

  it('toggles skill global enabled and persists', async () => {
    await writeCapabilitiesConfig(dir, {
      version: 1,
      capabilities: [
        {
          id: 'cat-cafe',
          type: 'mcp',
          enabled: true,
          source: 'cat-cafe',
          mcpServer: { command: 'node', args: ['server.js'] },
        },
        { id: 'cross-cat-handoff', type: 'skill', enabled: true, source: 'external' },
      ],
    });

    const config = await readCapabilitiesConfig(dir);
    assert.ok(config);
    const skill = config.capabilities.find((c) => c.type === 'skill' && c.id === 'cross-cat-handoff');
    assert.ok(skill);
    skill.enabled = false;
    await writeCapabilitiesConfig(dir, config);

    const updated = await readCapabilitiesConfig(dir);
    assert.ok(updated);
    const updatedSkill = updated.capabilities.find((c) => c.id === 'cross-cat-handoff');
    assert.equal(updatedSkill?.enabled, false);
    assert.equal(updatedSkill?.type, 'skill');
  });

  it('adds per-cat override for skill', async () => {
    await writeCapabilitiesConfig(dir, {
      version: 1,
      capabilities: [{ id: 'spec-compliance-check', type: 'skill', enabled: true, source: 'external' }],
    });

    const config = await readCapabilitiesConfig(dir);
    assert.ok(config);
    const cap = config.capabilities[0];
    assert.ok(cap);
    cap.overrides = [{ catId: 'codex', enabled: false }];
    await writeCapabilitiesConfig(dir, config);

    const updated = await readCapabilitiesConfig(dir);
    assert.ok(updated);
    assert.equal(updated.capabilities[0]?.overrides?.[0]?.catId, 'codex');
    assert.equal(updated.capabilities[0]?.overrides?.[0]?.enabled, false);
  });

  it('skill sync allows same-name MCP and skill to coexist', async () => {
    // Cloud P1→P2: same name, different types must coexist.
    // Sync checks type-scoped: c.type === 'skill' && c.id === skillName
    // PATCH disambiguates via id + type compound lookup.
    await writeCapabilitiesConfig(dir, {
      version: 1,
      capabilities: [
        {
          id: 'filesystem',
          type: 'mcp',
          enabled: true,
          source: 'external',
          mcpServer: { command: 'npx', args: ['@mcp/fs'] },
        },
      ],
    });

    const config = await readCapabilitiesConfig(dir);
    assert.ok(config);

    // Simulate the GET handler's skill sync logic (type-scoped check)
    const skillName = 'filesystem';
    const existsAsSkill = config.capabilities.some((c) => c.type === 'skill' && c.id === skillName);

    if (!existsAsSkill) {
      config.capabilities.push({
        id: skillName,
        type: 'skill',
        enabled: true,
        source: 'external',
      });
    }
    await writeCapabilitiesConfig(dir, config);

    const updated = await readCapabilitiesConfig(dir);
    assert.ok(updated);
    // Both entries should exist: 1 MCP + 1 skill
    const mcpCount = updated.capabilities.filter((c) => c.id === 'filesystem' && c.type === 'mcp').length;
    const skillCount = updated.capabilities.filter((c) => c.id === 'filesystem' && c.type === 'skill').length;
    assert.equal(mcpCount, 1, 'Should have exactly one MCP entry');
    assert.equal(skillCount, 1, 'Should have exactly one skill entry');
  });

  it('PATCH targets correct entry when MCP and skill share a name', async () => {
    // Cloud P2 regression: PATCH by id-only hits the MCP entry when toggling skill
    await writeCapabilitiesConfig(dir, {
      version: 1,
      capabilities: [
        {
          id: 'filesystem',
          type: 'mcp',
          enabled: true,
          source: 'external',
          mcpServer: { command: 'npx', args: ['@mcp/fs'] },
        },
        { id: 'filesystem', type: 'skill', enabled: true, source: 'external' },
      ],
    });

    const config = await readCapabilitiesConfig(dir);
    assert.ok(config);

    // Simulate PATCH with compound lookup (id + type)
    const targetId = 'filesystem';
    const targetType = 'skill';
    const capIndex = config.capabilities.findIndex((c) => c.id === targetId && c.type === targetType);
    assert.ok(capIndex !== -1, 'Should find the skill entry');

    const cap = config.capabilities[capIndex];
    assert.equal(cap.type, 'skill', 'Compound lookup should target the skill, not the MCP');

    cap.enabled = false;
    await writeCapabilitiesConfig(dir, config);

    const updated = await readCapabilitiesConfig(dir);
    assert.ok(updated);
    const mcp = updated.capabilities.find((c) => c.id === 'filesystem' && c.type === 'mcp');
    const skill = updated.capabilities.find((c) => c.id === 'filesystem' && c.type === 'skill');
    assert.equal(mcp?.enabled, true, 'MCP should remain enabled');
    assert.equal(skill?.enabled, false, 'Skill should be disabled by PATCH');
  });

  it('removes no-op override that matches global', async () => {
    await writeCapabilitiesConfig(dir, {
      version: 1,
      capabilities: [
        {
          id: 'tool',
          type: 'mcp',
          enabled: true,
          source: 'external',
          mcpServer: { command: 'echo', args: [] },
          overrides: [{ catId: 'opus', enabled: false }],
        },
      ],
    });

    const config = await readCapabilitiesConfig(dir);
    assert.ok(config);
    const cap = config.capabilities[0];
    assert.ok(cap);

    // Set override to match global (true) — should be cleaned up
    if (cap.overrides) {
      const ov = cap.overrides.find((o) => o.catId === 'opus');
      if (ov) ov.enabled = true;
      // Cleanup: remove override if matches global
      cap.overrides = cap.overrides.filter((o) => o.enabled !== cap.enabled);
      if (cap.overrides.length === 0) delete cap.overrides;
    }
    await writeCapabilitiesConfig(dir, config);

    const updated = await readCapabilitiesConfig(dir);
    assert.ok(updated);
    assert.equal(updated.capabilities[0]?.overrides, undefined);
  });

  it('skill cats are sparse — only includes cats whose provider has the skill', () => {
    // Cloud R4 P2: skill cats object must omit cats whose provider lacks the skill,
    // so the frontend cat filter (filterCat in item.cats) can narrow rows.
    const providerSkills = {
      claude: ['review-code', 'debug'],
      openai: ['review-code'],
      google: [],
    };
    const catProviderMap = {
      opus: 'claude',
      codex: 'openai',
      gemini: 'google',
    };
    const skillName = 'review-code';

    // Simulate the sparse cats logic from GET handler
    const cats = {};
    for (const [catId, provider] of Object.entries(catProviderMap)) {
      const present = (providerSkills[provider] ?? []).includes(skillName);
      if (!present) continue; // Sparse: omit irrelevant cats
      cats[catId] = true; // enabled state
    }

    // opus (claude) and codex (openai) have 'review-code', gemini (google) does not
    assert.equal('opus' in cats, true, 'opus should be in cats (claude has review-code)');
    assert.equal('codex' in cats, true, 'codex should be in cats (openai has review-code)');
    assert.equal('gemini' in cats, false, 'gemini should NOT be in cats (google lacks review-code)');

    // Frontend filter check: filterCat='gemini' → !(gemini in cats) → row hidden
    const filterCat = 'gemini';
    const filtered = !(filterCat in cats);
    assert.equal(filtered, true, 'Cat filter should hide skill for irrelevant cat');
  });

  it('prunes stale skills removed from filesystem', async () => {
    // Cloud R6 P2: skills deleted from disk must be removed from capabilities.json
    await writeCapabilitiesConfig(dir, {
      version: 1,
      capabilities: [
        { id: 'mcp-tool', type: 'mcp', enabled: true, source: 'external', mcpServer: { command: 'echo', args: [] } },
        { id: 'old-skill', type: 'skill', enabled: true, source: 'external' },
        { id: 'current-skill', type: 'skill', enabled: true, source: 'external' },
      ],
    });

    const config = await readCapabilitiesConfig(dir);
    assert.ok(config);

    // Simulate: only 'current-skill' is discovered on filesystem
    const allSkillNames = new Set(['current-skill']);

    // Prune stale skills (same logic as GET handler)
    config.capabilities = config.capabilities.filter((c) => c.type !== 'skill' || allSkillNames.has(c.id));
    await writeCapabilitiesConfig(dir, config);

    const updated = await readCapabilitiesConfig(dir);
    assert.ok(updated);
    assert.equal(updated.capabilities.length, 2, 'Should have MCP + current-skill only');
    assert.equal(
      updated.capabilities.some((c) => c.id === 'old-skill'),
      false,
      'Stale skill should be pruned',
    );
    assert.equal(
      updated.capabilities.some((c) => c.id === 'mcp-tool'),
      true,
      'MCP entries should not be pruned',
    );
  });

  it('skips prune when any scan failed (allScansOk=false)', async () => {
    // Cloud R8 P1: partial scan failure must block prune
    await writeCapabilitiesConfig(dir, {
      version: 1,
      capabilities: [
        { id: 'mcp-tool', type: 'mcp', enabled: true, source: 'external', mcpServer: { command: 'echo', args: [] } },
        {
          id: 'saved-skill',
          type: 'skill',
          enabled: false,
          source: 'external',
          overrides: [{ catId: 'opus', enabled: true }],
        },
      ],
    });

    const config = await readCapabilitiesConfig(dir);
    assert.ok(config);

    // Simulate: one scan failed (null) → allScansOk = false
    const allScansOk = false;
    const allSkillNames = new Set(['other-skill']); // non-empty but incomplete

    if (allScansOk) {
      config.capabilities = config.capabilities.filter((c) => c.type !== 'skill' || allSkillNames.has(c.id));
    }
    await writeCapabilitiesConfig(dir, config);

    const updated = await readCapabilitiesConfig(dir);
    assert.ok(updated);
    const skill = updated.capabilities.find((c) => c.id === 'saved-skill');
    assert.ok(skill, 'Skill must survive when allScansOk=false');
    assert.equal(skill.overrides?.[0]?.catId, 'opus', 'Saved overrides preserved');
  });

  it('prunes all stale skills when scans succeed and 0 skills discovered', async () => {
    // Cloud R9 P2-2: 0 skills + allScansOk = user deleted everything → prune
    await writeCapabilitiesConfig(dir, {
      version: 1,
      capabilities: [
        { id: 'mcp-tool', type: 'mcp', enabled: true, source: 'external', mcpServer: { command: 'echo', args: [] } },
        { id: 'stale-skill', type: 'skill', enabled: true, source: 'external' },
      ],
    });

    const config = await readCapabilitiesConfig(dir);
    assert.ok(config);

    const allScansOk = true;
    const allSkillNames = new Set(); // genuinely 0 skills

    if (allScansOk) {
      config.capabilities = config.capabilities.filter((c) => c.type !== 'skill' || allSkillNames.has(c.id));
    }
    await writeCapabilitiesConfig(dir, config);

    const updated = await readCapabilitiesConfig(dir);
    assert.ok(updated);
    assert.equal(updated.capabilities.length, 1, 'Only MCP should remain');
    assert.equal(updated.capabilities[0]?.id, 'mcp-tool');
  });
});

// ────────── Resolve per-cat with overrides ──────────

describe('resolveServersForCat with overrides', () => {
  it('override disabled wins over global enabled', async () => {
    const { resolveServersForCat } = await import('../dist/config/capabilities/capability-orchestrator.js');

    /** @type {any} */
    const config = {
      version: 1,
      capabilities: [
        {
          id: 'tool',
          type: 'mcp',
          enabled: true,
          source: 'external',
          mcpServer: { command: 'echo', args: [] },
          overrides: [{ catId: 'codex', enabled: false }],
        },
      ],
    };

    const codex = resolveServersForCat(config, 'codex');
    assert.equal(codex[0].enabled, false);

    const opus = resolveServersForCat(config, 'opus');
    assert.equal(opus[0].enabled, true);
  });

  it('override enabled wins over global disabled', async () => {
    const { resolveServersForCat } = await import('../dist/config/capabilities/capability-orchestrator.js');

    /** @type {any} */
    const config = {
      version: 1,
      capabilities: [
        {
          id: 'tool',
          type: 'mcp',
          globalEnabled: false,
          source: 'external',
          mcpServer: { command: 'echo', args: [] },
          overrides: [{ catId: 'opus', enabled: true }],
        },
      ],
    };

    const opus = resolveServersForCat(config, 'opus');
    assert.equal(opus[0].enabled, true);

    const codex = resolveServersForCat(config, 'codex');
    assert.equal(codex[0].enabled, false);
  });

  it('returns project-only MCPs from single project config (R4 P1-1)', async () => {
    const { resolveServersForCat } = await import('../dist/config/capabilities/capability-orchestrator.js');

    // F249: resolver takes a single project config — no global+project merge
    /** @type {any} */
    const projectConfig = {
      version: 1,
      capabilities: [
        {
          id: 'global-tool',
          type: 'mcp',
          source: 'external',
          mcpServer: { command: 'echo', args: ['global'] },
          blockedCats: [],
        },
        {
          id: 'project-only-tool',
          type: 'mcp',
          source: 'external',
          mcpServer: { command: 'echo', args: ['project-only'] },
          blockedCats: [],
        },
      ],
    };

    const servers = resolveServersForCat(projectConfig, 'opus');
    const names = servers.map((s) => s.name);
    assert.ok(names.includes('global-tool'), 'synced global tool present');
    assert.ok(names.includes('project-only-tool'), 'project-only tool must be returned');
    assert.equal(servers.find((s) => s.name === 'project-only-tool').enabled, true);
  });

  it('applies blockedCats to project MCPs (R4 P1-1)', async () => {
    const { resolveServersForCat } = await import('../dist/config/capabilities/capability-orchestrator.js');

    // F249: resolver takes single project config directly
    /** @type {any} */
    const projectConfig = {
      version: 1,
      capabilities: [
        {
          id: 'project-tool',
          type: 'mcp',
          source: 'external',
          mcpServer: { command: 'echo', args: ['project'] },
          blockedCats: ['codex'],
        },
      ],
    };

    const codex = resolveServersForCat(projectConfig, 'codex');
    assert.equal(codex.length, 0, 'blocked cat must not see project-only tool');

    const opus = resolveServersForCat(projectConfig, 'opus');
    assert.equal(opus.length, 1, 'unblocked cat must see project-only tool');
    assert.equal(opus[0].name, 'project-tool');
  });

  it('single config preserves blockedCats per-tool (R4 P1-1)', async () => {
    const { resolveServersForCat } = await import('../dist/config/capabilities/capability-orchestrator.js');

    // F249: resolver takes a single project config — no global+project merge
    /** @type {any} */
    const projectConfig = {
      version: 1,
      capabilities: [
        {
          id: 'shared-tool',
          type: 'mcp',
          source: 'external',
          mcpServer: { command: 'echo', args: ['shared'] },
          blockedCats: ['codex'],
        },
        {
          id: 'local-only',
          type: 'mcp',
          source: 'external',
          mcpServer: { command: 'echo', args: ['local'] },
          blockedCats: [],
        },
      ],
    };

    // codex: shared-tool blocked, local-only accessible
    const codex = resolveServersForCat(projectConfig, 'codex');
    assert.equal(codex.length, 1);
    assert.equal(codex[0].name, 'local-only');

    // opus: both accessible
    const opus = resolveServersForCat(projectConfig, 'opus');
    assert.equal(opus.length, 2);
    const opusNames = opus.map((s) => s.name);
    assert.ok(opusNames.includes('shared-tool'));
    assert.ok(opusNames.includes('local-only'));
  });

  it('project enabled derives from blockedCats, not globalEnabled (R5 P1 regression)', async () => {
    const { resolveServersForCat } = await import('../dist/config/capabilities/capability-orchestrator.js');

    // F249: resolver takes a single project config. Project enabled derives from
    // blockedCats, regardless of what globalEnabled says.
    /** @type {any} */
    const projectUnblocked = {
      version: 1,
      capabilities: [
        {
          id: 'tool-a',
          type: 'mcp',
          source: 'external',
          mcpServer: { command: 'echo', args: ['a'] },
          blockedCats: [],
        },
      ],
    };

    // Board derives enabled from cats: any cat enabled → item enabled
    const catIds = ['opus', 'codex'];
    const cats = {};
    for (const catId of catIds) {
      const servers = resolveServersForCat(projectUnblocked, catId);
      const server = servers.find((s) => s.name === 'tool-a');
      cats[catId] = server?.enabled ?? false;
    }
    const boardEnabled = Object.values(cats).some(Boolean);
    assert.equal(boardEnabled, true, 'blockedCats=[] → board item enabled must be true');

    // Converse: all cats blocked → item disabled
    /** @type {any} */
    const projectBlocked = {
      version: 1,
      capabilities: [
        {
          id: 'tool-a',
          type: 'mcp',
          source: 'external',
          mcpServer: { command: 'echo', args: ['a'] },
          blockedCats: ['opus', 'codex'],
        },
      ],
    };

    const blockedCats = {};
    for (const catId of catIds) {
      const servers = resolveServersForCat(projectBlocked, catId);
      const server = servers.find((s) => s.name === 'tool-a');
      blockedCats[catId] = server?.enabled ?? false;
    }
    const blockedEnabled = Object.values(blockedCats).some(Boolean);
    assert.equal(blockedEnabled, false, 'blockedCats=[all] → board item enabled must be false');
  });
});

// ────────── Fastify route-level tests ──────────

describe('GET /api/capabilities (Fastify)', () => {
  /** @param {string} workdir */
  function inlineProbeServerCode(workdir) {
    return [
      "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
      "import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';",
      "import { z } from 'zod';",
      "const server = new McpServer({ name: 'probe-test-server', version: '1.0.0' });",
      "server.tool('probe_echo', 'Probe test tool', { message: z.string().optional() }, async ({ message }) => ({ content: [{ type: 'text', text: message ?? 'ok' }] }));",
      'const transport = new StdioServerTransport();',
      'await server.connect(transport);',
      `process.chdir(${JSON.stringify(workdir)});`,
    ].join(' ');
  }

  it('returns 401 when no identity header', async () => {
    const Fastify = (await import('fastify')).default;
    const { capabilitiesRoutes } = await import('../dist/routes/capabilities.js');

    const app = Fastify();
    await app.register(capabilitiesRoutes);
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/capabilities' });
    assert.equal(res.statusCode, 401);
    assert.ok(res.json().error.includes('Identity required'));

    await app.close();
  });

  it('returns CapabilityBoardResponse with items and catFamilies', async () => {
    const Fastify = (await import('fastify')).default;
    const { capabilitiesRoutes } = await import('../dist/routes/capabilities.js');

    const app = Fastify();
    await app.register(capabilitiesRoutes);
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/capabilities',
      headers: AUTH_HEADERS,
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();

    // F041 re-open: response is now { items, catFamilies, projectPath }
    assert.ok(Array.isArray(body.items), 'response.items should be an array');
    assert.ok(Array.isArray(body.catFamilies), 'response.catFamilies should be an array');
    assert.ok(typeof body.projectPath === 'string', 'response.projectPath should be a string');
    assert.ok(body.projectPath.length > 0, 'projectPath should be non-empty');

    // Each item should have required fields
    for (const item of body.items) {
      assert.ok(item.id, 'item should have id');
      assert.ok(['mcp', 'skill'].includes(item.type), 'type should be mcp or skill');
      assert.ok(['cat-cafe', 'external'].includes(item.source), 'source should be cat-cafe or external');
      assert.equal(typeof item.enabled, 'boolean', 'enabled should be boolean');
      assert.ok(typeof item.cats === 'object', 'cats should be an object');
    }

    // catFamilies should have proper structure
    for (const family of body.catFamilies) {
      assert.ok(family.id, 'family should have id');
      assert.ok(family.name, 'family should have name');
      assert.ok(Array.isArray(family.catIds), 'family should have catIds array');
    }

    await app.close();
  });

  it('includes sanitized MCP server details in the board payload', async () => {
    const Fastify = (await import('fastify')).default;
    const { capabilitiesRoutes } = await import('../dist/routes/capabilities.js');

    const projectDir = await makeTmpDir('board-mcp-redact');
    await writeCapabilitiesConfig(projectDir, {
      version: 1,
      capabilities: [
        {
          id: 'secret-mcp',
          type: 'mcp',
          enabled: true,
          source: 'external',
          mcpServer: {
            command: 'node',
            args: ['server.js', '--api-key=inline-secret'],
            url: 'https://user:inline-secret@example.test/mcp?token=inline-secret',
            env: { API_KEY: 'raw-secret' },
            headers: { Authorization: 'Bearer raw-secret' },
          },
        },
      ],
    });

    const app = Fastify();
    await app.register(capabilitiesRoutes);
    await app.ready();

    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/capabilities?projectPath=${encodeURIComponent(projectDir)}`,
        headers: AUTH_HEADERS,
      });

      assert.equal(res.statusCode, 200, res.payload);
      assert.doesNotMatch(res.payload, /raw-secret|Bearer raw-secret|inline-secret/);
      const item = res.json().items.find((entry) => entry.id === 'secret-mcp');
      assert.ok(item, 'expected secret-mcp board item');
      assert.equal(item.mcpServer.command, undefined);
      assert.equal(item.mcpServer.args, undefined);
      assert.equal(item.mcpServer.url, undefined);
      assert.equal(item.mcpServer.env.API_KEY, REDACTED_SECRET);
      assert.equal(item.mcpServer.headers.Authorization, REDACTED_SECRET);
      assert.deepEqual(item.mcpServer.envKeys, ['API_KEY']);
    } finally {
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('includes MCP launch fields only for the configured owner session', async () => {
    const Fastify = (await import('fastify')).default;
    const { capabilitiesRoutes } = await import('../dist/routes/capabilities.js');

    const projectDir = await makeTmpDir('board-mcp-owner');
    const prevOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    await writeCapabilitiesConfig(projectDir, {
      version: 1,
      capabilities: [
        {
          id: 'owner-mcp',
          type: 'mcp',
          enabled: true,
          source: 'external',
          mcpServer: {
            transport: 'streamableHttp',
            command: 'node',
            args: ['server.js', '--api-key=inline-secret'],
            url: 'https://user:inline-secret@example.test/mcp?token=inline-secret',
            env: { API_KEY: 'raw-secret' },
            headers: { Authorization: 'Bearer raw-secret' },
          },
        },
      ],
    });

    const app = Fastify();
    app.addHook('preHandler', async (request) => {
      const raw = request.headers['x-test-session-user'];
      if (typeof raw === 'string' && raw.trim()) {
        request.sessionUserId = raw.trim();
      }
    });
    await app.register(capabilitiesRoutes);
    await app.ready();

    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/capabilities?projectPath=${encodeURIComponent(projectDir)}`,
        headers: OWNER_SESSION_HEADERS,
      });

      assert.equal(res.statusCode, 200, res.payload);
      const item = res.json().items.find((entry) => entry.id === 'owner-mcp');
      assert.ok(item, 'expected owner-mcp board item');
      assert.equal(item.mcpServer.command, 'node');
      assert.deepEqual(item.mcpServer.args, ['server.js', '--api-key=inline-secret']);
      assert.equal(item.mcpServer.url, 'https://user:inline-secret@example.test/mcp?token=inline-secret');
      assert.equal(item.mcpServer.env.API_KEY, REDACTED_SECRET);
      assert.equal(item.mcpServer.headers.Authorization, REDACTED_SECRET);
    } finally {
      if (prevOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = prevOwner;
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('includes Kimi mount state for cat-cafe skills in the board payload', async () => {
    const Fastify = (await import('fastify')).default;
    const { capabilitiesRoutes } = await import('../dist/routes/capabilities.js');

    const app = Fastify();
    await app.register(capabilitiesRoutes);
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/capabilities',
      headers: AUTH_HEADERS,
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();

    const catCafeSkill = (body.items ?? []).find(
      (item) => item.type === 'skill' && item.source === 'cat-cafe' && item.mounts,
    );
    assert.ok(catCafeSkill, 'expected at least one cat-cafe skill with mount data');
    assert.equal(typeof catCafeSkill.mounts.kimi, 'boolean');

    await app.close();
  });

  it('treats directory-level project skills symlinks as mounted for all providers', async () => {
    const previousCwd = process.cwd();
    const Fastify = (await import('fastify')).default;

    const mainDir = await makeTmpDir('dir-symlink-main');
    const projectDir = join('/tmp', `cap-route-test-dir-symlink-${Date.now()}`);
    const homeDir = join('/tmp', `cap-route-test-home-${Date.now()}`);
    const sourceSkillsDir = join(findRepoRoot(), 'cat-cafe-skills');
    const prevHome = process.env.HOME;

    await Promise.all([
      writeFile(join(mainDir, 'pnpm-workspace.yaml'), 'packages: []\n'),
      mkdir(join(projectDir, '.claude'), { recursive: true }),
      mkdir(join(projectDir, '.codex'), { recursive: true }),
      mkdir(join(projectDir, '.gemini'), { recursive: true }),
      mkdir(join(projectDir, '.kimi'), { recursive: true }),
      mkdir(homeDir, { recursive: true }),
    ]);
    await Promise.all([
      symlink(sourceSkillsDir, join(projectDir, '.claude', 'skills')),
      symlink(sourceSkillsDir, join(projectDir, '.codex', 'skills')),
      symlink(sourceSkillsDir, join(projectDir, '.gemini', 'skills')),
      symlink(sourceSkillsDir, join(projectDir, '.kimi', 'skills')),
    ]);
    await writeCapabilitiesConfig(projectDir, { version: 1, capabilities: [] });

    process.env.HOME = homeDir;
    process.chdir(mainDir);

    const routeModuleUrl = new URL(`../dist/routes/capabilities.js?dir-symlink=${Date.now()}`, import.meta.url);
    const { capabilitiesRoutes } = await import(routeModuleUrl.href);

    const app = Fastify();
    await app.register(capabilitiesRoutes);
    await app.ready();

    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/capabilities?projectPath=${encodeURIComponent(projectDir)}`,
        headers: AUTH_HEADERS,
      });

      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.skillHealth?.allMounted, true, 'project-level directory symlinks should count as mounted');

      const debugging = (body.items ?? []).find((item) => item.type === 'skill' && item.id === 'debugging');
      assert.ok(debugging, 'debugging skill should be present');
      assert.deepEqual(debugging.mounts, { claude: true, codex: true, gemini: true, kimi: true });
      assert.equal(debugging.cats.codex, true, 'project-level codex skills dir should enable OpenAI-family skills');
      assert.equal(debugging.cats.gemini, true, 'project-level gemini skills dir should enable Gemini-family skills');
      assert.equal(debugging.cats.kimi, true, 'project-level kimi skills dir should enable Kimi skills');
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      process.chdir(previousCwd);
      await app.close();
      await rm(mainDir, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('uses project mount rules for capability skill health', async () => {
    const Fastify = (await import('fastify')).default;
    const { capabilitiesRoutes } = await import('../dist/routes/capabilities.js');

    const projectDir = join('/tmp', `cap-route-test-mount-rules-${Date.now()}`);
    const homeDir = join('/tmp', `cap-route-test-mount-rules-home-${Date.now()}`);
    const sourceSkillsDir = join(findRepoRoot(), 'cat-cafe-skills');
    const customClaudeRoot = join(projectDir, '.project-claude', 'skills');
    const prevHome = process.env.HOME;

    await Promise.all([
      mkdir(join(projectDir, '.project-claude'), { recursive: true }),
      mkdir(homeDir, { recursive: true }),
    ]);
    // Sequential: both write to the same capabilities.json.  Write capabilities
    // first (full overwrite), then writeMountRules (read-modify-write adds mountRules).
    await writeCapabilitiesConfig(projectDir, { version: 1, capabilities: [] });
    await writeMountRules(projectDir, {
      version: 1,
      mountPoints: {
        claude: { enabled: true, path: '.project-claude/skills' },
        codex: { enabled: false, path: '.codex/skills' },
        gemini: { enabled: false, path: '.gemini/skills' },
        kimi: { enabled: false, path: '.kimi/skills' },
      },
      customPaths: [],
    });
    await symlink(sourceSkillsDir, customClaudeRoot);

    process.env.HOME = homeDir;

    const app = Fastify();
    await app.register(capabilitiesRoutes);
    await app.ready();

    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/capabilities?projectPath=${encodeURIComponent(projectDir)}`,
        headers: AUTH_HEADERS,
      });

      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(
        body.skillHealth?.allMounted,
        true,
        'custom enabled provider path should satisfy health while disabled providers are ignored',
      );
      const debugging = (body.items ?? []).find((item) => item.type === 'skill' && item.id === 'debugging');
      assert.ok(debugging, 'debugging skill should be present');
      assert.equal(debugging.mounts.claude, true);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('uses capability mountPaths as the required provider set for capability skill health', async () => {
    const Fastify = (await import('fastify')).default;
    const { capabilitiesRoutes } = await import('../dist/routes/capabilities.js');

    const projectDir = join('/tmp', `cap-route-test-mountpaths-health-${Date.now()}`);
    const homeDir = join('/tmp', `cap-route-test-mountpaths-health-home-${Date.now()}`);
    const sourceSkillsDir = join(findRepoRoot(), 'cat-cafe-skills');
    const prevHome = process.env.HOME;
    const sourceSkillNames = [];

    for (const entry of await readdir(sourceSkillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        await readFile(join(sourceSkillsDir, entry.name, 'SKILL.md'), 'utf-8');
        sourceSkillNames.push(entry.name);
      } catch {
        // reference folders are not skills
      }
    }
    assert.ok(sourceSkillNames.length > 0, 'expected source cat-cafe skills');

    await Promise.all([
      mkdir(join(projectDir, '.claude/skills'), { recursive: true }),
      mkdir(join(projectDir, '.codex/skills'), { recursive: true }),
      mkdir(join(projectDir, '.gemini/skills'), { recursive: true }),
      mkdir(join(projectDir, '.kimi/skills'), { recursive: true }),
      mkdir(homeDir, { recursive: true }),
      writeCapabilitiesConfig(projectDir, {
        version: 2,
        capabilities: sourceSkillNames.map((id) => ({
          id,
          type: 'skill',
          enabled: true,
          source: 'cat-cafe',
          mountPaths: ['claude', 'codex', 'gemini'],
        })),
      }),
    ]);
    for (const provider of ['claude', 'codex', 'gemini']) {
      await Promise.all(
        sourceSkillNames.map((name) =>
          symlink(join(sourceSkillsDir, name), join(projectDir, `.${provider}/skills`, name)),
        ),
      );
    }
    process.env.HOME = homeDir;

    const app = Fastify();
    await app.register(capabilitiesRoutes);
    await app.ready();

    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/capabilities?projectPath=${encodeURIComponent(projectDir)}`,
        headers: AUTH_HEADERS,
      });

      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.skillHealth?.allMounted, true, 'unlisted kimi mount should not keep health red');
      const debugging = (body.items ?? []).find((item) => item.type === 'skill' && item.id === 'debugging');
      assert.ok(debugging, 'debugging skill should be present');
      assert.deepEqual(debugging.mounts, { claude: true, codex: true, gemini: true, kimi: false });
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('uses non-empty mountPaths for capability skill health even when cap.enabled is stale false', async () => {
    const Fastify = (await import('fastify')).default;
    const { capabilitiesRoutes } = await import('../dist/routes/capabilities.js');

    const projectDir = join('/tmp', `cap-route-test-mountpaths-stale-enabled-${Date.now()}`);
    const homeDir = join('/tmp', `cap-route-test-mountpaths-stale-enabled-home-${Date.now()}`);
    const sourceSkillsDir = join(findRepoRoot(), 'cat-cafe-skills');
    const prevHome = process.env.HOME;
    const sourceSkillNames = [];

    for (const entry of await readdir(sourceSkillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        await readFile(join(sourceSkillsDir, entry.name, 'SKILL.md'), 'utf-8');
        sourceSkillNames.push(entry.name);
      } catch {
        // reference folders are not skills
      }
    }
    assert.ok(sourceSkillNames.length > 0, 'expected source cat-cafe skills');

    await Promise.all([
      mkdir(join(projectDir, '.claude/skills'), { recursive: true }),
      mkdir(join(projectDir, '.codex/skills'), { recursive: true }),
      mkdir(join(projectDir, '.gemini/skills'), { recursive: true }),
      mkdir(join(projectDir, '.kimi/skills'), { recursive: true }),
      mkdir(homeDir, { recursive: true }),
      writeCapabilitiesConfig(projectDir, {
        version: 2,
        capabilities: sourceSkillNames.map((id) => ({
          id,
          type: 'skill',
          enabled: false,
          source: 'cat-cafe',
          mountPaths: id === 'debugging' ? ['claude'] : [],
        })),
      }),
    ]);
    process.env.HOME = homeDir;

    const app = Fastify();
    await app.register(capabilitiesRoutes);
    await app.ready();

    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/capabilities?projectPath=${encodeURIComponent(projectDir)}`,
        headers: AUTH_HEADERS,
      });

      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.skillHealth?.allMounted, false, 'declared mountPaths without real symlink should be unhealthy');
      const debugging = (body.items ?? []).find((item) => item.type === 'skill' && item.id === 'debugging');
      assert.ok(debugging, 'debugging skill should be present');
      assert.deepEqual(debugging.mountPaths, ['claude']);
      assert.equal(debugging.mounts.claude, false, 'declared claude mount is missing on disk');
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('includes custom mount paths in capability skill health', async () => {
    const Fastify = (await import('fastify')).default;
    const { capabilitiesRoutes } = await import('../dist/routes/capabilities.js');

    const projectDir = join('/tmp', `cap-route-test-custom-health-${Date.now()}`);
    const homeDir = join('/tmp', `cap-route-test-custom-health-home-${Date.now()}`);
    const sourceSkillsDir = join(findRepoRoot(), 'cat-cafe-skills');
    const customSkillsDir = join('custom-client', 'skills');
    const customSkillsDirPath = join(projectDir, customSkillsDir);
    const prevHome = process.env.HOME;
    const sourceSkillNames = [];

    for (const entry of await readdir(sourceSkillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        await readFile(join(sourceSkillsDir, entry.name, 'SKILL.md'), 'utf-8');
        sourceSkillNames.push(entry.name);
      } catch {
        // reference folders are not skills
      }
    }
    assert.ok(sourceSkillNames.length > 0, 'expected source cat-cafe skills');

    await Promise.all([
      mkdir(customSkillsDirPath, { recursive: true }),
      mkdir(homeDir, { recursive: true }),
      writeCapabilitiesConfig(projectDir, {
        version: 2,
        capabilities: [{ id: 'debugging', type: 'skill', enabled: true, source: 'cat-cafe', mountPaths: ['acp'] }],
        mountRules: [
          { name: 'claude', path: '.claude/skills', enabled: false },
          { name: 'codex', path: '.codex/skills', enabled: false },
          { name: 'gemini', path: '.gemini/skills', enabled: false },
          { name: 'kimi', path: '.kimi/skills', enabled: false },
          { name: 'acp', path: customSkillsDir, enabled: true },
        ],
      }),
    ]);

    process.env.HOME = homeDir;

    const app = Fastify();
    await app.register(capabilitiesRoutes);
    await app.ready();

    try {
      const missingRes = await app.inject({
        method: 'GET',
        url: `/api/capabilities?projectPath=${encodeURIComponent(projectDir)}`,
        headers: AUTH_HEADERS,
      });

      assert.equal(missingRes.statusCode, 200);
      const missingBody = missingRes.json();
      assert.equal(
        missingBody.skillHealth?.allMounted,
        false,
        'missing custom-path skill links should make health unhealthy',
      );

      await Promise.all(
        sourceSkillNames.map((name) => symlink(join(sourceSkillsDir, name), join(customSkillsDirPath, name))),
      );
      const mountedRes = await app.inject({
        method: 'GET',
        url: `/api/capabilities?projectPath=${encodeURIComponent(projectDir)}`,
        headers: AUTH_HEADERS,
      });

      assert.equal(mountedRes.statusCode, 200);
      const mountedBody = mountedRes.json();
      assert.equal(
        mountedBody.skillHealth?.allMounted,
        true,
        'custom-path skill links should satisfy health when standard providers are disabled',
      );
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('excludes disabled cat-cafe skills from capability skill health', async () => {
    const Fastify = (await import('fastify')).default;
    const { capabilitiesRoutes } = await import('../dist/routes/capabilities.js');

    const projectDir = join('/tmp', `cap-route-test-disabled-skill-health-${Date.now()}`);
    const homeDir = join('/tmp', `cap-route-test-disabled-skill-health-home-${Date.now()}`);
    const sourceSkillsDir = join(findRepoRoot(), 'cat-cafe-skills');
    const claudeSkillsDir = join(projectDir, '.claude', 'skills');
    const prevHome = process.env.HOME;
    const sourceSkillNames = [];

    for (const entry of await readdir(sourceSkillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        await readFile(join(sourceSkillsDir, entry.name, 'SKILL.md'), 'utf-8');
        sourceSkillNames.push(entry.name);
      } catch {
        // reference folders are not skills
      }
    }
    assert.ok(sourceSkillNames.length > 0, 'expected source cat-cafe skills');
    const disabledSkill = sourceSkillNames.includes('debugging') ? 'debugging' : sourceSkillNames[0];

    await Promise.all([mkdir(claudeSkillsDir, { recursive: true }), mkdir(homeDir, { recursive: true })]);
    // Sequential: both write to the same capabilities.json.  Write capabilities
    // first (full overwrite), then writeMountRules (read-modify-write adds mountRules).
    await writeCapabilitiesConfig(projectDir, {
      version: 1,
      capabilities: sourceSkillNames.map((id) => ({
        id,
        type: 'skill',
        enabled: id !== disabledSkill,
        source: 'cat-cafe',
      })),
    });
    await writeMountRules(projectDir, {
      version: 1,
      mountPoints: {
        claude: { enabled: true, path: '.claude/skills' },
        codex: { enabled: false, path: '.codex/skills' },
        gemini: { enabled: false, path: '.gemini/skills' },
        kimi: { enabled: false, path: '.kimi/skills' },
      },
      customPaths: [],
    });
    await Promise.all(
      sourceSkillNames
        .filter((name) => name !== disabledSkill)
        .map((name) => symlink(join(sourceSkillsDir, name), join(claudeSkillsDir, name))),
    );

    process.env.HOME = homeDir;

    const app = Fastify();
    await app.register(capabilitiesRoutes);
    await app.ready();

    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/capabilities?projectPath=${encodeURIComponent(projectDir)}`,
        headers: AUTH_HEADERS,
      });

      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.skillHealth?.allMounted, true, 'disabled skills should not require provider mounts');
      const disabledItem = (body.items ?? []).find((item) => item.type === 'skill' && item.id === disabledSkill);
      assert.ok(disabledItem, 'disabled skill should remain visible in the board');
      assert.equal(disabledItem.enabled, false);
      assert.equal(disabledItem.mounts.claude, false, 'disabled skill symlink should be absent');
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('does not downgrade cat-cafe source when codex project scan fails', async () => {
    const Fastify = (await import('fastify')).default;

    const projectDir = join('/tmp', `cap-route-test-source-guard-${Date.now()}`);
    const homeDir = join('/tmp', `cap-route-test-source-guard-home-${Date.now()}`);
    const codexSkillsDir = join(projectDir, '.codex', 'skills');
    const prevHome = process.env.HOME;

    await mkdir(join(projectDir, '.codex'), { recursive: true });
    await Promise.all([
      mkdir(homeDir, { recursive: true }),
      writeFile(codexSkillsDir, 'not-a-directory'),
      writeCapabilitiesConfig(projectDir, {
        version: 1,
        capabilities: [{ id: 'custom-skill', type: 'skill', enabled: true, source: 'cat-cafe' }],
      }),
    ]);

    process.env.HOME = homeDir;

    const { capabilitiesRoutes } = await import(`../dist/routes/capabilities.js?t=${Date.now()}`);
    const app = Fastify();
    await app.register(capabilitiesRoutes);
    await app.ready();

    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/capabilities?projectPath=${encodeURIComponent(projectDir)}`,
        headers: AUTH_HEADERS,
      });

      assert.equal(res.statusCode, 200);
      const body = res.json();
      const customSkill = (body.items ?? []).find((item) => item.type === 'skill' && item.id === 'custom-skill');
      assert.ok(customSkill, 'custom skill should remain in the payload');
      assert.equal(
        customSkill.source,
        'cat-cafe',
        'failed codex project scan must not downgrade an existing cat-cafe skill to external',
      );
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('does not treat cat-cafe-skills/refs as a skill', async () => {
    const Fastify = (await import('fastify')).default;
    const { capabilitiesRoutes } = await import('../dist/routes/capabilities.js');

    const app = Fastify();
    await app.register(capabilitiesRoutes);
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/capabilities',
      headers: AUTH_HEADERS,
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();

    const catCafeSkillIds = (body.items ?? [])
      .filter((i) => i.type === 'skill' && i.source === 'cat-cafe')
      .map((i) => i.id);
    assert.ok(!catCafeSkillIds.includes('refs'), 'refs/ is a reference folder, not a skill');

    assert.ok(body.skillHealth, 'response.skillHealth should exist');
    assert.ok(!(body.skillHealth.unregistered ?? []).includes('refs'), 'refs should not be reported as unregistered');

    await app.close();
  });

  it('ignores broken project skill symlinks for deleted skills', async () => {
    const Fastify = (await import('fastify')).default;
    const { capabilitiesRoutes } = await import('../dist/routes/capabilities.js');

    // Use a dir under cwd (not /tmp/) so PROJECT_ALLOWED_ROOTS validation passes in public gate
    const projectDir = join(process.cwd(), `.test-tmp-broken-skill-${Date.now()}`);
    const staleSkill = `ghost-skill-${Date.now()}`;
    const skillsDir = join(projectDir, '.claude', 'skills');
    const brokenLink = join(skillsDir, staleSkill);

    await mkdir(skillsDir, { recursive: true });
    await symlink('../../cat-cafe-skills/parallel-execution', brokenLink);

    const app = Fastify();
    await app.register(capabilitiesRoutes);
    await app.ready();

    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/capabilities?projectPath=${encodeURIComponent(projectDir)}`,
        headers: AUTH_HEADERS,
      });

      assert.equal(res.statusCode, 200);
      const body = res.json();

      const staleItem = (body.items ?? []).find((i) => i.type === 'skill' && i.id === staleSkill);
      assert.equal(staleItem, undefined, 'broken project symlink should not resurrect a deleted skill');
    } finally {
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('accepts ?projectPath query param for multi-project support', async () => {
    const Fastify = (await import('fastify')).default;
    const { capabilitiesRoutes } = await import('../dist/routes/capabilities.js');

    const app = Fastify();
    await app.register(capabilitiesRoutes);
    await app.ready();

    // Create a temp directory under /tmp (must be within allowed roots)
    const projectDir = join('/tmp', `cap-route-test-multi-project-${Date.now()}`);
    await mkdir(projectDir, { recursive: true });

    const res = await app.inject({
      method: 'GET',
      url: `/api/capabilities?projectPath=${encodeURIComponent(projectDir)}`,
      headers: AUTH_HEADERS,
    });

    const body = res.json();
    assert.equal(res.statusCode, 200, `Expected 200, got ${res.statusCode}: ${JSON.stringify(body)}`);
    assert.ok(Array.isArray(body.items), 'items should be an array');
    // projectPath should be the validated (realpath-resolved) path
    assert.ok(body.projectPath.includes('cap-route-test'), 'projectPath should contain our test dir name');

    await rm(projectDir, { recursive: true, force: true });
    await app.close();
  });

  it('returns only catCafeRoot and projectRoot (not governance registry)', async () => {
    const { buildKnownProjectPaths } = await import('../dist/routes/capabilities.js');

    const catCafeRoot = await makeTmpDir('known-projects-main');
    const selectedProject = await makeTmpDir('known-projects-selected');

    try {
      const knownProjectPaths = await buildKnownProjectPaths(catCafeRoot, selectedProject);
      assert.deepEqual(
        new Set(knownProjectPaths),
        new Set([catCafeRoot, selectedProject]),
        'knownProjectPaths should only include catCafeRoot and selected project; ' +
          'thread-derived project paths are merged client-side',
      );
    } finally {
      await rm(catCafeRoot, { recursive: true, force: true });
      await rm(selectedProject, { recursive: true, force: true });
    }
  });

  it('discovers antigravity MCP from homedir instead of a stale project-local file', async () => {
    const Fastify = (await import('fastify')).default;
    const { capabilitiesRoutes } = await import('../dist/routes/capabilities.js');

    const projectDir = join('/tmp', `cap-route-test-antigravity-home-${Date.now()}`);
    const homeDir = join('/tmp', `cap-route-test-antigravity-home-root-${Date.now()}`);
    const prevHome = process.env.HOME;
    await mkdir(join(projectDir, '.gemini', 'antigravity'), { recursive: true });
    await mkdir(join(homeDir, '.gemini', 'antigravity'), { recursive: true });
    await writeCapabilitiesConfig(projectDir, { version: 1, capabilities: [] });
    await writeFile(
      join(projectDir, '.gemini', 'antigravity', 'mcp_config.json'),
      JSON.stringify({
        mcpServers: {
          shared_tool: { command: 'project-stale-command', args: ['--stale'] },
        },
      }),
    );
    await writeFile(
      join(homeDir, '.gemini', 'antigravity', 'mcp_config.json'),
      JSON.stringify({
        mcpServers: {
          shared_tool: { command: 'home-real-command', args: ['--real'] },
        },
      }),
    );

    process.env.HOME = homeDir;
    const app = Fastify();
    await app.register(capabilitiesRoutes);
    await app.ready();

    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/capabilities?projectPath=${encodeURIComponent(projectDir)}`,
        headers: AUTH_HEADERS,
      });

      assert.equal(res.statusCode, 200);
      const config = await readCapabilitiesConfig(projectDir);
      const discovered = config?.capabilities.find((item) => item.type === 'mcp' && item.id === 'shared_tool');
      assert.ok(discovered, 'shared_tool should be discovered into capabilities.json');
      assert.equal(discovered?.mcpServer?.command, 'home-real-command');
      assert.deepEqual(discovered?.mcpServer?.args, ['--real']);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('realigns stale managed cat-cafe MCP paths to the stable main repo root on GET', async () => {
    const Fastify = (await import('fastify')).default;
    const { capabilitiesRoutes } = await import('../dist/routes/capabilities.js');
    const { resolveMainRepoPath } = await import('../dist/utils/skill-mount.js');

    const projectDir = join('/tmp', `cap-route-test-stale-cat-cafe-path-${Date.now()}`);
    await mkdir(projectDir, { recursive: true });
    await writeCapabilitiesConfig(projectDir, {
      version: 1,
      capabilities: [
        {
          id: 'cat-cafe',
          type: 'mcp',
          enabled: true,
          source: 'cat-cafe',
          mcpServer: {
            command: 'node',
            args: ['/tmp/deleted-worktree/packages/mcp-server/dist/index.js'],
          },
        },
      ],
    });

    const app = Fastify();
    await app.register(capabilitiesRoutes);
    await app.ready();

    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/capabilities?projectPath=${encodeURIComponent(projectDir)}`,
        headers: AUTH_HEADERS,
      });

      assert.equal(res.statusCode, 200);
      const stableRoot = await resolveMainRepoPath();
      const config = await readCapabilitiesConfig(projectDir);
      const managedEntries = config?.capabilities.filter(
        (item) => item.type === 'mcp' && item.source === 'cat-cafe' && item.id.startsWith('cat-cafe'),
      );
      assert.ok((managedEntries?.length ?? 0) >= 1);
      for (const entry of managedEntries ?? []) {
        assert.ok(
          entry.mcpServer?.args?.[0]?.includes(`${stableRoot}/packages/mcp-server/dist/`),
          `managed MCP "${entry.id}" should be rewritten to the stable main repo root`,
        );
      }
    } finally {
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('uses selected project plugin manifests for plugin-owned skill pruning', async () => {
    const Fastify = (await import('fastify')).default;
    const { capabilitiesRoutes } = await import('../dist/routes/capabilities.js');

    const pluginId = `project-plugin-${Date.now()}`;
    const projectDir = await makeTmpDir('project-plugin-skill-prune');
    const pluginDir = join(projectDir, 'plugins', pluginId);
    await mkdir(join(pluginDir, 'skills', 'project-skill'), { recursive: true });
    await writeFile(join(pluginDir, 'skills', 'project-skill', 'SKILL.md'), '# project skill\n');
    await mkdir(join(projectDir, '.claude', 'skills', 'old-project-skill'), { recursive: true });
    await writeFile(join(projectDir, '.claude', 'skills', 'old-project-skill', 'SKILL.md'), '# stale skill\n');
    await writeFile(
      join(pluginDir, 'plugin.yaml'),
      [
        `id: ${pluginId}`,
        'name: Project Plugin',
        'version: "1.0.0"',
        'resources:',
        '  - type: skill',
        '    path: skills/project-skill',
      ].join('\n'),
    );
    await writeCapabilitiesConfig(projectDir, {
      version: 1,
      capabilities: [
        {
          id: 'project-skill',
          type: 'skill',
          enabled: true,
          source: 'cat-cafe',
          pluginId,
        },
        {
          id: 'old-project-skill',
          type: 'skill',
          enabled: true,
          source: 'cat-cafe',
          pluginId,
        },
      ],
    });

    const app = Fastify();
    await app.register(capabilitiesRoutes);
    await app.ready();

    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/capabilities?projectPath=${encodeURIComponent(projectDir)}`,
        headers: AUTH_HEADERS,
      });

      assert.equal(res.statusCode, 200, res.payload);
      const config = await readCapabilitiesConfig(projectDir);
      const preserved = config?.capabilities.find((item) => item.id === 'project-skill');
      assert.ok(preserved, 'project-local declared plugin-owned skill should survive pruning');
      assert.equal(preserved.pluginId, pluginId);
      const stale = config?.capabilities.find((item) => item.id === 'old-project-skill');
      assert.equal(stale, undefined, 'project-local undeclared plugin-owned skill should still be pruned');
      const body = res.json();
      assert.equal(
        body.skillHealth?.registrationConsistent,
        true,
        'plugin-owned skills should not be treated as phantom Clowder AI source-tree registrations',
      );
      assert.deepEqual(body.skillHealth?.phantom, []);
    } finally {
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('creates Clowder AI source skill capability beside a same-id plugin-owned skill on GET', async () => {
    const previousCwd = process.cwd();
    const Fastify = (await import('fastify')).default;

    const pluginId = `same-id-source-plugin-${Date.now()}`;
    const mainDir = await makeTmpDir('source-plugin-main');
    const projectDir = await makeTmpDir('source-plugin-same-id');
    const pluginDir = join(projectDir, 'plugins', pluginId);
    await writeFile(join(mainDir, 'pnpm-workspace.yaml'), 'packages: []\n');
    await mkdir(join(pluginDir, 'skills', 'debugging'), { recursive: true });
    await writeFile(join(pluginDir, 'skills', 'debugging', 'SKILL.md'), '# plugin debugging\n');
    await writeFile(
      join(pluginDir, 'plugin.yaml'),
      [
        `id: ${pluginId}`,
        'name: Same ID Source Plugin',
        'version: "1.0.0"',
        'resources:',
        '  - type: skill',
        '    path: skills/debugging',
      ].join('\n'),
    );
    await writeCapabilitiesConfig(projectDir, {
      version: 2,
      capabilities: [
        {
          id: 'debugging',
          type: 'skill',
          enabled: true,
          source: 'cat-cafe',
          pluginId,
          mountPaths: ['claude'],
        },
      ],
    });
    process.chdir(mainDir);
    const routeModuleUrl = new URL(`../dist/routes/capabilities.js?source-plugin=${Date.now()}`, import.meta.url);
    const { capabilitiesRoutes } = await import(routeModuleUrl.href);
    const app = Fastify();
    await app.register(capabilitiesRoutes);
    await app.ready();

    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/capabilities?projectPath=${encodeURIComponent(projectDir)}`,
        headers: AUTH_HEADERS,
      });

      assert.equal(res.statusCode, 200, res.payload);
      const config = await readCapabilitiesConfig(projectDir);
      const pluginCap = config?.capabilities.find((item) => item.id === 'debugging' && item.pluginId === pluginId);
      assert.ok(pluginCap, 'declared plugin-owned skill should survive');
      assert.deepEqual(pluginCap.mountPaths, ['claude']);
      const catCafeCap = config?.capabilities.find((item) => item.id === 'debugging' && !item.pluginId);
      assert.ok(catCafeCap, 'source Clowder AI skill should get its own non-plugin capability');
      assert.equal(catCafeCap.source, 'cat-cafe');
      assert.equal(catCafeCap.enabled, true);
    } finally {
      await app.close();
      process.chdir(previousCwd);
      await rm(mainDir, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('preserves same-id external skill capability when adding Clowder AI source skill on GET', async () => {
    const previousCwd = process.cwd();
    const Fastify = (await import('fastify')).default;

    const mainDir = await makeTmpDir('source-external-main');
    const projectDir = await makeTmpDir('source-external-same-id');
    await writeFile(join(mainDir, 'pnpm-workspace.yaml'), 'packages: []\n');
    await mkdir(join(projectDir, '.claude', 'skills', 'debugging'), { recursive: true });
    await writeFile(join(projectDir, '.claude', 'skills', 'debugging', 'SKILL.md'), '# external debugging\n');
    await writeCapabilitiesConfig(projectDir, {
      version: 2,
      capabilities: [
        {
          id: 'debugging',
          type: 'skill',
          enabled: true,
          source: 'external',
          mountPaths: ['claude'],
        },
      ],
    });
    process.chdir(mainDir);
    const routeModuleUrl = new URL(`../dist/routes/capabilities.js?source-external=${Date.now()}`, import.meta.url);
    const { capabilitiesRoutes } = await import(routeModuleUrl.href);
    const app = Fastify();
    await app.register(capabilitiesRoutes);
    await app.ready();

    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/capabilities?projectPath=${encodeURIComponent(projectDir)}`,
        headers: AUTH_HEADERS,
      });

      assert.equal(res.statusCode, 200, res.payload);
      const config = await readCapabilitiesConfig(projectDir);
      const externalCap = config?.capabilities.find(
        (item) => item.id === 'debugging' && item.type === 'skill' && item.source === 'external',
      );
      assert.ok(externalCap, 'same-id external skill should remain external');
      assert.deepEqual(externalCap.mountPaths, ['claude']);
      const catCafeCap = config?.capabilities.find(
        (item) => item.id === 'debugging' && item.type === 'skill' && item.source === 'cat-cafe' && !item.pluginId,
      );
      assert.ok(catCafeCap, 'source Clowder AI skill should get its own non-external capability');
      assert.equal(catCafeCap.enabled, true);
    } finally {
      await app.close();
      process.chdir(previousCwd);
      await rm(mainDir, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('seeds discovered Clowder AI skills from global disabled policy on GET', async () => {
    const previousCwd = process.cwd();
    const previousHome = process.env.HOME;
    const Fastify = (await import('fastify')).default;

    const mainDir = await makeTmpDir('source-global-disabled-main');
    const projectDir = await makeTmpDir('source-global-disabled-external');
    const homeDir = await makeTmpDir('source-global-disabled-home');
    const skillId = 'debugging';

    await writeFile(join(mainDir, 'pnpm-workspace.yaml'), 'packages: []\n');
    await writeCapabilitiesConfig(mainDir, {
      version: 2,
      capabilities: [{ id: skillId, type: 'skill', enabled: false, source: 'cat-cafe', mountPaths: [] }],
    });
    await writeCapabilitiesConfig(projectDir, { version: 2, capabilities: [] });
    process.env.HOME = homeDir;
    process.chdir(mainDir);

    const { capabilitiesRoutes } = await import(`../dist/routes/capabilities.js?t=${Date.now()}`);
    const app = Fastify();
    await app.register(capabilitiesRoutes);
    await app.ready();

    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/capabilities?projectPath=${encodeURIComponent(projectDir)}`,
        headers: AUTH_HEADERS,
      });

      assert.equal(res.statusCode, 200, res.payload);
      const config = await readCapabilitiesConfig(projectDir);
      const catCafeCap = config?.capabilities.find(
        (item) => item.id === skillId && item.type === 'skill' && item.source === 'cat-cafe' && !item.pluginId,
      );
      assert.ok(catCafeCap, 'source Clowder AI skill should get a project capability row');
      assert.equal(catCafeCap.enabled, false, 'global disabled state should seed external discovery');
      assert.deepEqual(catCafeCap.mountPaths, [], 'global empty mountPaths should seed external discovery');
    } finally {
      await app.close();
      process.chdir(previousCwd);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await rm(mainDir, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('seeds global disabled policy for external project with custom mount targets', async () => {
    const previousCwd = process.cwd();
    const previousHome = process.env.HOME;
    const Fastify = (await import('fastify')).default;

    const mainDir = await makeTmpDir('seed-custom-mount-main');
    const projectDir = await makeTmpDir('seed-custom-mount-external');
    const homeDir = await makeTmpDir('seed-custom-mount-home');
    const skillId = 'debugging';

    await writeFile(join(mainDir, 'pnpm-workspace.yaml'), 'packages: []\n');
    await writeCapabilitiesConfig(mainDir, {
      version: 2,
      capabilities: [{ id: skillId, type: 'skill', enabled: false, source: 'cat-cafe', mountPaths: [] }],
    });
    // External project has custom mount target but empty capabilities
    await writeMountRules(projectDir, {
      version: 1,
      mountPoints: {
        claude: { enabled: true, path: '.claude/skills' },
        codex: { enabled: true, path: '.codex/skills' },
        gemini: { enabled: true, path: '.gemini/skills' },
        kimi: { enabled: true, path: '.kimi/skills' },
      },
      customPaths: [{ alias: 'acp-client', path: '.acp/skills' }],
    });
    await writeCapabilitiesConfig(projectDir, { version: 2, capabilities: [] });
    process.env.HOME = homeDir;
    process.chdir(mainDir);

    const routeModuleUrl = new URL(`../dist/routes/capabilities.js?seed-custom=${Date.now()}`, import.meta.url);
    const { capabilitiesRoutes } = await import(routeModuleUrl.href);
    const app = Fastify();
    await app.register(capabilitiesRoutes);
    await app.ready();

    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/capabilities?projectPath=${encodeURIComponent(projectDir)}`,
        headers: AUTH_HEADERS,
      });

      assert.equal(res.statusCode, 200, res.payload);
      const config = await readCapabilitiesConfig(projectDir);
      const catCafeCap = config?.capabilities.find(
        (item) => item.id === skillId && item.type === 'skill' && item.source === 'cat-cafe' && !item.pluginId,
      );
      assert.ok(catCafeCap, 'Clowder AI skill should be seeded even with custom mount targets');
      assert.equal(catCafeCap.enabled, false, 'global disabled state must seed despite custom mount target');
      assert.deepEqual(catCafeCap.mountPaths, [], 'global empty mountPaths must seed despite custom mount target');
    } finally {
      await app.close();
      process.chdir(previousCwd);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await rm(mainDir, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('prunes plugin-owned skills with no manifest and no filesystem backing', async () => {
    const Fastify = (await import('fastify')).default;
    const { capabilitiesRoutes } = await import('../dist/routes/capabilities.js');

    const projectDir = await makeTmpDir('plugin-skill-missing-manifest');
    await writeCapabilitiesConfig(projectDir, {
      version: 1,
      capabilities: [
        {
          id: 'orphan-plugin-skill',
          type: 'skill',
          enabled: true,
          source: 'cat-cafe',
          pluginId: 'missing-plugin',
        },
      ],
    });

    const app = Fastify();
    await app.register(capabilitiesRoutes);
    await app.ready();

    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/capabilities?projectPath=${encodeURIComponent(projectDir)}`,
        headers: AUTH_HEADERS,
      });

      assert.equal(res.statusCode, 200, res.payload);
      const config = await readCapabilitiesConfig(projectDir);
      assert.equal(
        config?.capabilities.some((item) => item.id === 'orphan-plugin-skill'),
        false,
        'plugin-owned skill without manifest or filesystem backing should be pruned',
      );
    } finally {
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('prunes plugin-owned skills no longer declared by the canonical plugin manifest', async () => {
    const Fastify = (await import('fastify')).default;
    const { capabilitiesRoutes } = await import('../dist/routes/capabilities.js');

    const pluginId = `cap-prune-${Date.now()}`;
    const repoRoot = findRepoRoot();
    const pluginDir = join(repoRoot, 'plugins', pluginId);
    await mkdir(join(pluginDir, 'skills', 'current'), { recursive: true });
    await writeFile(
      join(pluginDir, 'plugin.yaml'),
      [
        `id: ${pluginId}`,
        'name: Capability Prune Test',
        'version: "1.0.0"',
        'resources:',
        '  - type: skill',
        '    path: skills/current',
      ].join('\n'),
    );

    const projectDir = await makeTmpDir('plugin-skill-canonical-root');
    await mkdir(join(projectDir, '.claude', 'skills', 'old'), { recursive: true });
    await writeFile(join(projectDir, '.claude', 'skills', 'old', 'SKILL.md'), '# stale mounted plugin skill\n');
    const currentSkill = {
      id: 'current',
      type: 'skill',
      enabled: true,
      source: 'cat-cafe',
      pluginId,
    };
    const staleSkill = {
      id: 'old',
      type: 'skill',
      enabled: true,
      source: 'cat-cafe',
      pluginId,
    };
    await writeCapabilitiesConfig(projectDir, {
      version: 1,
      capabilities: [currentSkill, staleSkill],
    });

    const app = Fastify();
    await app.register(capabilitiesRoutes);
    await app.ready();

    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/capabilities?projectPath=${encodeURIComponent(projectDir)}`,
        headers: AUTH_HEADERS,
      });

      assert.equal(res.statusCode, 200, res.payload);
      const config = await readCapabilitiesConfig(projectDir);
      const preserved = config?.capabilities.find((item) => item.id === currentSkill.id);
      assert.ok(preserved, 'declared plugin-owned skill should survive pruning');
      assert.equal(preserved.pluginId, pluginId);
      const stale = config?.capabilities.find((item) => item.id === staleSkill.id);
      assert.equal(stale, undefined, 'removed plugin-owned skill should be pruned even when plugin dir exists');
    } finally {
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
      await rm(pluginDir, { recursive: true, force: true });
    }
  });

  it('continues plugin-owned skill pruning when one selected-project plugin manifest is invalid', async () => {
    const Fastify = (await import('fastify')).default;
    const { capabilitiesRoutes } = await import('../dist/routes/capabilities.js');

    const pluginId = `valid-prune-${Date.now()}`;
    const projectDir = await makeTmpDir('plugin-skill-invalid-manifest');
    const validPluginDir = join(projectDir, 'plugins', pluginId);
    const invalidPluginDir = join(projectDir, 'plugins', 'bad-plugin');
    await mkdir(join(validPluginDir, 'skills', 'current'), { recursive: true });
    await writeFile(
      join(validPluginDir, 'plugin.yaml'),
      [
        `id: ${pluginId}`,
        'name: Valid Prune Plugin',
        'version: "1.0.0"',
        'resources:',
        '  - type: skill',
        '    path: skills/current',
      ].join('\n'),
    );
    await mkdir(invalidPluginDir, { recursive: true });
    await writeFile(
      join(invalidPluginDir, 'plugin.yaml'),
      [
        'id: bad-plugin',
        'name: Bad Plugin',
        'version: "1.0.0"',
        'resources:',
        '  - type: skill',
        '    path: ../escape',
      ].join('\n'),
    );

    await writeCapabilitiesConfig(projectDir, {
      version: 1,
      capabilities: [
        {
          id: 'current',
          type: 'skill',
          enabled: true,
          source: 'cat-cafe',
          pluginId,
        },
        {
          id: 'old',
          type: 'skill',
          enabled: true,
          source: 'cat-cafe',
          pluginId,
        },
      ],
    });

    const app = Fastify();
    await app.register(capabilitiesRoutes);
    await app.ready();

    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/capabilities?projectPath=${encodeURIComponent(projectDir)}`,
        headers: AUTH_HEADERS,
      });

      assert.equal(res.statusCode, 200, res.payload);
      const config = await readCapabilitiesConfig(projectDir);
      assert.ok(
        config?.capabilities.find((item) => item.id === 'current'),
        'valid plugin skill should survive',
      );
      assert.equal(
        config?.capabilities.some((item) => item.id === 'old'),
        false,
        'invalid sibling plugin manifest should not disable pruning for valid plugin skills',
      );
    } finally {
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('returns 400 for invalid projectPath', async () => {
    const Fastify = (await import('fastify')).default;
    const { capabilitiesRoutes } = await import('../dist/routes/capabilities.js');

    const app = Fastify();
    await app.register(capabilitiesRoutes);
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/capabilities?projectPath=/nonexistent/path/xyz',
      headers: AUTH_HEADERS,
    });

    assert.equal(res.statusCode, 400);
    assert.ok(res.json().error.includes('Invalid project path'));

    await app.close();
  });

  it('probe=true returns MCP connection status and tool list', async () => {
    const Fastify = (await import('fastify')).default;
    const { capabilitiesRoutes } = await import('../dist/routes/capabilities.js');

    const app = Fastify();
    await app.register(capabilitiesRoutes);
    await app.ready();

    const projectDir = join('/tmp', `cap-route-test-probe-connected-${Date.now()}`);
    await mkdir(projectDir, { recursive: true });
    const probeCode = inlineProbeServerCode(process.cwd());

    await writeCapabilitiesConfig(projectDir, {
      version: 1,
      capabilities: [
        {
          id: 'probe-connected',
          type: 'mcp',
          enabled: true,
          source: 'external',
          mcpServer: {
            command: 'node',
            args: ['--input-type=module', '--eval', probeCode],
            workingDir: process.cwd(),
          },
        },
      ],
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/capabilities?projectPath=${encodeURIComponent(projectDir)}&probe=true`,
      headers: AUTH_HEADERS,
    });
    assert.equal(res.statusCode, 200);

    const body = res.json();
    const item = body.items.find((i) => i.type === 'mcp' && i.id === 'probe-connected');
    assert.ok(item, 'Probe MCP item should exist');
    assert.equal(item.connectionStatus, 'connected', 'Probe status should be connected');
    assert.ok(Array.isArray(item.tools), 'tools should be present when probe=true');
    assert.ok(
      item.tools.some((tool) => tool.name === 'probe_echo'),
      'probe_echo should be discovered from tools/list',
    );

    await rm(projectDir, { recursive: true, force: true });
    await app.close();
  });

  it('probe=true still probes when global disabled but per-cat override enabled', async () => {
    const Fastify = (await import('fastify')).default;
    const { capabilitiesRoutes } = await import('../dist/routes/capabilities.js');

    const app = Fastify();
    await app.register(capabilitiesRoutes);
    await app.ready();

    const projectDir = join('/tmp', `cap-route-test-probe-override-${Date.now()}`);
    await mkdir(projectDir, { recursive: true });
    const probeCode = inlineProbeServerCode(process.cwd());

    await writeCapabilitiesConfig(projectDir, {
      version: 1,
      capabilities: [
        {
          id: 'probe-override',
          type: 'mcp',
          enabled: false,
          source: 'external',
          overrides: [{ catId: 'codex', enabled: true }],
          mcpServer: {
            command: 'node',
            args: ['--input-type=module', '--eval', probeCode],
            workingDir: process.cwd(),
          },
        },
      ],
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/capabilities?projectPath=${encodeURIComponent(projectDir)}&probe=true`,
      headers: AUTH_HEADERS,
    });
    assert.equal(res.statusCode, 200);

    const body = res.json();
    const item = body.items.find((i) => i.type === 'mcp' && i.id === 'probe-override');
    assert.ok(item, 'Override MCP item should exist');
    assert.equal(item.cats.codex, true, 'per-cat override should mark codex as enabled');
    assert.equal(item.connectionStatus, 'connected', 'Probe should run when any cat is enabled');
    assert.ok(
      Array.isArray(item.tools) && item.tools.some((tool) => tool.name === 'probe_echo'),
      'tools/list should be available for override-enabled capability',
    );

    await rm(projectDir, { recursive: true, force: true });
    await app.close();
  });

  it('probe=true keeps runtime PATH when capability provides custom env', async () => {
    const Fastify = (await import('fastify')).default;
    const { capabilitiesRoutes } = await import('../dist/routes/capabilities.js');

    const app = Fastify();
    await app.register(capabilitiesRoutes);
    await app.ready();

    const projectDir = join('/tmp', `cap-route-test-probe-env-${Date.now()}`);
    await mkdir(projectDir, { recursive: true });
    const probeCode = inlineProbeServerCode(process.cwd());

    await writeCapabilitiesConfig(projectDir, {
      version: 1,
      capabilities: [
        {
          id: 'probe-env',
          type: 'mcp',
          enabled: true,
          source: 'external',
          mcpServer: {
            command: 'node',
            args: ['--input-type=module', '--eval', probeCode],
            env: { OPENAI_API_KEY: 'test-key' },
            workingDir: process.cwd(),
          },
        },
      ],
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/capabilities?projectPath=${encodeURIComponent(projectDir)}&probe=true`,
      headers: AUTH_HEADERS,
    });
    assert.equal(res.statusCode, 200);

    const body = res.json();
    const item = body.items.find((i) => i.type === 'mcp' && i.id === 'probe-env');
    assert.ok(item, 'Probe-env MCP item should exist');
    assert.equal(item.connectionStatus, 'connected', 'Custom env should not break stdio command resolution');
    assert.ok(
      Array.isArray(item.tools) && item.tools.some((tool) => tool.name === 'probe_echo'),
      'tools/list should still succeed when custom env is provided',
    );

    await rm(projectDir, { recursive: true, force: true });
    await app.close();
  });

  it('without probe flag keeps MCP probe fields undefined', async () => {
    const Fastify = (await import('fastify')).default;
    const { capabilitiesRoutes } = await import('../dist/routes/capabilities.js');

    const app = Fastify();
    await app.register(capabilitiesRoutes);
    await app.ready();

    const projectDir = join('/tmp', `cap-route-test-probe-off-${Date.now()}`);
    await mkdir(projectDir, { recursive: true });
    await writeCapabilitiesConfig(projectDir, {
      version: 1,
      capabilities: [
        {
          id: 'probe-off',
          type: 'mcp',
          enabled: true,
          source: 'external',
          mcpServer: { command: 'echo', args: ['ok'] },
        },
      ],
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/capabilities?projectPath=${encodeURIComponent(projectDir)}`,
      headers: AUTH_HEADERS,
    });
    assert.equal(res.statusCode, 200);

    const body = res.json();
    const item = body.items.find((i) => i.type === 'mcp' && i.id === 'probe-off');
    assert.ok(item, 'Probe-off MCP item should exist');
    assert.equal(item.connectionStatus, undefined, 'connectionStatus should be absent when probe=false');
    assert.equal(item.tools, undefined, 'tools should be absent when probe=false');

    await rm(projectDir, { recursive: true, force: true });
    await app.close();
  });

  it('extracts skill metadata from project-level .kimi/skills SKILL.md', async () => {
    const Fastify = (await import('fastify')).default;
    const { capabilitiesRoutes } = await import('../dist/routes/capabilities.js');

    const app = Fastify();
    await app.register(capabilitiesRoutes);
    await app.ready();

    const projectDir = join('/tmp', `cap-kimi-project-meta-${Date.now()}`);
    const kimiSkillsDir = join(projectDir, '.kimi', 'skills');
    await mkdir(join(kimiSkillsDir, 'test-skill'), { recursive: true });

    // Write SKILL.md with frontmatter containing description and triggers
    await writeFile(
      join(kimiSkillsDir, 'test-skill', 'SKILL.md'),
      '---\ndescription: "Test skill for project-level Kimi metadata extraction"\ntriggers: ["test-trigger", "kimi-test"]\n---\n\n# Test Skill\n',
    );

    // Write capabilities.json with the skill
    await writeCapabilitiesConfig(projectDir, {
      version: 1,
      capabilities: [
        {
          id: 'test-skill',
          type: 'skill',
          enabled: true,
          source: 'project',
        },
      ],
    });

    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/capabilities?projectPath=${encodeURIComponent(projectDir)}`,
        headers: AUTH_HEADERS,
      });
      assert.equal(res.statusCode, 200);

      const body = res.json();
      const skillItem = body.items.find((i) => i.type === 'skill' && i.id === 'test-skill');
      assert.ok(skillItem, 'Project-level Kimi skill should appear in board');
      assert.equal(
        skillItem.description,
        'Test skill for project-level Kimi metadata extraction',
        'Should extract description from project .kimi/skills SKILL.md',
      );
      assert.deepEqual(
        skillItem.triggers,
        ['test-trigger', 'kimi-test'],
        'Should extract triggers from project .kimi/skills SKILL.md',
      );
    } finally {
      await rm(projectDir, { recursive: true, force: true });
      await app.close();
    }
  });

  it('project board item enabled reflects blockedCats, not globalEnabled (R5 P1 route-level regression)', async () => {
    const Fastify = (await import('fastify')).default;
    const { capabilitiesRoutes } = await import('../dist/routes/capabilities.js');

    // External project: globalEnabled=false synced, but blockedCats=[] → all cats have access
    const projectDir = await makeTmpDir('r5-regression');
    await writeCapabilitiesConfig(projectDir, {
      version: 1,
      capabilities: [
        {
          id: 'r5-test-tool',
          type: 'mcp',
          enabled: false,
          globalEnabled: false,
          source: 'external',
          mcpServer: { command: 'echo', args: ['r5'] },
          blockedCats: [],
        },
      ],
    });

    const app = Fastify();
    await app.register(capabilitiesRoutes);
    await app.ready();

    try {
      // Request with projectPath → isExternalProject=true
      const res = await app.inject({
        method: 'GET',
        url: `/api/capabilities?projectPath=${encodeURIComponent(projectDir)}`,
        headers: AUTH_HEADERS,
      });
      assert.equal(res.statusCode, 200, res.payload);
      const body = res.json();
      const item = body.items.find((entry) => entry.id === 'r5-test-tool');
      assert.ok(item, 'r5-test-tool board item must exist');

      // R5 fix: enabled derived from resolver (blockedCats=[]) → true
      // Old bug: enabled = globalEnabled ?? cap.enabled = false
      assert.equal(item.enabled, true, 'globalEnabled=false + blockedCats=[] → board enabled must be true');
      assert.equal(item.globalEnabled, false, 'globalEnabled still reflects global state');

      // Converse: all cats blocked → item disabled
      const allCatIds = body.catFamilies.flatMap((f) => f.catIds);
      assert.ok(allCatIds.length > 0, 'test requires registered cats');
      await writeCapabilitiesConfig(projectDir, {
        version: 1,
        capabilities: [
          {
            id: 'r5-test-tool',
            type: 'mcp',
            enabled: false,
            globalEnabled: false,
            source: 'external',
            mcpServer: { command: 'echo', args: ['r5'] },
            blockedCats: allCatIds,
          },
        ],
      });

      const res2 = await app.inject({
        method: 'GET',
        url: `/api/capabilities?projectPath=${encodeURIComponent(projectDir)}`,
        headers: AUTH_HEADERS,
      });
      assert.equal(res2.statusCode, 200);
      const item2 = res2.json().items.find((entry) => entry.id === 'r5-test-tool');
      assert.ok(item2, 'r5-test-tool board item must exist after blockedCats update');
      assert.equal(item2.enabled, false, 'blockedCats=[allCatIds] → board enabled must be false');
    } finally {
      await rm(projectDir, { recursive: true, force: true });
      await app.close();
    }
  });
});

describe('PATCH /api/capabilities write auth (Fastify)', () => {
  async function buildSessionApp() {
    const Fastify = (await import('fastify')).default;
    const { capabilitiesRoutes } = await import('../dist/routes/capabilities.js');
    const app = Fastify();
    app.addHook('preHandler', async (request) => {
      const raw = request.headers['x-test-session-user'];
      if (typeof raw === 'string' && raw.trim()) {
        request.sessionUserId = raw.trim();
      }
    });
    await app.register(capabilitiesRoutes);
    await app.ready();
    return app;
  }

  async function buildSessionAppWithProjectRoot(projectRoot) {
    const Fastify = (await import('fastify')).default;
    const previousCwd = process.cwd();
    process.chdir(projectRoot);
    try {
      const routeModuleUrl = new URL(`../dist/routes/capabilities.js?projectRoot=${Date.now()}`, import.meta.url);
      const { capabilitiesRoutes } = await import(routeModuleUrl.href);
      const app = Fastify();
      app.addHook('preHandler', async (request) => {
        const raw = request.headers['x-test-session-user'];
        if (typeof raw === 'string' && raw.trim()) {
          request.sessionUserId = raw.trim();
        }
      });
      await app.register(capabilitiesRoutes);
      await app.ready();
      return app;
    } finally {
      process.chdir(previousCwd);
    }
  }

  async function seedProject() {
    const projectDir = await makeTmpDir('patch-route-auth');
    await writeCapabilitiesConfig(projectDir, {
      version: 1,
      capabilities: [
        {
          id: 'secret-mcp',
          type: 'mcp',
          enabled: true,
          source: 'external',
          mcpServer: {
            command: 'node',
            args: ['server.js'],
            env: { API_KEY: 'raw-secret' },
            headers: { Authorization: 'Bearer raw-secret' },
          },
        },
      ],
    });
    return projectDir;
  }

  async function patchCapability(app, projectDir, headers) {
    return app.inject({
      method: 'PATCH',
      url: '/api/capabilities',
      headers,
      payload: {
        projectPath: projectDir,
        capabilityId: 'secret-mcp',
        capabilityType: 'mcp',
        scope: 'cat',
        catId: 'ragdoll',
        enabled: false,
      },
    });
  }

  function localOwnerHeaders() {
    return {
      ...OWNER_SESSION_HEADERS,
      host: 'localhost:3004',
      origin: 'http://localhost:3003',
    };
  }

  async function seedManagedSkillProject(skillId = 'debugging', enabled = true) {
    const projectDir = await makeTmpDir('patch-managed-skill');
    await writeCapabilitiesConfig(projectDir, {
      version: 1,
      capabilities: [{ id: skillId, type: 'skill', enabled, source: 'cat-cafe' }],
    });
    return projectDir;
  }

  function patchSkillCapability(app, projectDir, skillId, enabled, scope = 'global') {
    return app.inject({
      method: 'PATCH',
      url: '/api/capabilities',
      headers: localOwnerHeaders(),
      payload: {
        projectPath: projectDir,
        capabilityId: skillId,
        capabilityType: 'skill',
        scope,
        ...(scope === 'cat' ? { catId: 'codex' } : {}),
        enabled,
      },
    });
  }

  it('removes managed cat-cafe skill symlinks on project disable', async () => {
    // F228: scope='project' targets the specified projectPath.
    // scope='global' routes through main config — use project for single-project tests.
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const skillId = 'debugging';
    const sourceSkillsDir = join(findRepoRoot(), 'cat-cafe-skills');
    const projectDir = await seedManagedSkillProject(skillId, true);
    const linkPath = join(projectDir, '.codex', 'skills', skillId);
    const app = await buildSessionApp();

    try {
      await mkdir(dirname(linkPath), { recursive: true });
      await symlink(join(sourceSkillsDir, skillId), linkPath);

      const res = await patchSkillCapability(app, projectDir, skillId, false, 'project');

      assert.equal(res.statusCode, 200, res.payload);
      await assert.rejects(() => lstat(linkPath), /ENOENT/);
      const config = await readCapabilitiesConfig(projectDir);
      assert.equal(config?.capabilities[0]?.enabled, true, 'project disable must NOT change enabled');
      assert.equal(config?.capabilities[0]?.globalEnabled, true, 'project disable must NOT change globalEnabled');
      assert.deepEqual(config?.capabilities[0]?.mountPaths, [], 'project disable is represented by empty mountPaths');
    } finally {
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
      if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
    }
  });

  it('converts legacy directory-level mounts before disabling managed skills', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const disabledSkill = 'debugging';
    const keptSkill = 'tdd';
    const sourceSkillsDir = join(findRepoRoot(), 'cat-cafe-skills');
    const projectDir = await makeTmpDir('patch-managed-skill-legacy-root');
    const codexSkillsDir = join(projectDir, '.codex', 'skills');
    const app = await buildSessionApp();

    try {
      await mkdir(dirname(codexSkillsDir), { recursive: true });
      await symlink(sourceSkillsDir, codexSkillsDir);
      await writeCapabilitiesConfig(projectDir, {
        version: 1,
        capabilities: [
          { id: disabledSkill, type: 'skill', enabled: true, source: 'cat-cafe' },
          { id: keptSkill, type: 'skill', enabled: true, source: 'cat-cafe' },
        ],
      });

      const res = await patchSkillCapability(app, projectDir, disabledSkill, false, 'project');

      assert.equal(res.statusCode, 200, res.payload);
      const rootStat = await lstat(codexSkillsDir);
      assert.equal(rootStat.isDirectory(), true, 'legacy provider root should become a real directory');
      assert.equal(rootStat.isSymbolicLink(), false, 'legacy provider root symlink should be removed');
      await assert.rejects(() => lstat(join(codexSkillsDir, disabledSkill)), /ENOENT/);
      assert.equal(await realpath(join(codexSkillsDir, keptSkill)), await realpath(join(sourceSkillsDir, keptSkill)));
      const config = await readCapabilitiesConfig(projectDir);
      const disabledCap = config?.capabilities.find((cap) => cap.id === disabledSkill);
      assert.equal(disabledCap?.enabled, true, 'project disable must NOT change enabled');
      assert.equal(disabledCap?.globalEnabled, true, 'project disable must NOT change globalEnabled');
      assert.deepEqual(disabledCap?.mountPaths, [], 'project disable is represented by empty mountPaths');
      assert.equal(config?.capabilities.find((cap) => cap.id === keptSkill)?.enabled, true);
    } finally {
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
      if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
    }
  });

  it('creates managed cat-cafe skill symlinks on project enable', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const skillId = 'debugging';
    const sourceSkillsDir = join(findRepoRoot(), 'cat-cafe-skills');
    const projectDir = await seedManagedSkillProject(skillId, false);
    const app = await buildSessionApp();

    try {
      const res = await patchSkillCapability(app, projectDir, skillId, true, 'project');

      assert.equal(res.statusCode, 200, res.payload);
      for (const provider of ['.claude', '.codex', '.gemini', '.kimi']) {
        const linkPath = join(projectDir, provider, 'skills', skillId);
        const stat = await lstat(linkPath);
        assert.equal(stat.isSymbolicLink(), true, `${provider} skill path should be a symlink`);
        assert.equal(await realpath(linkPath), await realpath(join(sourceSkillsDir, skillId)));
      }
      const config = await readCapabilitiesConfig(projectDir);
      assert.equal(config?.capabilities[0]?.enabled, false, 'project enable must NOT change enabled');
      assert.equal(config?.capabilities[0]?.globalEnabled, false, 'project enable must NOT change globalEnabled');
      assert.deepEqual(config?.capabilities[0]?.mountPaths, ['claude', 'codex', 'gemini', 'kimi']);
    } finally {
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
      if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
    }
  });

  it('converts legacy directory-level mounts before enabling managed skills', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const enabledSkill = 'debugging';
    const stillDisabledSkill = 'tdd';
    const sourceSkillsDir = join(findRepoRoot(), 'cat-cafe-skills');
    const projectDir = await makeTmpDir('patch-managed-skill-enable-legacy-root');
    const codexSkillsDir = join(projectDir, '.codex', 'skills');
    const app = await buildSessionApp();

    try {
      await mkdir(dirname(codexSkillsDir), { recursive: true });
      await symlink(sourceSkillsDir, codexSkillsDir);
      await writeCapabilitiesConfig(projectDir, {
        version: 1,
        capabilities: [
          { id: enabledSkill, type: 'skill', enabled: false, source: 'cat-cafe' },
          { id: stillDisabledSkill, type: 'skill', enabled: false, source: 'cat-cafe' },
        ],
      });

      const res = await patchSkillCapability(app, projectDir, enabledSkill, true, 'project');

      assert.equal(res.statusCode, 200, res.payload);
      const rootStat = await lstat(codexSkillsDir);
      assert.equal(rootStat.isDirectory(), true, 'legacy provider root should become a real directory');
      assert.equal(rootStat.isSymbolicLink(), false, 'legacy provider root symlink should be removed');
      assert.equal(
        await realpath(join(codexSkillsDir, enabledSkill)),
        await realpath(join(sourceSkillsDir, enabledSkill)),
      );
      await assert.rejects(() => lstat(join(codexSkillsDir, stillDisabledSkill)), /ENOENT/);
      const config = await readCapabilitiesConfig(projectDir);
      const enabledCap = config?.capabilities.find((cap) => cap.id === enabledSkill);
      assert.equal(enabledCap?.enabled, false, 'project enable must NOT change enabled');
      assert.equal(enabledCap?.globalEnabled, false, 'project enable must NOT change globalEnabled');
      assert.deepEqual(enabledCap?.mountPaths, ['claude', 'codex', 'gemini', 'kimi']);
      assert.equal(config?.capabilities.find((cap) => cap.id === stillDisabledSkill)?.enabled, false);
    } finally {
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
      if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
    }
  });

  it('converts legacy directory mount and reports conflict when enabling with user-owned path', async () => {
    // F228 redesign: syncProject skip+record conflicts instead of throwing.
    // Legacy directory-level mounts are converted, conflicts at individual
    // providers are skipped, non-conflicting providers are mounted.
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const skillId = 'debugging';
    const sourceSkillsDir = join(findRepoRoot(), 'cat-cafe-skills');
    const projectDir = await makeTmpDir('patch-enable-rollback-legacy-root');
    await writeFile(join(projectDir, 'pnpm-workspace.yaml'), 'packages: []\n');
    const codexSkillsDir = join(projectDir, '.codex', 'skills');
    const claudeConflictDir = join(projectDir, '.claude', 'skills', skillId);
    const app = await buildSessionAppWithProjectRoot(projectDir);

    try {
      await mkdir(dirname(codexSkillsDir), { recursive: true });
      await symlink(sourceSkillsDir, codexSkillsDir);
      await mkdir(claudeConflictDir, { recursive: true });
      await writeFile(join(claudeConflictDir, 'SKILL.md'), '# user debugging\n');

      await writeCapabilitiesConfig(projectDir, {
        version: 1,
        capabilities: [{ id: skillId, type: 'skill', enabled: false, source: 'cat-cafe' }],
      });

      const res = await patchSkillCapability(app, projectDir, skillId, true, 'project');

      // syncProject returns 200: mounts non-conflicting providers, reports conflict
      assert.equal(res.statusCode, 200, res.payload);
      const body = JSON.parse(res.payload);
      assert.equal(body.ok, true);
      assert.ok(Array.isArray(body.propagationConflicts), 'should report conflicts');
      assert.ok(
        body.propagationConflicts.some((c) => c.path.includes('.claude')),
        'claude conflict reported',
      );
      // Legacy codex root is converted to individual symlinks
      const rootStat = await lstat(codexSkillsDir);
      assert.equal(rootStat.isDirectory(), true, 'legacy codex root converted to directory');
      // User-owned claude path preserved
      assert.equal((await lstat(claudeConflictDir)).isDirectory(), true, 'user conflict preserved');
      // Config IS updated (config write precedes sync)
      const config = await readCapabilitiesConfig(projectDir);
      const skill = config?.capabilities.find((c) => c.id === skillId);
      assert.equal(skill?.enabled, false, 'project enable must NOT change enabled');
      assert.equal(skill?.globalEnabled, false, 'project enable must NOT change globalEnabled');
      assert.deepEqual(skill?.mountPaths, ['claude', 'codex', 'gemini', 'kimi']);
    } finally {
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
      if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
    }
  });

  it('reports conflict and mounts non-conflicting providers when enabling managed skills', async () => {
    // F228 redesign: user-owned path at one provider is a conflict (skipped),
    // other providers are mounted normally. Returns 200 with propagationConflicts.
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const skillId = 'debugging';
    const projectDir = await seedManagedSkillProject(skillId, false);
    const localSkillDir = join(projectDir, '.codex', 'skills', skillId);
    const app = await buildSessionApp();

    try {
      await mkdir(localSkillDir, { recursive: true });
      await writeFile(join(localSkillDir, 'SKILL.md'), '# user debugging\n');

      const res = await patchSkillCapability(app, projectDir, skillId, true, 'project');

      // Skip+record: 200 with conflicts, non-conflicting providers mounted
      assert.equal(res.statusCode, 200, res.payload);
      const body = JSON.parse(res.payload);
      assert.ok(Array.isArray(body.propagationConflicts), 'should report conflicts');
      assert.ok(
        body.propagationConflicts.some((c) => c.path.includes('.codex')),
        'codex conflict reported',
      );
      // User-owned codex path preserved
      assert.equal((await lstat(localSkillDir)).isDirectory(), true);
      // Config IS updated (config write precedes sync)
      const config = await readCapabilitiesConfig(projectDir);
      assert.equal(config?.capabilities[0]?.enabled, false, 'project enable must NOT change enabled');
      assert.equal(config?.capabilities[0]?.globalEnabled, false, 'project enable must NOT change globalEnabled');
      assert.deepEqual(config?.capabilities[0]?.mountPaths, ['claude', 'codex', 'gemini', 'kimi']);
      // Non-conflicting providers ARE mounted
      for (const provider of ['.claude', '.gemini', '.kimi']) {
        const linkPath = join(projectDir, provider, 'skills', skillId);
        assert.equal(
          (await lstat(linkPath)).isSymbolicLink(),
          true,
          `${provider} should have a managed symlink for non-conflicting provider`,
        );
      }
    } finally {
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
      if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
    }
  });

  it('does not mutate symlinks when toggling external skills', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const skillId = 'debugging';
    const projectDir = await makeTmpDir('patch-external-skill');
    const externalSource = join(projectDir, 'external-skill-source', skillId);
    const linkPath = join(projectDir, '.codex', 'skills', skillId);
    const app = await buildSessionApp();

    try {
      await mkdir(externalSource, { recursive: true });
      await writeFile(join(externalSource, 'SKILL.md'), '# external debugging\n');
      await mkdir(dirname(linkPath), { recursive: true });
      await symlink(externalSource, linkPath);
      await writeCapabilitiesConfig(projectDir, {
        version: 1,
        capabilities: [{ id: skillId, type: 'skill', enabled: true, source: 'external' }],
      });

      const res = await patchSkillCapability(app, projectDir, skillId, false, 'project');

      assert.equal(res.statusCode, 200, res.payload);
      assert.equal(await realpath(linkPath), await realpath(externalSource));
      const config = await readCapabilitiesConfig(projectDir);
      assert.equal(config?.capabilities[0]?.globalEnabled, false);
    } finally {
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
      if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
    }
  });

  it('rejects per-cat skill overrides (F228: skills are filesystem-level)', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const skillId = 'debugging';
    const sourceSkillsDir = join(findRepoRoot(), 'cat-cafe-skills');
    const projectDir = await seedManagedSkillProject(skillId, true);
    const linkPath = join(projectDir, '.codex', 'skills', skillId);
    const app = await buildSessionApp();

    try {
      await mkdir(dirname(linkPath), { recursive: true });
      await symlink(join(sourceSkillsDir, skillId), linkPath);

      const res = await patchSkillCapability(app, projectDir, skillId, false, 'cat');

      assert.equal(res.statusCode, 400, res.payload);
      assert.match(res.payload, /invalid scope.*cat.*for skill/i);
      // Symlinks and config must remain untouched
      assert.equal(await realpath(linkPath), await realpath(join(sourceSkillsDir, skillId)));
      const config = await readCapabilitiesConfig(projectDir);
      assert.equal(config?.capabilities[0]?.enabled, true);
      assert.equal(config?.capabilities[0]?.overrides, undefined, 'rejected PATCH must not create overrides');
    } finally {
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
      if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
    }
  });

  it('project-scope enable of one skill does not re-enable disabled siblings', async () => {
    // F228: project-scope toggle only changes the toggled skill's mountPaths.
    // Other disabled skills (mountPaths:[]) must remain disabled — syncProject
    // reads configDisabledSet from config when disabledSkills is not provided.
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const toggledSkill = 'debugging';
    const siblingSkill = 'tdd';
    const projectDir = await makeTmpDir('project-enable-sibling');
    const app = await buildSessionApp();

    try {
      // Set up: both skills disabled (mountPaths:[])
      await writeCapabilitiesConfig(projectDir, {
        version: 2,
        capabilities: [
          { id: toggledSkill, type: 'skill', enabled: false, globalEnabled: false, source: 'cat-cafe', mountPaths: [] },
          { id: siblingSkill, type: 'skill', enabled: false, globalEnabled: false, source: 'cat-cafe', mountPaths: [] },
        ],
      });

      // Enable ONLY toggledSkill at project scope
      const res = await patchSkillCapability(app, projectDir, toggledSkill, true, 'project');
      assert.equal(res.statusCode, 200, res.payload);

      // toggledSkill should be enabled (has mount paths)
      const config = await readCapabilitiesConfig(projectDir);
      const toggled = config?.capabilities.find((c) => c.id === toggledSkill);
      assert.ok(toggled?.mountPaths?.length > 0, 'toggled skill must have mount paths');

      // siblingSkill must remain disabled — must NOT have symlinks
      const sibling = config?.capabilities.find((c) => c.id === siblingSkill);
      assert.deepEqual(sibling?.mountPaths, [], 'disabled sibling must keep empty mountPaths');
      for (const mp of ['.claude', '.codex', '.gemini', '.kimi']) {
        const linkPath = join(projectDir, mp, 'skills', siblingSkill);
        assert.equal(existsSync(linkPath), false, `${mp} symlink for disabled sibling must not exist`);
      }
    } finally {
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
      if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
    }
  });

  it('batch toggle: capabilityIds disables multiple skills in one request', async () => {
    // F228: PATCH with capabilityIds[] toggles multiple skills, writes config once, syncs once.
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const skills = ['debugging', 'tdd'];
    const projectDir = await makeTmpDir('batch-toggle');
    const app = await buildSessionApp();

    try {
      // Set up: both skills enabled with all standard mount points
      const allMountIds = ['claude', 'codex', 'gemini', 'kimi'];
      await writeCapabilitiesConfig(projectDir, {
        version: 2,
        capabilities: skills.map((id) => ({
          id,
          type: 'skill',
          enabled: true,
          globalEnabled: true,
          source: 'cat-cafe',
          mountPaths: allMountIds,
        })),
      });

      // Batch disable both
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/capabilities',
        headers: localOwnerHeaders(),
        payload: {
          projectPath: projectDir,
          capabilityIds: skills,
          capabilityId: skills[0],
          capabilityType: 'skill',
          scope: 'project',
          enabled: false,
        },
      });
      assert.equal(res.statusCode, 200, res.payload);
      const result = JSON.parse(res.payload);
      assert.equal(result.ok, true);
      // Batch returns capabilities[] array
      assert.ok(Array.isArray(result.capabilities), 'batch response must have capabilities array');
      assert.equal(result.capabilities.length, 2, 'must return results for both skills');

      // Both skills must be disabled in config
      const config = await readCapabilitiesConfig(projectDir);
      for (const id of skills) {
        const cap = config?.capabilities.find((c) => c.id === id);
        assert.deepEqual(cap?.mountPaths, [], `${id} must have empty mountPaths after batch disable`);
      }

      // No symlinks for either skill
      for (const id of skills) {
        for (const mp of ['.claude', '.codex', '.gemini', '.kimi']) {
          const linkPath = join(projectDir, mp, 'skills', id);
          assert.equal(existsSync(linkPath), false, `${mp}/${id} symlink must not exist`);
        }
      }
    } finally {
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
      if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
    }
  });

  it('rejects trusted header identity without a real session', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const projectDir = await seedProject();
    const app = await buildSessionApp();

    try {
      const res = await patchCapability(app, projectDir, { 'x-cat-cafe-user': 'you' });
      assert.equal(res.statusCode, 401);
      assert.match(JSON.parse(res.payload).error, /session/i);

      const config = await readCapabilitiesConfig(projectDir);
      assert.equal(config?.capabilities[0]?.enabled, true);
    } finally {
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
      if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
    }
  });

  it('allows local capability toggle when DEFAULT_OWNER_USER_ID is missing and rejects non-local or configured non-owners', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    const projectDir = await seedProject();
    const app = await buildSessionApp();

    try {
      delete process.env.DEFAULT_OWNER_USER_ID;
      const missingOwnerWithoutOrigin = await patchCapability(app, projectDir, {
        ...OWNER_SESSION_HEADERS,
        host: 'localhost:3004',
      });
      assert.equal(missingOwnerWithoutOrigin.statusCode, 403);
      assert.match(JSON.parse(missingOwnerWithoutOrigin.payload).error, /direct localhost/i);

      const missingOwner = await patchCapability(app, projectDir, {
        ...OWNER_SESSION_HEADERS,
        host: 'localhost:3004',
        origin: 'http://localhost:3003',
      });
      assert.equal(missingOwner.statusCode, 200, missingOwner.payload);
      let config = await readCapabilitiesConfig(projectDir);
      // scope=cat writes per-cat override, not cap.enabled
      const override = config?.capabilities[0]?.overrides?.find((o) => o.catId === 'ragdoll');
      assert.equal(override?.enabled, false);

      const nonLocalMissingOwner = await patchCapability(app, projectDir, {
        ...OWNER_SESSION_HEADERS,
        host: 'staging.example.test',
      });
      assert.equal(nonLocalMissingOwner.statusCode, 403);
      assert.match(JSON.parse(nonLocalMissingOwner.payload).error, /direct localhost/i);

      const spoofedLocalHost = await app.inject({
        method: 'PATCH',
        url: '/api/capabilities',
        headers: {
          ...OWNER_SESSION_HEADERS,
          host: 'localhost:3004',
          'x-forwarded-host': 'localhost:3004',
        },
        remoteAddress: '203.0.113.10',
        payload: {
          projectPath: projectDir,
          capabilityId: 'secret-mcp',
          capabilityType: 'mcp',
          scope: 'global',
          enabled: true,
        },
      });
      assert.equal(spoofedLocalHost.statusCode, 403);
      assert.match(JSON.parse(spoofedLocalHost.payload).error, /direct localhost/i);

      const forwardedLocalHost = await app.inject({
        method: 'PATCH',
        url: '/api/capabilities',
        headers: {
          ...OWNER_SESSION_HEADERS,
          host: 'localhost:3004',
          'x-forwarded-for': '203.0.113.10',
          'x-forwarded-host': 'localhost:3004',
          'x-forwarded-proto': 'https',
        },
        payload: {
          projectPath: projectDir,
          capabilityId: 'secret-mcp',
          capabilityType: 'mcp',
          scope: 'global',
          enabled: true,
        },
      });
      assert.equal(forwardedLocalHost.statusCode, 403);
      assert.match(JSON.parse(forwardedLocalHost.payload).error, /direct localhost/i);

      process.env.DEFAULT_OWNER_USER_ID = 'you';
      const nonOwner = await patchCapability(app, projectDir, {
        ...NON_OWNER_SESSION_HEADERS,
        host: 'localhost:3004',
        origin: 'http://localhost:3003',
      });
      assert.equal(nonOwner.statusCode, 403);
      assert.match(JSON.parse(nonOwner.payload).error, /owner/);

      const ownerNonLocal = await patchCapability(app, projectDir, {
        ...OWNER_SESSION_HEADERS,
        host: 'staging.example.test',
      });
      assert.equal(ownerNonLocal.statusCode, 403);
      assert.match(JSON.parse(ownerNonLocal.payload).error, /direct localhost/i);

      config = await readCapabilitiesConfig(projectDir);
      // scope=cat writes per-cat override; cap.enabled stays true.
      // Verify the override from the first successful call persists and
      // the failed auth attempts didn't mutate it further.
      const finalOverride = config?.capabilities[0]?.overrides?.find((o) => o.catId === 'ragdoll');
      assert.equal(finalOverride?.enabled, false);
    } finally {
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
      if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
    }
  });

  it('redacts secret-bearing capability data in toggle responses and audit logs', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const projectDir = await seedProject();
    const app = await buildSessionApp();

    try {
      const res = await patchCapability(app, projectDir, {
        ...OWNER_SESSION_HEADERS,
        host: 'localhost:3004',
        origin: 'http://localhost:3003',
      });
      assert.equal(res.statusCode, 200, res.payload);
      assert.doesNotMatch(res.payload, /raw-secret/);
      assert.equal(res.json().capability.mcpServer.env.API_KEY, REDACTED_SECRET);
      assert.equal(res.json().capability.mcpServer.headers.Authorization, REDACTED_SECRET);

      const config = await readCapabilitiesConfig(projectDir);
      // scope=cat writes per-cat override, cap.enabled stays true
      const redactOverride = config?.capabilities[0]?.overrides?.find((o) => o.catId === 'ragdoll');
      assert.equal(redactOverride?.enabled, false);
      assert.equal(config?.capabilities[0]?.mcpServer?.env?.API_KEY, 'raw-secret');
      assert.equal(config?.capabilities[0]?.mcpServer?.headers?.Authorization, 'Bearer raw-secret');

      const audit = await readAuditLog(projectDir);
      assert.equal(audit.length, 1);
      assert.doesNotMatch(JSON.stringify(audit), /raw-secret/);
      assert.equal(audit[0]?.before?.mcpServer?.env?.API_KEY, REDACTED_SECRET);
      assert.equal(audit[0]?.after?.mcpServer?.headers?.Authorization, REDACTED_SECRET);
    } finally {
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
      if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
    }
  });

  it('reports conflict when mount writeback encounters directory-level conflict', async () => {
    // F228 redesign: a wrong-pointing directory-level symlink is a conflict (not
    // a managed mount). syncProject skips it and reports the conflict. Config IS
    // persisted because config update runs before filesystem sync.
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const projectDir = await makeTmpDir('patch-skill-writeback-fails');
    const wrongSource = join(projectDir, 'wrong-skills-source');
    await mkdir(join(projectDir, '.claude'), { recursive: true });
    await mkdir(wrongSource, { recursive: true });
    await symlink(wrongSource, join(projectDir, '.claude/skills'));
    await writeCapabilitiesConfig(projectDir, {
      version: 1,
      capabilities: [{ id: 'debugging', type: 'skill', enabled: false, source: 'cat-cafe' }],
    });
    const app = await buildSessionApp();

    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/capabilities',
        headers: {
          ...OWNER_SESSION_HEADERS,
          host: 'localhost:3004',
          origin: 'http://localhost:3003',
        },
        payload: {
          projectPath: projectDir,
          capabilityId: 'debugging',
          capabilityType: 'skill',
          scope: 'project',
          enabled: true,
        },
      });

      // Skip+record: returns 200, reports claude conflict, other providers work
      assert.equal(res.statusCode, 200, res.payload);
      const body = JSON.parse(res.payload);
      assert.ok(Array.isArray(body.propagationConflicts), 'should report conflicts');
      assert.ok(
        body.propagationConflicts.some((c) => c.path.includes('.claude')),
        'claude conflict reported',
      );
      // Config IS updated (config write precedes sync)
      const config = await readCapabilitiesConfig(projectDir);
      const skill = config?.capabilities.find((cap) => cap.type === 'skill' && cap.id === 'debugging');
      assert.equal(skill?.enabled, false, 'project enable must NOT change enabled');
      assert.equal(skill?.globalEnabled, false, 'project enable must NOT change globalEnabled');
      assert.deepEqual(
        skill?.mountPaths,
        ['claude', 'codex', 'gemini', 'kimi'],
        'toggle persists through mountPaths even with conflicts',
      );
    } finally {
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
      if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
    }
  });

  it('reports conflict for user-owned skill path and preserves the directory', async () => {
    // F228 redesign: user-owned path at one provider is reported as a conflict.
    // Other providers mount normally. The user-owned directory is preserved.
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const projectDir = await makeTmpDir('patch-preserve-user-skill-on-enable');
    const mainProjectRoot = findRepoRoot();
    const mainConfig = await readCapabilitiesConfig(mainProjectRoot);
    const skillName = mainConfig?.capabilities.find(
      (cap) => cap.type === 'skill' && cap.source === 'cat-cafe' && cap.enabled,
    )?.id;
    assert.ok(skillName, 'expected at least one globally enabled cat-cafe skill in the main config');
    const localSkillDir = join(projectDir, `.claude/skills/${skillName}`);
    await mkdir(localSkillDir, { recursive: true });
    await writeFile(join(localSkillDir, 'SKILL.md'), `# user ${skillName}\n`);
    await writeCapabilitiesConfig(projectDir, {
      version: 1,
      capabilities: [{ id: skillName, type: 'skill', enabled: false, source: 'cat-cafe' }],
    });
    const app = await buildSessionApp();

    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/capabilities',
        headers: {
          ...OWNER_SESSION_HEADERS,
          host: 'localhost:3004',
          origin: 'http://localhost:3003',
        },
        payload: {
          projectPath: projectDir,
          capabilityId: skillName,
          capabilityType: 'skill',
          scope: 'project',
          enabled: true,
        },
      });

      // Skip+record: 200 with conflicts for the user-owned provider
      assert.equal(res.statusCode, 200, res.payload);
      const body = JSON.parse(res.payload);
      assert.ok(Array.isArray(body.propagationConflicts), 'should report conflicts');
      assert.ok(
        body.propagationConflicts.some((c) => c.path.includes('.claude')),
        'claude conflict reported',
      );
      // Config IS updated
      const config = await readCapabilitiesConfig(projectDir);
      const skill = config?.capabilities.find((cap) => cap.type === 'skill' && cap.id === skillName);
      assert.equal(skill?.enabled, false, 'project enable must NOT change enabled');
      assert.equal(skill?.globalEnabled, false, 'project enable must NOT change globalEnabled');
      assert.deepEqual(
        skill?.mountPaths,
        ['claude', 'codex', 'gemini', 'kimi'],
        'toggle persists through mountPaths with conflict reported',
      );
      // User-owned directory preserved
      const localSkillStat = await lstat(localSkillDir);
      assert.equal(localSkillStat.isDirectory(), true, 'user-owned skill directory should be preserved');
      assert.equal(await readFile(join(localSkillDir, 'SKILL.md'), 'utf8'), `# user ${skillName}\n`);
    } finally {
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
      if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
    }
  });

  it('ignores same-id disabled plugin capabilities in external project enable guard', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const mainRoot = await makeTmpDir('patch-skill-main-plugin-global-guard');
    const projectDir = await makeTmpDir('patch-skill-plugin-global-guard');
    await writeFile(join(mainRoot, 'pnpm-workspace.yaml'), 'packages: []\n');
    await writeCapabilitiesConfig(mainRoot, {
      version: 2,
      capabilities: [
        {
          id: 'debugging',
          type: 'skill',
          enabled: false,
          source: 'cat-cafe',
          pluginId: 'same-id-plugin',
          mountPaths: [],
        },
      ],
    });
    await writeCapabilitiesConfig(projectDir, {
      version: 2,
      capabilities: [{ id: 'debugging', type: 'skill', enabled: false, source: 'cat-cafe', mountPaths: [] }],
    });
    const app = await buildSessionAppWithProjectRoot(mainRoot);

    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/capabilities',
        headers: {
          ...OWNER_SESSION_HEADERS,
          host: 'localhost:3004',
          origin: 'http://localhost:3003',
        },
        payload: {
          projectPath: projectDir,
          capabilityId: 'debugging',
          capabilityType: 'skill',
          scope: 'project',
          enabled: true,
        },
      });

      assert.equal(res.statusCode, 200, res.payload);
      const config = await readCapabilitiesConfig(projectDir);
      const skill = config?.capabilities.find((cap) => cap.type === 'skill' && cap.id === 'debugging' && !cap.pluginId);
      assert.equal(skill?.enabled, false, 'project enable must NOT change enabled');
      assert.equal(skill?.globalEnabled, false, 'project enable must NOT change globalEnabled');
      assert.deepEqual(skill?.mountPaths, ['claude', 'codex', 'gemini', 'kimi']);
      assert.equal((await lstat(join(projectDir, '.claude', 'skills', 'debugging'))).isSymbolicLink(), true);
    } finally {
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
      await rm(mainRoot, { recursive: true, force: true });
      if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
    }
  });

  it('allows external project provider enables even when excluded by global skill mountPaths', async () => {
    // F228: Global policy cascades as default, but does NOT restrict project-level
    // overrides. Projects can independently enable providers that are not in the
    // global skill mountPaths — the global toggle is a convenience cascade, not
    // a hard constraint.
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const mainRoot = await makeTmpDir('patch-skill-main-provider-policy-guard');
    const projectDir = await makeTmpDir('patch-skill-provider-policy-guard');
    await writeFile(join(mainRoot, 'pnpm-workspace.yaml'), 'packages: []\n');
    await writeCapabilitiesConfig(mainRoot, {
      version: 2,
      capabilities: [{ id: 'debugging', type: 'skill', enabled: true, source: 'cat-cafe', mountPaths: ['claude'] }],
    });
    await writeCapabilitiesConfig(projectDir, {
      version: 2,
      capabilities: [{ id: 'debugging', type: 'skill', enabled: false, source: 'cat-cafe', mountPaths: [] }],
      mountRules: [
        { name: 'claude', path: '.claude/skills', enabled: true },
        { name: 'codex', path: '.codex/skills', enabled: true },
        { name: 'gemini', path: '.gemini/skills', enabled: false },
        { name: 'kimi', path: '.kimi/skills', enabled: false },
      ],
    });
    const app = await buildSessionAppWithProjectRoot(mainRoot);

    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/capabilities',
        headers: {
          ...OWNER_SESSION_HEADERS,
          host: 'localhost:3004',
          origin: 'http://localhost:3003',
        },
        payload: {
          projectPath: projectDir,
          capabilityId: 'debugging',
          capabilityType: 'skill',
          scope: 'project',
          mountPointId: 'codex',
          enabled: true,
        },
      });

      assert.equal(res.statusCode, 200, res.payload);
      const config = await readCapabilitiesConfig(projectDir);
      const skill = config?.capabilities.find((cap) => cap.type === 'skill' && cap.id === 'debugging');
      assert.equal(skill?.enabled, false, 'project mount point enable must NOT change enabled');
      assert.equal(skill?.globalEnabled, false, 'project mount point enable must NOT change globalEnabled');
      assert.ok(skill?.mountPaths?.includes('codex'), 'project should be able to mount codex independently');
      assert.equal(
        (await lstat(join(projectDir, '.codex/skills/debugging'))).isSymbolicLink(),
        true,
        'codex mount point should be mounted at project level even though globally excluded',
      );
    } finally {
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
      await rm(mainRoot, { recursive: true, force: true });
      if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
    }
  });

  it('project whole-skill enable mounts all enabled providers regardless of global mountPaths', async () => {
    // F228: Global mountPaths cascade as a default, but do NOT cap project-level
    // enables. A whole-skill enable at project level mounts to all enabled providers
    // in the project's own mount rules, not just those in the global mountPaths.
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const mainRoot = await makeTmpDir('patch-skill-main-enable-provider-policy');
    const projectDir = await makeTmpDir('patch-skill-enable-provider-policy');
    await writeFile(join(mainRoot, 'pnpm-workspace.yaml'), 'packages: []\n');
    await writeCapabilitiesConfig(mainRoot, {
      version: 2,
      capabilities: [{ id: 'debugging', type: 'skill', enabled: true, source: 'cat-cafe', mountPaths: ['claude'] }],
    });
    await writeCapabilitiesConfig(projectDir, {
      version: 2,
      capabilities: [{ id: 'debugging', type: 'skill', enabled: false, source: 'cat-cafe', mountPaths: [] }],
      mountRules: [
        { name: 'claude', path: '.claude/skills', enabled: true },
        { name: 'codex', path: '.codex/skills', enabled: true },
        { name: 'gemini', path: '.gemini/skills', enabled: false },
        { name: 'kimi', path: '.kimi/skills', enabled: false },
      ],
    });
    const app = await buildSessionAppWithProjectRoot(mainRoot);

    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/capabilities',
        headers: {
          ...OWNER_SESSION_HEADERS,
          host: 'localhost:3004',
          origin: 'http://localhost:3003',
        },
        payload: {
          projectPath: projectDir,
          capabilityId: 'debugging',
          capabilityType: 'skill',
          scope: 'project',
          enabled: true,
        },
      });

      assert.equal(res.statusCode, 200, res.payload);
      const config = await readCapabilitiesConfig(projectDir);
      const skill = config?.capabilities.find((cap) => cap.type === 'skill' && cap.id === 'debugging');
      assert.equal(skill?.enabled, false, 'project whole-skill enable must NOT change enabled');
      assert.equal(skill?.globalEnabled, false, 'project whole-skill enable must NOT change globalEnabled');
      // Both claude and codex are enabled providers in project mount rules,
      // so whole-skill enable should mount to both, not just global's ['claude'].
      assert.deepEqual(skill?.mountPaths, ['claude', 'codex']);
      assert.equal((await lstat(join(projectDir, '.claude/skills/debugging'))).isSymbolicLink(), true);
      assert.equal(
        (await lstat(join(projectDir, '.codex/skills/debugging'))).isSymbolicLink(),
        true,
        'codex should be mounted — project enable is not capped by global mountPaths',
      );
    } finally {
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
      await rm(mainRoot, { recursive: true, force: true });
      if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
    }
  });

  it('prefers same-id first-party Clowder AI skill when toggling managed skills', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const mainRoot = await makeTmpDir('patch-skill-first-party-toggle-lookup');
    await writeFile(join(mainRoot, 'pnpm-workspace.yaml'), 'packages: []\n');
    await writeCapabilitiesConfig(mainRoot, {
      version: 2,
      capabilities: [
        {
          id: 'debugging',
          type: 'skill',
          enabled: true,
          source: 'cat-cafe',
          pluginId: 'same-id-plugin',
          mountPaths: ['claude'],
        },
        {
          id: 'debugging',
          type: 'skill',
          enabled: true,
          source: 'cat-cafe',
          mountPaths: ['claude'],
        },
      ],
    });
    const app = await buildSessionAppWithProjectRoot(mainRoot);

    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/capabilities',
        headers: {
          ...OWNER_SESSION_HEADERS,
          host: 'localhost:3004',
          origin: 'http://localhost:3003',
        },
        payload: {
          capabilityId: 'debugging',
          capabilityType: 'skill',
          scope: 'project',
          enabled: false,
        },
      });

      assert.equal(res.statusCode, 200, res.payload);
      const config = await readCapabilitiesConfig(mainRoot);
      const firstParty = config?.capabilities.find(
        (cap) => cap.type === 'skill' && cap.id === 'debugging' && !cap.pluginId,
      );
      const pluginOwned = config?.capabilities.find(
        (cap) => cap.type === 'skill' && cap.id === 'debugging' && cap.pluginId === 'same-id-plugin',
      );
      // F228: project-scope disable only changes mountPaths; enabled/globalEnabled
      // stay true so the global view is not affected (same-project scenario).
      assert.equal(firstParty?.enabled, true, 'project disable must NOT change enabled (global state)');
      assert.deepEqual(firstParty?.mountPaths, [], 'disabled first-party skill should have no mounts');
      assert.equal(pluginOwned?.enabled, true, 'same-id plugin skill must stay enabled');
      assert.deepEqual(pluginOwned?.mountPaths, ['claude'], 'same-id plugin mount policy must be preserved');
    } finally {
      await app.close();
      await rm(mainRoot, { recursive: true, force: true });
      if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
    }
  });

  it('uses source discriminator when toggling a same-id external skill', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const mainRoot = await makeTmpDir('patch-skill-external-toggle-lookup');
    await writeFile(join(mainRoot, 'pnpm-workspace.yaml'), 'packages: []\n');
    await writeCapabilitiesConfig(mainRoot, {
      version: 2,
      capabilities: [
        {
          id: 'debugging',
          type: 'skill',
          enabled: true,
          source: 'cat-cafe',
          mountPaths: ['claude'],
        },
        {
          id: 'debugging',
          type: 'skill',
          enabled: true,
          source: 'external',
          mountPaths: ['claude'],
        },
      ],
    });
    const app = await buildSessionAppWithProjectRoot(mainRoot);

    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/capabilities',
        headers: {
          ...OWNER_SESSION_HEADERS,
          host: 'localhost:3004',
          origin: 'http://localhost:3003',
        },
        payload: {
          capabilityId: 'debugging',
          capabilityType: 'skill',
          source: 'external',
          scope: 'project',
          enabled: false,
        },
      });

      assert.equal(res.statusCode, 200, res.payload);
      const body = JSON.parse(res.payload);
      assert.equal(body.capability.source, 'external', 'PATCH response should identify the external row');
      const config = await readCapabilitiesConfig(mainRoot);
      const firstParty = config?.capabilities.find(
        (cap) => cap.type === 'skill' && cap.id === 'debugging' && cap.source === 'cat-cafe' && !cap.pluginId,
      );
      const external = config?.capabilities.find(
        (cap) => cap.type === 'skill' && cap.id === 'debugging' && cap.source === 'external',
      );
      assert.equal(external?.globalEnabled, false, 'external skill should be toggled');
      assert.deepEqual(external?.mountPaths, ['claude'], 'external mount policy should be preserved');
      assert.equal(firstParty?.globalEnabled, true, 'first-party Cat Cafe skill must stay enabled');
      assert.deepEqual(firstParty?.mountPaths, ['claude'], 'first-party mount policy must be preserved');
    } finally {
      await app.close();
      await rm(mainRoot, { recursive: true, force: true });
      if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
    }
  });

  it('converts legacy directory-level mounts before disabling a managed skill', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const projectDir = await makeTmpDir('patch-convert-legacy-root-on-disable');
    const sourceSkillsDir = join(findRepoRoot(), 'cat-cafe-skills');
    const sourceSkillNames = [];
    for (const entry of await readdir(sourceSkillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        await readFile(join(sourceSkillsDir, entry.name, 'SKILL.md'), 'utf-8');
        sourceSkillNames.push(entry.name);
      } catch {
        // refs and support folders are not skills
      }
    }
    assert.ok(sourceSkillNames.length > 1, 'expected multiple source skills');
    const disabledSkill = sourceSkillNames.includes('debugging') ? 'debugging' : sourceSkillNames[0];
    const keptSkill = sourceSkillNames.find((name) => name !== disabledSkill);
    assert.ok(keptSkill, 'expected a second enabled skill');

    const claudeSkillsDir = join(projectDir, '.claude/skills');
    await mkdir(join(projectDir, '.claude'), { recursive: true });
    await symlink(sourceSkillsDir, claudeSkillsDir);
    await writeCapabilitiesConfig(projectDir, {
      version: 1,
      capabilities: sourceSkillNames.map((id) => ({
        id,
        type: 'skill',
        enabled: true,
        source: 'cat-cafe',
      })),
    });
    const app = await buildSessionApp();

    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/capabilities',
        headers: {
          ...OWNER_SESSION_HEADERS,
          host: 'localhost:3004',
          origin: 'http://localhost:3003',
        },
        payload: {
          projectPath: projectDir,
          capabilityId: disabledSkill,
          capabilityType: 'skill',
          scope: 'project',
          enabled: false,
        },
      });

      assert.equal(res.statusCode, 200, res.payload);
      const config = await readCapabilitiesConfig(projectDir);
      const disabledCap = config?.capabilities.find((cap) => cap.type === 'skill' && cap.id === disabledSkill);
      assert.equal(disabledCap?.enabled, true, 'project disable must NOT change enabled');
      assert.equal(disabledCap?.globalEnabled, true, 'project disable must NOT change globalEnabled');
      assert.deepEqual(disabledCap?.mountPaths, [], 'project disable is represented by empty mountPaths');
      const rootStat = await lstat(claudeSkillsDir);
      assert.equal(rootStat.isDirectory(), true, 'legacy root should become a real provider directory');
      assert.equal(rootStat.isSymbolicLink(), false, 'legacy directory-level symlink should be removed');
      await assert.rejects(
        () => lstat(join(claudeSkillsDir, disabledSkill)),
        /ENOENT/,
        'disabled skill must no longer be loadable through the provider root',
      );
      assert.equal(
        (await lstat(join(claudeSkillsDir, keptSkill))).isSymbolicLink(),
        true,
        'other enabled skills should remain mounted after conversion',
      );
      assert.equal(
        (await lstat(join(sourceSkillsDir, disabledSkill))).isDirectory(),
        true,
        'source skill directory must not be removed',
      );
    } finally {
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
      if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
    }
  });

  it('preserves per-skill mountPaths when converting legacy roots during managed skill disable', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const projectDir = await makeTmpDir('patch-convert-legacy-root-preserve-mountpaths');
    const sourceSkillsDir = join(findRepoRoot(), 'cat-cafe-skills');
    const sourceSkillNames = [];
    for (const entry of await readdir(sourceSkillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        await readFile(join(sourceSkillsDir, entry.name, 'SKILL.md'), 'utf-8');
        sourceSkillNames.push(entry.name);
      } catch {
        // refs and support folders are not skills
      }
    }
    assert.ok(sourceSkillNames.length > 1, 'expected multiple source skills');
    const disabledSkill = sourceSkillNames.includes('debugging') ? 'debugging' : sourceSkillNames[0];
    const codexOnlySkill = sourceSkillNames.find((name) => name !== disabledSkill);
    assert.ok(codexOnlySkill, 'expected a second enabled skill');

    const claudeSkillsDir = join(projectDir, '.claude/skills');
    await mkdir(join(projectDir, '.claude'), { recursive: true });
    await symlink(sourceSkillsDir, claudeSkillsDir);
    await writeCapabilitiesConfig(projectDir, {
      version: 2,
      capabilities: [
        {
          id: disabledSkill,
          type: 'skill',
          enabled: true,
          source: 'cat-cafe',
          mountPaths: ['claude'],
        },
        {
          id: codexOnlySkill,
          type: 'skill',
          enabled: true,
          source: 'cat-cafe',
          mountPaths: ['codex'],
        },
      ],
    });
    const app = await buildSessionApp();

    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/capabilities',
        headers: {
          ...OWNER_SESSION_HEADERS,
          host: 'localhost:3004',
          origin: 'http://localhost:3003',
        },
        payload: {
          projectPath: projectDir,
          capabilityId: disabledSkill,
          capabilityType: 'skill',
          scope: 'project',
          enabled: false,
        },
      });

      assert.equal(res.statusCode, 200, res.payload);
      const rootStat = await lstat(claudeSkillsDir);
      assert.equal(rootStat.isDirectory(), true, 'legacy root should become a real provider directory');
      assert.equal(rootStat.isSymbolicLink(), false, 'legacy directory-level symlink should be removed');
      await assert.rejects(
        () => lstat(join(claudeSkillsDir, disabledSkill)),
        /ENOENT/,
        'disabled skill must no longer be loadable through the provider root',
      );
      await assert.rejects(
        () => lstat(join(claudeSkillsDir, codexOnlySkill)),
        /ENOENT/,
        'codex-only skill must not become loadable through the claude provider root',
      );
    } finally {
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
      if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
    }
  });

  it('removes custom skill mounts when disabling a managed skill', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const projectDir = await makeTmpDir('patch-remove-custom-mount-on-disable');
    const sourceSkillsDir = join(findRepoRoot(), 'cat-cafe-skills');
    const customSkillsDir = join('custom-client', 'skills');
    const customSkillsDirPath = join(projectDir, customSkillsDir);
    await mkdir(customSkillsDirPath, { recursive: true });
    await symlink(join(sourceSkillsDir, 'debugging'), join(customSkillsDirPath, 'debugging'));
    await writeCapabilitiesConfig(projectDir, {
      version: 1,
      capabilities: [{ id: 'debugging', type: 'skill', enabled: true, source: 'cat-cafe' }],
    });
    await writeMountRules(projectDir, {
      version: 1,
      mountPoints: {
        claude: { enabled: false, path: '.claude/skills' },
        codex: { enabled: false, path: '.codex/skills' },
        gemini: { enabled: false, path: '.gemini/skills' },
        kimi: { enabled: false, path: '.kimi/skills' },
      },
      customPaths: [{ alias: 'acp', path: customSkillsDir }],
    });
    const app = await buildSessionApp();

    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/capabilities',
        headers: {
          ...OWNER_SESSION_HEADERS,
          host: 'localhost:3004',
          origin: 'http://localhost:3003',
        },
        payload: {
          projectPath: projectDir,
          capabilityId: 'debugging',
          capabilityType: 'skill',
          scope: 'project',
          enabled: false,
        },
      });

      assert.equal(res.statusCode, 200, res.payload);
      const config = await readCapabilitiesConfig(projectDir);
      const skill = config?.capabilities.find((cap) => cap.type === 'skill' && cap.id === 'debugging');
      assert.equal(skill?.enabled, true, 'project disable must NOT change enabled');
      assert.equal(skill?.globalEnabled, true, 'project disable must NOT change globalEnabled');
      assert.deepEqual(skill?.mountPaths, [], 'project disable is represented by empty mountPaths');
      await assert.rejects(
        () => lstat(join(customSkillsDirPath, 'debugging')),
        /ENOENT/,
        'disabled skill must no longer be loadable through custom mount targets',
      );
      assert.equal(
        (await lstat(join(sourceSkillsDir, 'debugging'))).isDirectory(),
        true,
        'source skill directory must not be removed',
      );
    } finally {
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
      if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
    }
  });

  it('seeds missing mountPaths from enabled providers before a per-provider disable', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const projectDir = await makeTmpDir('patch-seed-missing-mountpaths-provider-disable');
    const sourceSkillsDir = join(findRepoRoot(), 'cat-cafe-skills');
    const skillId = 'debugging';
    const claudeSkillsDir = join(projectDir, '.claude/skills');
    const codexSkillsDir = join(projectDir, '.codex/skills');
    await mkdir(claudeSkillsDir, { recursive: true });
    await mkdir(codexSkillsDir, { recursive: true });
    await symlink(join(sourceSkillsDir, skillId), join(claudeSkillsDir, skillId));
    await symlink(join(sourceSkillsDir, skillId), join(codexSkillsDir, skillId));
    await writeCapabilitiesConfig(projectDir, {
      version: 2,
      capabilities: [{ id: skillId, type: 'skill', enabled: true, source: 'cat-cafe' }],
      mountRules: [
        { name: 'claude', path: '.claude/skills', enabled: true },
        { name: 'codex', path: '.codex/skills', enabled: true },
        { name: 'gemini', path: '.gemini/skills', enabled: false },
        { name: 'kimi', path: '.kimi/skills', enabled: false },
      ],
    });
    const app = await buildSessionApp();

    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/capabilities',
        headers: {
          ...OWNER_SESSION_HEADERS,
          host: 'localhost:3004',
          origin: 'http://localhost:3003',
        },
        payload: {
          projectPath: projectDir,
          capabilityId: skillId,
          capabilityType: 'skill',
          scope: 'project',
          mountPointId: 'codex',
          enabled: false,
        },
      });

      assert.equal(res.statusCode, 200, res.payload);
      const config = await readCapabilitiesConfig(projectDir);
      const skill = config?.capabilities.find((cap) => cap.type === 'skill' && cap.id === skillId);
      assert.equal(skill?.enabled, true, 'disabling one mount point must not globally disable the skill');
      assert.deepEqual(skill?.mountPaths, ['claude'], 'remaining enabled mount point should seed mountPaths');
      assert.equal((await lstat(join(claudeSkillsDir, skillId))).isSymbolicLink(), true);
      await assert.rejects(() => lstat(join(codexSkillsDir, skillId)), /ENOENT/);
    } finally {
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
      if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
    }
  });

  it('routes global skill toggles through the main config when an external project is selected', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const projectDir = await makeTmpDir('patch-global-selected-external');
    const externalOnlySkill = `external-only-global-${Date.now()}`;

    await writeCapabilitiesConfig(projectDir, {
      version: 2,
      capabilities: [
        { id: externalOnlySkill, type: 'skill', enabled: true, source: 'cat-cafe', mountPaths: ['claude'] },
      ],
      mountRules: [
        { name: 'claude', path: '.claude/skills', enabled: true },
        { name: 'codex', path: '.codex/skills', enabled: false },
        { name: 'gemini', path: '.gemini/skills', enabled: false },
        { name: 'kimi', path: '.kimi/skills', enabled: false },
      ],
    });

    const app = await buildSessionApp();

    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/capabilities',
        headers: {
          ...OWNER_SESSION_HEADERS,
          host: 'localhost:3004',
          origin: 'http://localhost:3003',
        },
        payload: {
          projectPath: projectDir,
          capabilityId: externalOnlySkill,
          capabilityType: 'skill',
          scope: 'global',
          enabled: false,
        },
      });

      assert.equal(res.statusCode, 404, 'global toggle must resolve capability from main config, not selected project');
      const selectedAfter = await readCapabilitiesConfig(projectDir);
      const selectedSkillAfter = selectedAfter?.capabilities.find(
        (cap) => cap.type === 'skill' && cap.id === externalOnlySkill,
      );
      assert.equal(
        selectedSkillAfter?.enabled,
        true,
        'selected external config must not be mutated when the global capability is absent from main config',
      );
    } finally {
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
      if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
    }
  });

  it('does not propagate main-project project skill disables to registered external projects', async () => {
    // Project scope NEVER cascades — only global scope does.
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    const previousHome = process.env.HOME;
    const previousCwd = process.cwd();
    process.env.DEFAULT_OWNER_USER_ID = 'you';

    const mainDir = await makeTmpDir('patch-main-project-disable-propagates');
    const externalDir = await makeTmpDir('patch-main-project-disable-external');
    const homeDir = await makeTmpDir('patch-main-project-disable-home');
    const sourceSkillsDir = join(findRepoRoot(), 'cat-cafe-skills');
    const skillId = 'debugging';
    const externalLink = join(externalDir, '.claude', 'skills', skillId);

    await Promise.all([
      writeFile(join(mainDir, 'pnpm-workspace.yaml'), 'packages: []\n'),
      mkdir(join(externalDir, '.claude', 'skills'), { recursive: true }),
      mkdir(homeDir, { recursive: true }),
    ]);
    await writeCapabilitiesConfig(mainDir, {
      version: 2,
      capabilities: [{ id: skillId, type: 'skill', enabled: true, source: 'cat-cafe', mountPaths: ['claude'] }],
    });
    await writeFile(
      join(mainDir, '.cat-cafe', 'governance-registry.json'),
      `${JSON.stringify(
        {
          entries: [{ projectPath: externalDir, packVersion: 'test', syncedAt: new Date().toISOString() }],
        },
        null,
        2,
      )}\n`,
    );
    await writeCapabilitiesConfig(externalDir, {
      version: 2,
      capabilities: [{ id: skillId, type: 'skill', enabled: true, source: 'cat-cafe', mountPaths: ['claude'] }],
    });
    await symlink(join(sourceSkillsDir, skillId), externalLink);

    process.env.HOME = homeDir;
    process.chdir(mainDir);

    const Fastify = (await import('fastify')).default;
    const { capabilitiesRoutes } = await import(`../dist/routes/capabilities.js?t=${Date.now()}`);
    const app = Fastify();
    app.addHook('preHandler', async (request) => {
      const raw = request.headers['x-test-session-user'];
      if (typeof raw === 'string' && raw.trim()) {
        request.sessionUserId = raw.trim();
      }
    });
    await app.register(capabilitiesRoutes);
    await app.ready();

    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/capabilities',
        headers: {
          ...OWNER_SESSION_HEADERS,
          host: 'localhost:3004',
          origin: 'http://localhost:3003',
        },
        payload: {
          capabilityId: skillId,
          capabilityType: 'skill',
          scope: 'project',
          enabled: false,
        },
      });

      assert.equal(res.statusCode, 200, res.payload);

      const mainConfig = await readCapabilitiesConfig(mainDir);
      const mainSkill = mainConfig?.capabilities.find((cap) => cap.type === 'skill' && cap.id === skillId);
      // F228: project scope only changes mountPaths, not enabled/globalEnabled
      assert.equal(mainSkill?.enabled, true, 'project disable must NOT change enabled (global state)');
      assert.deepEqual(mainSkill?.mountPaths, [], 'project disable sets mountPaths to empty');

      // Project scope NEVER cascades — external project is completely untouched
      const externalConfig = await readCapabilitiesConfig(externalDir);
      const externalSkill = externalConfig?.capabilities.find((cap) => cap.type === 'skill' && cap.id === skillId);
      assert.equal(externalSkill?.enabled, true, 'external project untouched — no cascade for project scope');
      assert.deepEqual(externalSkill?.mountPaths, ['claude'], 'external mountPaths untouched — no cascade');
      assert.equal((await lstat(externalLink)).isSymbolicLink(), true, 'external symlink preserved — no cascade');
    } finally {
      await app.close();
      process.chdir(previousCwd);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
      await rm(mainDir, { recursive: true, force: true });
      await rm(externalDir, { recursive: true, force: true });
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('persists global disabled skill policy for registered external projects without config', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    const previousHome = process.env.HOME;
    const previousCwd = process.cwd();
    process.env.DEFAULT_OWNER_USER_ID = 'you';

    const mainDir = await makeTmpDir('patch-global-disable-propagates-missing-config');
    const externalDir = await makeTmpDir('patch-global-disable-missing-config-external');
    const homeDir = await makeTmpDir('patch-global-disable-missing-config-home');
    const sourceSkillsDir = join(findRepoRoot(), 'cat-cafe-skills');
    const skillId = 'debugging';
    const externalLink = join(externalDir, '.claude', 'skills', skillId);

    await Promise.all([
      writeFile(join(mainDir, 'pnpm-workspace.yaml'), 'packages: []\n'),
      mkdir(join(externalDir, '.claude', 'skills'), { recursive: true }),
      mkdir(homeDir, { recursive: true }),
    ]);
    await writeCapabilitiesConfig(mainDir, {
      version: 2,
      capabilities: [{ id: skillId, type: 'skill', enabled: true, source: 'cat-cafe', mountPaths: ['claude'] }],
    });
    await writeFile(
      join(mainDir, '.cat-cafe', 'governance-registry.json'),
      `${JSON.stringify(
        {
          entries: [{ projectPath: externalDir, packVersion: 'test', syncedAt: new Date().toISOString() }],
        },
        null,
        2,
      )}\n`,
    );
    await symlink(join(sourceSkillsDir, skillId), externalLink);

    process.env.HOME = homeDir;
    process.chdir(mainDir);

    const Fastify = (await import('fastify')).default;
    const { capabilitiesRoutes } = await import(`../dist/routes/capabilities.js?t=${Date.now()}`);
    const app = Fastify();
    app.addHook('preHandler', async (request) => {
      const raw = request.headers['x-test-session-user'];
      if (typeof raw === 'string' && raw.trim()) {
        request.sessionUserId = raw.trim();
      }
    });
    await app.register(capabilitiesRoutes);
    await app.ready();

    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/capabilities',
        headers: {
          ...OWNER_SESSION_HEADERS,
          host: 'localhost:3004',
          origin: 'http://localhost:3003',
        },
        payload: {
          capabilityId: skillId,
          capabilityType: 'skill',
          scope: 'global',
          enabled: false,
        },
      });

      assert.equal(res.statusCode, 200, res.payload);
      assert.equal(await pathExists(externalLink), false, 'global disable should remove external project mount');

      const externalConfig = await readCapabilitiesConfig(externalDir);
      const externalSkill = externalConfig?.capabilities.find((cap) => cap.type === 'skill' && cap.id === skillId);
      assert.equal(externalConfig?.version, 2, 'external project should get a v2 capabilities config');
      assert.equal(externalSkill?.enabled, false, 'global disable should persist externally without prior config');
      assert.deepEqual(externalSkill?.mountPaths, []);
    } finally {
      await app.close();
      process.chdir(previousCwd);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
      await rm(mainDir, { recursive: true, force: true });
      await rm(externalDir, { recursive: true, force: true });
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('preserves existing external provider mounts when global enable encounters per-provider conflict', async () => {
    // F228: Per-provider conflict handling — when the claude provider directory
    // is a conflict (user-owned directory), propagation skips it and preserves
    // existing codex mounts. Returns 200 with propagationConflicts instead of 500.
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    const previousHome = process.env.HOME;
    process.env.DEFAULT_OWNER_USER_ID = 'you';

    const mainDir = await makeTmpDir('patch-global-enable-rollback-main');
    const externalDir = await makeTmpDir('patch-global-enable-rollback-external');
    const homeDir = await makeTmpDir('patch-global-enable-rollback-home');
    const sourceSkillsDir = join(findRepoRoot(), 'cat-cafe-skills');
    const skillId = 'debugging';
    const externalCodexLink = join(externalDir, '.codex', 'skills', skillId);
    const externalClaudeConflict = join(externalDir, '.claude', 'skills', skillId);

    await Promise.all([
      writeFile(join(mainDir, 'pnpm-workspace.yaml'), 'packages: []\n'),
      mkdir(dirname(externalCodexLink), { recursive: true }),
      mkdir(externalClaudeConflict, { recursive: true }),
      mkdir(homeDir, { recursive: true }),
    ]);
    await writeCapabilitiesConfig(mainDir, {
      version: 2,
      capabilities: [{ id: skillId, type: 'skill', enabled: false, source: 'cat-cafe', mountPaths: [] }],
    });
    await writeMountRules(mainDir, {
      version: 1,
      mountPoints: {
        claude: { enabled: true, path: '.claude/skills' },
        codex: { enabled: false, path: '.codex/skills' },
        gemini: { enabled: false, path: '.gemini/skills' },
        kimi: { enabled: false, path: '.kimi/skills' },
      },
      customPaths: [],
    });
    await writeFile(
      join(mainDir, '.cat-cafe', 'governance-registry.json'),
      `${JSON.stringify(
        {
          entries: [{ projectPath: externalDir, packVersion: 'test', syncedAt: new Date().toISOString() }],
        },
        null,
        2,
      )}\n`,
    );
    await writeCapabilitiesConfig(externalDir, {
      version: 2,
      capabilities: [{ id: skillId, type: 'skill', enabled: true, source: 'cat-cafe', mountPaths: ['codex'] }],
    });
    await symlink(join(sourceSkillsDir, skillId), externalCodexLink);

    process.env.HOME = homeDir;
    const app = await buildSessionAppWithProjectRoot(mainDir);

    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/capabilities',
        headers: {
          ...OWNER_SESSION_HEADERS,
          host: 'localhost:3004',
          origin: 'http://localhost:3003',
        },
        payload: {
          capabilityId: skillId,
          capabilityType: 'skill',
          scope: 'global',
          enabled: true,
        },
      });

      // F228 redesign: syncProject skips conflicts and mounts non-conflicting
      // providers. The external project has mountPaths=['codex'], but codex is
      // disabled in mount rules. The user-owned claude dir is preserved. The
      // skill stays enabled in external config (cascade respects local config).
      assert.equal(res.statusCode, 200, res.payload);
      const body = JSON.parse(res.payload);
      assert.equal(body.ok, true);
      // User-owned claude path preserved
      assert.equal((await lstat(externalClaudeConflict)).isDirectory(), true);
      const externalConfig = await readCapabilitiesConfig(externalDir);
      const externalSkill = externalConfig?.capabilities.find((cap) => cap.type === 'skill' && cap.id === skillId);
      assert.equal(externalSkill?.enabled, true);
    } finally {
      await app.close();
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
      await rm(mainDir, { recursive: true, force: true });
      await rm(externalDir, { recursive: true, force: true });
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('rejects unsafe cat-cafe skill ids before filesystem writeback', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const projectDir = await makeTmpDir('patch-unsafe-skill-id');
    await writeCapabilitiesConfig(projectDir, {
      version: 1,
      capabilities: [{ id: '../escape', type: 'skill', enabled: false, source: 'cat-cafe' }],
    });
    const app = await buildSessionApp();

    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/capabilities',
        headers: {
          ...OWNER_SESSION_HEADERS,
          host: 'localhost:3004',
          origin: 'http://localhost:3003',
        },
        payload: {
          projectPath: projectDir,
          capabilityId: '../escape',
          capabilityType: 'skill',
          scope: 'project',
          enabled: true,
        },
      });

      assert.equal(res.statusCode, 400, res.payload);
      assert.match(res.json().error, /Invalid skill name/);
      await assert.rejects(
        () => lstat(join(projectDir, '.claude', 'escape')),
        /ENOENT/,
        'unsafe skill id must not escape the provider skills directory',
      );
      const config = await readCapabilitiesConfig(projectDir);
      assert.equal(config?.capabilities[0]?.enabled, false, 'invalid skill id must not persist the toggle');
    } finally {
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
      if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
    }
  });

  it('does not rollback when initial skill mount writeback fails', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const projectDir = await makeTmpDir('patch-skill-initial-writeback-fails');
    const externalSkillsDir = join(projectDir, 'external-skills');
    const externalSkillLink = join(externalSkillsDir, 'debugging');
    await mkdir(join(projectDir, '.claude'), { recursive: true });
    await mkdir(externalSkillsDir, { recursive: true });
    await symlink(join(projectDir, 'user-owned-debugging'), externalSkillLink);
    await symlink(externalSkillsDir, join(projectDir, '.claude/skills'));
    await writeCapabilitiesConfig(projectDir, {
      version: 1,
      capabilities: [{ id: 'debugging', type: 'skill', enabled: false, source: 'cat-cafe' }],
    });
    const app = await buildSessionApp();

    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/capabilities',
        headers: OWNER_SESSION_HEADERS,
        payload: {
          projectPath: projectDir,
          capabilityId: 'debugging',
          capabilityType: 'skill',
          scope: 'project',
          enabled: true,
        },
      });

      assert.notEqual(res.statusCode, 200, 'invalid provider root symlink should fail the toggle');
      const externalLinkStat = await lstat(externalSkillLink);
      assert.equal(
        externalLinkStat.isSymbolicLink(),
        true,
        'failed initial writeback must not rollback-delete user-owned symlinks outside project mounts',
      );
    } finally {
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
      if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
    }
  });

  it('rolls back cat-cafe skill mount when config persistence fails', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const projectDir = await makeTmpDir('patch-skill-config-write-fails');
    const capabilitiesPath = join(projectDir, '.cat-cafe/capabilities.json');
    await writeCapabilitiesConfig(projectDir, {
      version: 1,
      capabilities: [{ id: 'debugging', type: 'skill', enabled: false, source: 'cat-cafe' }],
    });
    await chmod(capabilitiesPath, 0o444);
    const app = await buildSessionApp();

    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/capabilities',
        headers: OWNER_SESSION_HEADERS,
        payload: {
          projectPath: projectDir,
          capabilityId: 'debugging',
          capabilityType: 'skill',
          scope: 'project',
          enabled: true,
        },
      });

      assert.notEqual(res.statusCode, 200, 'config write failure should fail the toggle');
      const config = await readCapabilitiesConfig(projectDir);
      assert.equal(
        config?.capabilities.find((cap) => cap.type === 'skill' && cap.id === 'debugging')?.enabled,
        false,
        'capabilities.json should remain disabled when persistence fails',
      );
      for (const provider of ['claude', 'codex', 'gemini', 'kimi']) {
        await assert.rejects(
          () => lstat(join(projectDir, `.${provider}/skills/debugging`)),
          /ENOENT/,
          `${provider} mount should be rolled back`,
        );
      }
    } finally {
      await app.close();
      await chmod(capabilitiesPath, 0o644).catch(() => {});
      await rm(projectDir, { recursive: true, force: true });
      if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
    }
  });

  it('restores preexisting local skill path when skill enable rollback runs', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const projectDir = await makeTmpDir('patch-skill-restore-local-on-rollback');
    const capabilitiesPath = join(projectDir, '.cat-cafe/capabilities.json');
    const localSkillDir = join(projectDir, '.claude/skills/debugging');
    await mkdir(localSkillDir, { recursive: true });
    await writeFile(join(localSkillDir, 'local.txt'), 'keep local skill');
    await writeCapabilitiesConfig(projectDir, {
      version: 1,
      capabilities: [{ id: 'debugging', type: 'skill', enabled: false, source: 'cat-cafe' }],
    });
    await chmod(capabilitiesPath, 0o444);
    const app = await buildSessionApp();

    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/capabilities',
        headers: OWNER_SESSION_HEADERS,
        payload: {
          projectPath: projectDir,
          capabilityId: 'debugging',
          capabilityType: 'skill',
          scope: 'project',
          enabled: true,
        },
      });

      assert.notEqual(res.statusCode, 200, 'config write failure should fail the toggle');
      const config = await readCapabilitiesConfig(projectDir);
      assert.equal(
        config?.capabilities.find((cap) => cap.type === 'skill' && cap.id === 'debugging')?.enabled,
        false,
        'capabilities.json should remain disabled when persistence fails',
      );
      const restored = await lstat(localSkillDir);
      assert.equal(restored.isDirectory(), true, 'pre-existing local skill directory should be restored');
      assert.equal(await readFile(join(localSkillDir, 'local.txt'), 'utf8'), 'keep local skill');
    } finally {
      await app.close();
      await chmod(capabilitiesPath, 0o644).catch(() => {});
      await rm(projectDir, { recursive: true, force: true });
      if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
    }
  });

  it('rolls back capabilities and provider configs when CLI config generation fails', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    const previousHome = process.env.HOME;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const projectDir = await makeTmpDir('patch-cli-generation-fails');
    const homeDir = await makeTmpDir('patch-cli-generation-fails-home');
    const claudeConfigPath = join(projectDir, '.mcp.json');
    const oldClaudeConfig = '{"mcpServers":{"old-server":{"command":"old","args":[]}}}\n';
    process.env.HOME = homeDir;
    await mkdir(join(projectDir, '.codex', 'config.toml'), { recursive: true });
    await writeFile(claudeConfigPath, oldClaudeConfig);
    await writeCapabilitiesConfig(projectDir, {
      version: 1,
      capabilities: [
        {
          id: 'toggle-mcp',
          type: 'mcp',
          enabled: false,
          source: 'external',
          mcpServer: { command: 'node', args: ['server.js'] },
        },
      ],
    });
    const app = await buildSessionApp();

    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/capabilities',
        headers: OWNER_SESSION_HEADERS,
        payload: {
          projectPath: projectDir,
          capabilityId: 'toggle-mcp',
          capabilityType: 'mcp',
          scope: 'cat',
          catId: 'test-cat',
          enabled: true,
        },
      });

      assert.notEqual(res.statusCode, 200, 'blocked CLI config path should fail the toggle');
      const config = await readCapabilitiesConfig(projectDir);
      const mcp = config?.capabilities.find((cap) => cap.type === 'mcp' && cap.id === 'toggle-mcp');
      assert.equal(mcp?.enabled, false, 'capabilities.json should be restored when CLI config generation fails');
      assert.equal(mcp?.overrides, undefined, 'cat override should be rolled back');
      assert.equal(
        await readFile(claudeConfigPath, 'utf8'),
        oldClaudeConfig,
        'provider configs already written before a peer writer failed should be restored',
      );
    } finally {
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
      await rm(homeDir, { recursive: true, force: true });
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
    }
  });
});
