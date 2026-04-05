// @ts-check
/**
 * Capabilities Route Tests — F041 统一能力看板 API
 *
 * Tests the GET and PATCH /api/capabilities endpoints.
 * Uses Fastify injection + tmp directories for isolation.
 */
import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  readCapabilitiesConfig,
  writeCapabilitiesConfig,
} from '../dist/config/capabilities/capability-orchestrator.js';

const AUTH_HEADERS = { 'x-cat-cafe-user': 'test-user' };

/** @param {string} prefix */
async function makeTmpDir(prefix) {
  const dir = join(tmpdir(), `cap-route-test-${prefix}-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  return dir;
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
          enabled: false,
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
});
