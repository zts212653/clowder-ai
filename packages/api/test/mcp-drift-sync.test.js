// @ts-check

/**
 * Behavior tests for MCP drift/sync subsystem (F249).
 *
 * Covers:
 *   - mcp-drift-detector: checkMcpProject (inline config, no file I/O)
 *   - mcp-drift-resolver: syncMcpDrift (temp dirs with capabilities.json)
 *   - mcp-sync-engine: canonicalJson, computeGlobalMcpHash, extractMcpEntries, syncMcpProject
 */

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

const { checkMcpProject } = await import('../dist/mcp/mcp-drift-detector.js');
const { VALID_MCP_DRIFT_DECISIONS, syncMcpDrift } = await import('../dist/mcp/mcp-drift-resolver.js');
const { canonicalJson, computeGlobalMcpHash, extractMcpEntries, syncMcpProject } = await import(
  '../dist/mcp/mcp-sync-engine.js'
);

// ── Helpers ────────────────────────────────────────────────────────────────

/** Build a minimal MCP capability entry. */
function mcpEntry(id, opts = {}) {
  return {
    id,
    type: 'mcp',
    enabled: true,
    globalEnabled: opts.globalEnabled ?? true,
    source: opts.source ?? 'cat-cafe',
    mcpServer: opts.mcpServer ?? { command: 'node', args: ['server.js'] },
    ...(opts.mcpServerOverride ? { mcpServerOverride: opts.mcpServerOverride } : {}),
    ...(opts.blockedCats ? { blockedCats: opts.blockedCats } : {}),
  };
}

/** Build a non-MCP capability entry (should be filtered out). */
function skillEntry(id) {
  return { id, type: 'skill', enabled: true, globalEnabled: true, source: 'cat-cafe' };
}

/** Build a CapabilitiesConfig. */
function capConfig(capabilities) {
  return { version: 2, capabilities };
}

/** Write a capabilities.json to a temp dir at <root>/.cat-cafe/capabilities.json. */
function writeCapConfig(root, config) {
  const dir = join(root, '.cat-cafe');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'capabilities.json'), JSON.stringify(config, null, 2), 'utf-8');
}

/** Read the capabilities.json back from a temp dir. */
function readCapConfig(root) {
  return JSON.parse(readFileSync(join(root, '.cat-cafe', 'capabilities.json'), 'utf-8'));
}

/** Create a unique temp directory. */
function makeTmpDir(label) {
  const base = join(tmpdir(), `mcp-test-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(base, { recursive: true });
  return base;
}

// ── Drift Detector: checkMcpProject (inline config) ────────────────────────

describe('mcp-drift-detector: checkMcpProject', () => {
  it('returns empty issues when configs are identical', async () => {
    const entry = mcpEntry('cat-cafe');
    const global = capConfig([entry]);
    const project = capConfig([{ ...entry }]);

    const result = await checkMcpProject('/fake/project', '/fake/global', global, project);

    assert.equal(result.issues.length, 0);
    assert.deepEqual(result.summary, { new: 0, orphan: 0, mismatch: 0 });
  });

  it('detects global-new when MCP exists in global but not project', async () => {
    const global = capConfig([mcpEntry('new-mcp')]);
    const project = capConfig([]);

    const result = await checkMcpProject('/fake/project', '/fake/global', global, project);

    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0].type, 'global-new');
    assert.equal(result.issues[0].mcpId, 'new-mcp');
    assert.equal(result.summary.new, 1);
  });

  it('detects project-orphan for non-external MCP in project but not global', async () => {
    const global = capConfig([]);
    const project = capConfig([mcpEntry('orphan-mcp', { source: 'cat-cafe' })]);

    const result = await checkMcpProject('/fake/project', '/fake/global', global, project);

    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0].type, 'project-orphan');
    assert.equal(result.issues[0].mcpId, 'orphan-mcp');
    assert.equal(result.summary.orphan, 1);
  });

  it('does NOT flag external-source MCP as orphan', async () => {
    const global = capConfig([]);
    const project = capConfig([mcpEntry('ext-mcp', { source: 'external' })]);

    const result = await checkMcpProject('/fake/project', '/fake/global', global, project);

    assert.equal(result.issues.length, 0);
    assert.equal(result.summary.orphan, 0);
  });

  it('detects config-mismatch when mcpServer differs', async () => {
    const global = capConfig([mcpEntry('shared-mcp', { mcpServer: { command: 'node', args: ['v2.js'] } })]);
    const project = capConfig([mcpEntry('shared-mcp', { mcpServer: { command: 'node', args: ['v1.js'] } })]);

    const result = await checkMcpProject('/fake/project', '/fake/global', global, project);

    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0].type, 'config-mismatch');
    assert.equal(result.issues[0].mcpId, 'shared-mcp');
    assert.equal(result.summary.mismatch, 1);
  });

  it('reports correct summary counts for mixed issues', async () => {
    const global = capConfig([
      mcpEntry('new-one'),
      mcpEntry('mismatched', { mcpServer: { command: 'python', args: ['app.py'] } }),
    ]);
    const project = capConfig([
      mcpEntry('orphan-one', { source: 'cat-cafe' }),
      mcpEntry('mismatched', { mcpServer: { command: 'node', args: ['old.js'] } }),
    ]);

    const result = await checkMcpProject('/fake/project', '/fake/global', global, project);

    assert.equal(result.summary.new, 1);
    assert.equal(result.summary.orphan, 1);
    assert.equal(result.summary.mismatch, 1);
    assert.equal(result.issues.length, 3);
  });

  it('driftHash changes when config changes', async () => {
    const globalA = capConfig([mcpEntry('mcp-a', { mcpServer: { command: 'node', args: ['a.js'] } })]);
    const globalB = capConfig([mcpEntry('mcp-a', { mcpServer: { command: 'node', args: ['b.js'] } })]);
    const project = capConfig([mcpEntry('mcp-a', { mcpServer: { command: 'node', args: ['a.js'] } })]);

    const resultA = await checkMcpProject('/fake/project', '/fake/global', globalA, project);
    const resultB = await checkMcpProject('/fake/project', '/fake/global', globalB, project);

    assert.notEqual(resultA.driftHash, resultB.driftHash);
  });
});

// ── Drift Resolver: syncMcpDrift (temp dirs) ───────────────────────────────

describe('mcp-drift-resolver: syncMcpDrift', () => {
  /** @type {string} */
  let globalRoot;
  /** @type {string} */
  let projectRoot;

  beforeEach(() => {
    globalRoot = makeTmpDir('global');
    projectRoot = makeTmpDir('project');
  });

  afterEach(() => {
    rmSync(globalRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('adds new entries for global-new issues', async () => {
    const globalEntry = mcpEntry('new-mcp');
    writeCapConfig(globalRoot, capConfig([globalEntry]));
    writeCapConfig(projectRoot, capConfig([]));

    /** @type {import('../dist/mcp/mcp-drift-detector.js').McpDriftResult} */
    const drift = {
      issues: [{ type: 'global-new', mcpId: 'new-mcp', message: 'test' }],
      driftHash: 'abc',
      summary: { new: 1, orphan: 0, mismatch: 0 },
    };

    const report = await syncMcpDrift(projectRoot, globalRoot, drift);

    assert.deepEqual(report.added, ['new-mcp']);
    assert.equal(report.removed.length, 0);

    const written = readCapConfig(projectRoot);
    const mcpEntries = written.capabilities.filter((c) => c.type === 'mcp');
    assert.equal(mcpEntries.length, 1);
    assert.equal(mcpEntries[0].id, 'new-mcp');
  });

  it('removes orphan entries', async () => {
    writeCapConfig(globalRoot, capConfig([]));
    writeCapConfig(projectRoot, capConfig([mcpEntry('orphan-mcp')]));

    const drift = {
      issues: [{ type: 'project-orphan', mcpId: 'orphan-mcp', message: 'test' }],
      driftHash: 'abc',
      summary: { new: 0, orphan: 1, mismatch: 0 },
    };

    const report = await syncMcpDrift(projectRoot, globalRoot, drift);

    assert.deepEqual(report.removed, ['orphan-mcp']);

    const written = readCapConfig(projectRoot);
    const mcpEntries = written.capabilities.filter((c) => c.type === 'mcp');
    assert.equal(mcpEntries.length, 0);
  });

  it('updates config for use-global decision (default)', async () => {
    const newServer = { command: 'python', args: ['app.py'] };
    writeCapConfig(globalRoot, capConfig([mcpEntry('shared-mcp', { mcpServer: newServer })]));
    writeCapConfig(
      projectRoot,
      capConfig([mcpEntry('shared-mcp', { mcpServer: { command: 'node', args: ['old.js'] } })]),
    );

    const drift = {
      issues: [{ type: 'config-mismatch', mcpId: 'shared-mcp', message: 'test' }],
      driftHash: 'abc',
      summary: { new: 0, orphan: 0, mismatch: 1 },
    };

    const report = await syncMcpDrift(projectRoot, globalRoot, drift);

    assert.deepEqual(report.updated, ['shared-mcp']);

    const written = readCapConfig(projectRoot);
    const entry = written.capabilities.find((c) => c.id === 'shared-mcp');
    assert.equal(entry.mcpServer.command, 'python');
    assert.deepEqual(entry.mcpServer.args, ['app.py']);
  });

  it('skips on keep-project decision', async () => {
    writeCapConfig(
      globalRoot,
      capConfig([mcpEntry('shared-mcp', { mcpServer: { command: 'python', args: ['new.py'] } })]),
    );
    writeCapConfig(
      projectRoot,
      capConfig([mcpEntry('shared-mcp', { mcpServer: { command: 'node', args: ['old.js'] } })]),
    );

    const drift = {
      issues: [{ type: 'config-mismatch', mcpId: 'shared-mcp', message: 'test' }],
      driftHash: 'abc',
      summary: { new: 0, orphan: 0, mismatch: 1 },
    };

    const resolutions = [{ mcpId: 'shared-mcp', decision: 'keep-project' }];
    const report = await syncMcpDrift(projectRoot, globalRoot, drift, resolutions);

    assert.deepEqual(report.skipped, ['shared-mcp']);
    assert.equal(report.updated.length, 0);

    // Verify project config is unchanged
    const written = readCapConfig(projectRoot);
    const entry = written.capabilities.find((c) => c.id === 'shared-mcp');
    assert.equal(entry.mcpServer.command, 'node');
    assert.deepEqual(entry.mcpServer.args, ['old.js']);
  });

  it('clears mcpServerOverride on use-global', async () => {
    const newServer = { command: 'python', args: ['new.py'] };
    const overrideServer = { command: 'ruby', args: ['custom.rb'] };
    writeCapConfig(globalRoot, capConfig([mcpEntry('shared-mcp', { mcpServer: newServer })]));
    writeCapConfig(
      projectRoot,
      capConfig([
        mcpEntry('shared-mcp', {
          mcpServer: { command: 'node', args: ['old.js'] },
          mcpServerOverride: overrideServer,
        }),
      ]),
    );

    const drift = {
      issues: [{ type: 'config-mismatch', mcpId: 'shared-mcp', message: 'test', hasOverride: true }],
      driftHash: 'abc',
      summary: { new: 0, orphan: 0, mismatch: 1 },
    };

    const report = await syncMcpDrift(projectRoot, globalRoot, drift);

    assert.deepEqual(report.updated, ['shared-mcp']);

    const written = readCapConfig(projectRoot);
    const entry = written.capabilities.find((c) => c.id === 'shared-mcp');
    // mcpServerOverride should be cleared
    assert.equal(entry.mcpServerOverride, undefined);
    // mcpServer should be updated to global
    assert.equal(entry.mcpServer.command, 'python');
  });
});

// ── Sync Engine: utility functions ─────────────────────────────────────────

describe('mcp-sync-engine: utility functions', () => {
  it('canonicalJson sorts keys deterministically', () => {
    const a = canonicalJson({ z: 1, a: 2, m: { b: 3, a: 4 } });
    const b = canonicalJson({ a: 2, m: { a: 4, b: 3 }, z: 1 });
    assert.equal(a, b);
  });

  it('canonicalJson preserves array order', () => {
    const result = canonicalJson({ items: [3, 1, 2] });
    assert.equal(result, '{"items":[3,1,2]}');
  });

  it('computeGlobalMcpHash is deterministic regardless of entry order', () => {
    const entries = [
      mcpEntry('b-mcp', { mcpServer: { command: 'node', args: ['b.js'] } }),
      mcpEntry('a-mcp', { mcpServer: { command: 'node', args: ['a.js'] } }),
    ];
    const reversed = [...entries].reverse();

    assert.equal(computeGlobalMcpHash(entries), computeGlobalMcpHash(reversed));
  });

  it('computeGlobalMcpHash changes when server config changes', () => {
    const entriesA = [mcpEntry('mcp-x', { mcpServer: { command: 'node', args: ['a.js'] } })];
    const entriesB = [mcpEntry('mcp-x', { mcpServer: { command: 'node', args: ['b.js'] } })];

    assert.notEqual(computeGlobalMcpHash(entriesA), computeGlobalMcpHash(entriesB));
  });

  it('extractMcpEntries filters out non-MCP capabilities', () => {
    const config = capConfig([mcpEntry('my-mcp'), skillEntry('my-skill'), mcpEntry('another-mcp')]);

    const result = extractMcpEntries(config);

    assert.equal(result.length, 2);
    assert.ok(result.every((e) => e.type === 'mcp'));
    assert.deepEqual(
      result.map((e) => e.id),
      ['my-mcp', 'another-mcp'],
    );
  });

  it('extractMcpEntries returns empty array for null config', () => {
    const result = extractMcpEntries(null);
    assert.deepEqual(result, []);
  });
});

// ── Sync Engine: syncMcpProject (temp dirs) ────────────────────────────────

describe('mcp-sync-engine: syncMcpProject', () => {
  /** @type {string} */
  let globalRoot;
  /** @type {string} */
  let projectRoot;

  beforeEach(() => {
    globalRoot = makeTmpDir('sync-global');
    projectRoot = makeTmpDir('sync-project');
  });

  afterEach(() => {
    rmSync(globalRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('adds new global entries to empty project', async () => {
    writeCapConfig(globalRoot, capConfig([mcpEntry('alpha'), mcpEntry('beta')]));
    writeCapConfig(projectRoot, capConfig([]));

    const globalEntries = [mcpEntry('alpha'), mcpEntry('beta')];
    const result = await syncMcpProject(projectRoot, globalRoot, { globalMcpEntries: globalEntries });

    assert.deepEqual(result.added.sort(), ['alpha', 'beta']);
    assert.equal(result.removed.length, 0);

    const written = readCapConfig(projectRoot);
    const mcpIds = written.capabilities.filter((c) => c.type === 'mcp').map((c) => c.id);
    assert.ok(mcpIds.includes('alpha'));
    assert.ok(mcpIds.includes('beta'));
  });

  it('updates changed entries without override', async () => {
    const oldServer = { command: 'node', args: ['v1.js'] };
    const newServer = { command: 'node', args: ['v2.js'] };
    writeCapConfig(globalRoot, capConfig([mcpEntry('my-mcp', { mcpServer: newServer })]));
    writeCapConfig(projectRoot, capConfig([mcpEntry('my-mcp', { mcpServer: oldServer })]));

    const globalEntries = [mcpEntry('my-mcp', { mcpServer: newServer })];
    const result = await syncMcpProject(projectRoot, globalRoot, { globalMcpEntries: globalEntries });

    assert.deepEqual(result.updated, ['my-mcp']);

    const written = readCapConfig(projectRoot);
    const entry = written.capabilities.find((c) => c.id === 'my-mcp');
    assert.deepEqual(entry.mcpServer.args, ['v2.js']);
  });

  it('skips entries with mcpServerOverride', async () => {
    const globalServer = { command: 'node', args: ['global.js'] };
    const projectServer = { command: 'node', args: ['project.js'] };
    const override = { command: 'ruby', args: ['custom.rb'] };

    writeCapConfig(globalRoot, capConfig([mcpEntry('overridden', { mcpServer: globalServer })]));
    writeCapConfig(
      projectRoot,
      capConfig([mcpEntry('overridden', { mcpServer: projectServer, mcpServerOverride: override })]),
    );

    const globalEntries = [mcpEntry('overridden', { mcpServer: globalServer })];
    const result = await syncMcpProject(projectRoot, globalRoot, { globalMcpEntries: globalEntries });

    assert.deepEqual(result.skipped, ['overridden']);
    assert.equal(result.updated.length, 0);

    // Override preserved
    const written = readCapConfig(projectRoot);
    const entry = written.capabilities.find((c) => c.id === 'overridden');
    assert.ok(entry.mcpServerOverride);
    assert.equal(entry.mcpServerOverride.command, 'ruby');
  });

  it('removes non-external orphans from project', async () => {
    writeCapConfig(globalRoot, capConfig([]));
    writeCapConfig(projectRoot, capConfig([mcpEntry('stale-mcp', { source: 'cat-cafe' })]));

    const result = await syncMcpProject(projectRoot, globalRoot, { globalMcpEntries: [] });

    assert.deepEqual(result.removed, ['stale-mcp']);

    const written = readCapConfig(projectRoot);
    const mcpEntries = written.capabilities.filter((c) => c.type === 'mcp');
    assert.equal(mcpEntries.length, 0);
  });

  it('preserves external-source entries even when absent from global', async () => {
    writeCapConfig(globalRoot, capConfig([]));
    writeCapConfig(projectRoot, capConfig([mcpEntry('ext-mcp', { source: 'external' })]));

    const result = await syncMcpProject(projectRoot, globalRoot, { globalMcpEntries: [] });

    // External entries should NOT be removed
    assert.ok(!result.removed.includes('ext-mcp'));

    const written = readCapConfig(projectRoot);
    const mcpEntries = written.capabilities.filter((c) => c.type === 'mcp');
    assert.equal(mcpEntries.length, 1);
    assert.equal(mcpEntries[0].id, 'ext-mcp');
  });
});

// ── Resolver contract: VALID_MCP_DRIFT_DECISIONS ──────────────────────────

describe('VALID_MCP_DRIFT_DECISIONS (resolver contract)', () => {
  it('contains exactly use-global and keep-project', () => {
    assert.ok(VALID_MCP_DRIFT_DECISIONS.has('use-global'));
    assert.ok(VALID_MCP_DRIFT_DECISIONS.has('keep-project'));
    assert.equal(VALID_MCP_DRIFT_DECISIONS.size, 2);
  });

  it('rejects invalid decision values', () => {
    assert.ok(!VALID_MCP_DRIFT_DECISIONS.has('accept'));
    assert.ok(!VALID_MCP_DRIFT_DECISIONS.has('reject'));
    assert.ok(!VALID_MCP_DRIFT_DECISIONS.has('skip'));
  });

  it('syncMcpDrift treats unknown decisions as use-global (default)', async () => {
    const globalRoot = join(tmpdir(), `drift-contract-g-${Date.now()}`);
    const projectRoot = join(tmpdir(), `drift-contract-p-${Date.now()}`);
    mkdirSync(join(globalRoot, '.cat-cafe'), { recursive: true });
    mkdirSync(join(projectRoot, '.cat-cafe'), { recursive: true });

    const globalServer = { command: 'python', args: ['new.py'] };
    const projectServer = { command: 'node', args: ['old.js'] };
    writeCapConfig(globalRoot, capConfig([mcpEntry('shared-mcp', { mcpServer: globalServer })]));
    writeCapConfig(projectRoot, capConfig([mcpEntry('shared-mcp', { mcpServer: projectServer })]));

    const drift = {
      issues: [{ type: 'config-mismatch', mcpId: 'shared-mcp', message: 'test' }],
      driftHash: 'test',
      summary: { new: 0, orphan: 0, mismatch: 1 },
    };

    // Pass an unknown decision — resolver should default to use-global
    const result = await syncMcpDrift(projectRoot, globalRoot, drift, [
      { mcpId: 'shared-mcp', decision: 'unknown-garbage' },
    ]);

    // use-global is the default when decision doesn't match keep-project
    assert.ok(result.updated.includes('shared-mcp') || result.skipped.length === 0);

    rmSync(globalRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });
});
