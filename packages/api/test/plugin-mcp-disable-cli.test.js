// @ts-check
/**
 * Plugin MCP disable → CLI config cleanup
 *
 * Regression test: disabling a plugin-owned MCP must remove the generated
 * CLI config entry, not just the capabilities.json row.
 *
 * Also covers: /api/capabilities returns pluginId for plugin-owned MCPs.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @param {string} prefix */
async function makeTmpDir(prefix) {
  const dir = join(tmpdir(), `plugin-mcp-cli-${prefix}-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

describe('plugin MCP disable removes CLI config entries', () => {
  /** @type {string} */ let projectRoot;

  beforeEach(async () => {
    projectRoot = await makeTmpDir('mcp-disable');
    // Create .cat-cafe directory
    await mkdir(join(projectRoot, '.cat-cafe'), { recursive: true });
    // Create .mcp.json (Claude CLI config) with a plugin-owned MCP entry
    await mkdir(join(projectRoot, '.claude'), { recursive: true });
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  test('deactivateMcp disables before removing so CLI writer can clean up', async () => {
    const { PluginResourceActivator } = await import('../dist/domains/plugin/PluginResourceActivator.js');

    /** @type {import('@cat-cafe/shared').CapabilitiesConfig} */
    let storedConfig = { version: 1, capabilities: [] };

    // Track the sequence of writeCapabilities calls to verify disable-then-remove
    /** @type {Array<{action: string, entry: import('@cat-cafe/shared').CapabilityEntry | undefined}>} */
    const writeLog = [];

    const capId = 'plugin:test-plugin:test-mcp';
    const pluginsDir = join(projectRoot, 'plugins');
    await mkdir(join(pluginsDir, 'test-plugin'), { recursive: true });

    const activator = new PluginResourceActivator({
      resolveProjectRoot: () => projectRoot,
      pluginsDir,
      limbRegistry: /** @type {any} */ ({ register: async () => {}, deregister: () => {} }),
      readCapabilities: async () => structuredClone(storedConfig),
      writeCapabilities: async (config) => {
        const entry = config.capabilities.find((c) => c.id === capId);
        writeLog.push({
          action: entry ? (entry.enabled ? 'upsert-enabled' : 'upsert-disabled') : 'removed',
          entry: entry ? structuredClone(entry) : undefined,
        });
        storedConfig = structuredClone(config);
      },
      withCapabilityLock: async (fn) => fn(),
    });

    // Seed: add a plugin MCP entry (enabled)
    /** @type {import('@cat-cafe/shared').PluginManifest} */
    const manifest = /** @type {any} */ ({
      id: 'test-plugin',
      name: 'Test Plugin',
      version: '1.0.0',
      resources: [{ type: 'mcp', name: 'test-mcp', command: 'node', args: ['server.js'] }],
      config: [],
    });

    // First enable the MCP
    await activator.enablePlugin(manifest);
    assert.equal(storedConfig.capabilities.length, 1, 'should have 1 capability');
    assert.equal(storedConfig.capabilities[0].enabled, true, 'should be enabled');

    // Now disable the plugin
    writeLog.length = 0; // reset log
    await activator.disablePlugin(manifest);

    // Verify the write sequence: first disable (so CLI writer sees disabled entry), then remove
    assert.ok(writeLog.length >= 2, `expected at least 2 writes, got ${writeLog.length}`);
    assert.equal(writeLog[0].action, 'upsert-disabled', 'first write should disable the entry');
    assert.equal(writeLog[0].entry?.enabled, false, 'disabled entry should have enabled=false');
    assert.equal(writeLog[1].action, 'removed', 'second write should remove the entry');
    assert.equal(storedConfig.capabilities.length, 0, 'capabilities should be empty after disable');
  });

  test('same-type MCP upsert does not trigger extra disable write', async () => {
    const { PluginResourceActivator } = await import('../dist/domains/plugin/PluginResourceActivator.js');

    const capId = 'plugin:test-plugin:my-server';
    const pluginsDir = join(projectRoot, 'plugins');
    await mkdir(join(pluginsDir, 'test-plugin'), { recursive: true });

    // Pre-seed: an enabled MCP entry
    /** @type {import('@cat-cafe/shared').CapabilitiesConfig} */
    let storedConfig = {
      version: 1,
      capabilities: [
        {
          id: capId,
          type: 'mcp',
          enabled: true,
          source: 'cat-cafe',
          pluginId: 'test-plugin',
          mcpServer: { command: 'node', args: ['server.js'] },
        },
      ],
    };

    let writeCount = 0;
    const activator = new PluginResourceActivator({
      resolveProjectRoot: () => projectRoot,
      pluginsDir,
      limbRegistry: /** @type {any} */ ({ register: async () => {}, deregister: () => {} }),
      readCapabilities: async () => structuredClone(storedConfig),
      writeCapabilities: async (config) => {
        writeCount++;
        storedConfig = structuredClone(config);
      },
      withCapabilityLock: async (fn) => fn(),
    });

    // Re-enable same MCP resource (mcp→mcp): should NOT trigger disable-first path
    const manifest = /** @type {any} */ ({
      id: 'test-plugin',
      name: 'Test Plugin',
      version: '1.0.0',
      resources: [{ type: 'mcp', name: 'my-server', command: 'node', args: ['srv.js'] }],
      config: [],
    });

    writeCount = 0;
    await activator.enablePlugin(manifest);

    assert.equal(writeCount, 1, 'same-type upsert should be a single write');
    assert.equal(storedConfig.capabilities[0].type, 'mcp');
    assert.equal(storedConfig.capabilities[0].enabled, true);
  });
});

describe('limb→MCP type transition deregisters stale limb node', () => {
  /** @type {string} */ let projectRoot;

  beforeEach(async () => {
    projectRoot = await makeTmpDir('limb-type-transition');
    await mkdir(join(projectRoot, '.cat-cafe'), { recursive: true });
    await mkdir(join(projectRoot, '.claude'), { recursive: true });
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  test('transitioning limb→MCP deregisters old limb node after write', async () => {
    const { PluginResourceActivator } = await import('../dist/domains/plugin/PluginResourceActivator.js');

    const capId = 'plugin:test-plugin:my-resource';
    const pluginsDir = join(projectRoot, 'plugins');
    await mkdir(join(pluginsDir, 'test-plugin'), { recursive: true });

    // Pre-seed: an enabled limb entry with a limbNodeId
    /** @type {import('@cat-cafe/shared').CapabilitiesConfig} */
    let storedConfig = {
      version: 1,
      capabilities: [
        {
          id: capId,
          type: 'limb',
          enabled: true,
          source: 'cat-cafe',
          pluginId: 'test-plugin',
          limbNodeId: 'old-limb-node-123',
        },
      ],
    };

    /** @type {string[]} */
    const deregistered = [];

    const activator = new PluginResourceActivator({
      resolveProjectRoot: () => projectRoot,
      pluginsDir,
      limbRegistry: /** @type {any} */ ({
        register: async () => {},
        deregister: (nodeId) => deregistered.push(nodeId),
      }),
      readCapabilities: async () => structuredClone(storedConfig),
      writeCapabilities: async (config) => {
        storedConfig = structuredClone(config);
      },
      withCapabilityLock: async (fn) => fn(),
    });

    // Transition: same capId but now it's an MCP resource
    const manifest = /** @type {any} */ ({
      id: 'test-plugin',
      name: 'Test Plugin',
      version: '1.0.0',
      resources: [{ type: 'mcp', name: 'my-resource', command: 'node', args: ['server.js'] }],
      config: [],
    });

    await activator.enablePlugin(manifest);

    // Verify: old limb node was deregistered
    assert.deepStrictEqual(deregistered, ['old-limb-node-123'], 'should deregister old limb node');
    // Verify: entry is now MCP type
    assert.equal(storedConfig.capabilities[0].type, 'mcp');
    assert.equal(storedConfig.capabilities[0].enabled, true);
    assert.equal(storedConfig.capabilities[0].limbNodeId, undefined, 'limbNodeId should be removed');
  });
});

describe('/api/capabilities returns pluginId for plugin-owned MCPs', () => {
  test('MCP board items include pluginId when capability has one', async () => {
    // This is a structural test: verify that the capabilities route code
    // includes pluginId in MCP board items by checking the source
    const capabilitiesSource = await readFile(join(__dirname, '..', 'src', 'routes', 'capabilities.ts'), 'utf-8');

    // The MCP board item construction should include pluginId
    // Find the mcpItem construction block
    const mcpItemMatch = capabilitiesSource.match(/const mcpItem:\s*CapabilityBoardItem\s*=\s*\{[\s\S]*?\};/);
    assert.ok(mcpItemMatch, 'should find mcpItem construction');
    assert.ok(mcpItemMatch[0].includes('pluginId'), 'mcpItem should include pluginId field');

    // Also verify the skill item has it (baseline sanity check)
    const skillItemMatch = capabilitiesSource.match(/const skillItem:\s*CapabilityBoardItem\s*=\s*\{[\s\S]*?\};/);
    assert.ok(skillItemMatch, 'should find skillItem construction');
    assert.ok(skillItemMatch[0].includes('pluginId'), 'skillItem should include pluginId field');
  });
});
