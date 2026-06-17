/**
 * F202: Plugin manifest security boundary tests
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import { join } from 'node:path';
import { describe, it, mock } from 'node:test';
import Fastify from 'fastify';
import { PluginRegistry, resourceCapId } from '../dist/domains/plugin/PluginRegistry.js';
import {
  PluginResourceActivator,
  rehydrateEnabledPluginLimbs,
  withPersistedLimbNodeId,
} from '../dist/domains/plugin/PluginResourceActivator.js';
import { BUILTIN_PLUGIN_IDS, parsePluginManifest, validateEnvSafety } from '../dist/domains/plugin/plugin-manifest.js';
import { registerPluginRoutes } from '../dist/routes/plugin-routes.js';

const require = createRequire(import.meta.url);
const fsModule = require('node:fs');

function writeTmpManifest(dir, id, yaml) {
  const pluginDir = join(dir, id);
  mkdirSync(pluginDir, { recursive: true });
  const yamlPath = join(pluginDir, 'plugin.yaml');
  writeFileSync(yamlPath, yaml);
  return yamlPath;
}

describe('parsePluginManifest security', () => {
  let tmpDir;

  it('rejects manifest id with path traversal', () => {
    tmpDir = mkdtempSync(join(os.tmpdir(), 'plugin-test-'));
    const yamlPath = writeTmpManifest(tmpDir, 'legit', ['id: "../escape"', 'name: Evil', 'version: 1.0.0'].join('\n'));
    assert.throws(() => parsePluginManifest(yamlPath), /must start with a letter/);
  });

  it('rejects manifest id with uppercase', () => {
    tmpDir = mkdtempSync(join(os.tmpdir(), 'plugin-test-'));
    const yamlPath = writeTmpManifest(tmpDir, 'legit', ['id: EvilPlugin', 'name: Evil', 'version: 1.0.0'].join('\n'));
    assert.throws(() => parsePluginManifest(yamlPath), /must start with a letter/);
  });

  it('rejects manifest id with leading digit', () => {
    tmpDir = mkdtempSync(join(os.tmpdir(), 'plugin-test-'));
    const yamlPath = writeTmpManifest(
      tmpDir,
      'legit',
      ['id: 123-plugin', 'name: Numeric', 'version: 1.0.0'].join('\n'),
    );
    assert.throws(() => parsePluginManifest(yamlPath), /must start with a letter/);
  });

  it('rejects resource path with ..', () => {
    tmpDir = mkdtempSync(join(os.tmpdir(), 'plugin-test-'));
    const yamlPath = writeTmpManifest(
      tmpDir,
      'evil',
      [
        'id: evil',
        'name: Evil',
        'version: 1.0.0',
        'resources:',
        '  - type: skill',
        '    path: "../../cat-cafe-skills/dangerous"',
      ].join('\n'),
    );
    assert.throws(() => parsePluginManifest(yamlPath), /must be relative without/);
  });

  it('rejects resource path starting with /', () => {
    tmpDir = mkdtempSync(join(os.tmpdir(), 'plugin-test-'));
    const yamlPath = writeTmpManifest(
      tmpDir,
      'evil',
      ['id: evil', 'name: Evil', 'version: 1.0.0', 'resources:', '  - type: skill', '    path: "/etc/passwd"'].join(
        '\n',
      ),
    );
    assert.throws(() => parsePluginManifest(yamlPath), /must be relative without/);
  });

  it('builtin is code-derived, not from YAML', () => {
    tmpDir = mkdtempSync(join(os.tmpdir(), 'plugin-test-'));
    const yamlPath = writeTmpManifest(
      tmpDir,
      'evil-plugin',
      ['id: evil-plugin', 'name: Evil', 'version: 1.0.0', 'builtin: true'].join('\n'),
    );
    const manifest = parsePluginManifest(yamlPath);
    assert.equal(manifest.builtin, false, 'community plugin cannot self-declare builtin');
  });

  it('parser never grants builtin trust even for reserved id', () => {
    tmpDir = mkdtempSync(join(os.tmpdir(), 'plugin-test-'));
    const yamlPath = writeTmpManifest(tmpDir, 'github', ['id: github', 'name: GitHub', 'version: 1.0.0'].join('\n'));
    const manifest = parsePluginManifest(yamlPath);
    assert.equal(manifest.builtin, false, 'parser must not grant builtin from untrusted YAML');
  });

  it('github scanned as regular plugin (no longer reserved builtin)', () => {
    tmpDir = mkdtempSync(join(os.tmpdir(), 'plugin-test-'));
    writeTmpManifest(
      tmpDir,
      'github',
      [
        'id: github',
        'name: GitHub',
        'version: 1.0.0',
        'config:',
        '  - envName: GITHUB_TOKEN',
        '    label: Token',
        '    sensitive: true',
      ].join('\n'),
    );
    const registry = new PluginRegistry(tmpDir);
    const results = registry.scan();
    assert.equal(results.length, 1, 'github is a regular scanned plugin');
    assert.equal(results[0].id, 'github');
  });

  it('rejects symlinked plugin directories during scan', () => {
    tmpDir = mkdtempSync(join(os.tmpdir(), 'plugin-test-'));
    const externalDir = mkdtempSync(join(os.tmpdir(), 'plugin-external-'));
    writeTmpManifest(
      externalDir,
      'linked-plugin',
      [
        'id: linked-plugin',
        'name: Linked Plugin',
        'version: 1.0.0',
        'resources:',
        '  - type: skill',
        '    path: skills/linked',
      ].join('\n'),
    );
    symlinkSync(join(externalDir, 'linked-plugin'), join(tmpDir, 'linked-plugin'), 'dir');

    const registry = new PluginRegistry(tmpDir);
    const results = registry.scan();

    assert.deepEqual(
      results.map((manifest) => manifest.id),
      [],
      'plugin discovery must not follow plugin root directory symlinks',
    );
  });

  it('applies env-claim validation in deterministic plugin id order', async () => {
    tmpDir = mkdtempSync(join(os.tmpdir(), 'plugin-test-'));
    writeTmpManifest(
      tmpDir,
      'foo-bar',
      [
        'id: foo-bar',
        'name: Foo Bar',
        'version: 1.0.0',
        'config:',
        '  - envName: FOO_BAR_TOKEN',
        '    label: Token',
        '    sensitive: true',
      ].join('\n'),
    );
    writeTmpManifest(
      tmpDir,
      'foo',
      [
        'id: foo',
        'name: Foo',
        'version: 1.0.0',
        'config:',
        '  - envName: FOO_BAR_TOKEN',
        '    label: Token',
        '    sensitive: true',
      ].join('\n'),
    );

    const originalReaddirSync = fsModule.readdirSync;
    const readdirMock = mock.method(fsModule, 'readdirSync', (dir, ...args) => {
      if (dir === tmpDir) return ['foo-bar', 'foo'];
      return originalReaddirSync.call(fsModule, dir, ...args);
    });
    syncBuiltinESMExports();

    try {
      const { PluginRegistry: FreshPluginRegistry } = await import(
        `../dist/domains/plugin/PluginRegistry.js?scan-order=${Date.now()}`
      );
      const registry = new FreshPluginRegistry(tmpDir);
      const results = registry.scan();

      assert.deepEqual(
        results.map((manifest) => manifest.id),
        ['foo'],
        'env collision winner should not depend on filesystem scan order',
      );
    } finally {
      readdirMock.mock.restore();
      syncBuiltinESMExports();
    }
  });

  it('reports partial runtime state when required config is missing later', () => {
    const registry = new PluginRegistry('/tmp/nonexistent-plugins');
    const resource = { type: 'skill', path: 'skills/test-plugin' };
    const manifest = {
      id: 'test-plugin',
      name: 'Test',
      version: '1.0.0',
      builtin: false,
      config: [{ envName: 'TEST_PLUGIN_KEY', label: 'Key', sensitive: true, required: true }],
      resources: [resource],
    };
    const capabilities = {
      version: 1,
      capabilities: [
        {
          id: resourceCapId(manifest.id, resource),
          type: 'skill',
          enabled: true,
          source: 'cat-cafe',
          pluginId: manifest.id,
        },
      ],
    };

    assert.equal(registry.deriveStatus(manifest, capabilities, {}), 'partial');
  });

  it('does not treat stale plugin capability entries as declared resources', () => {
    const registry = new PluginRegistry('/tmp/nonexistent-plugins');
    const manifest = {
      id: 'test-plugin',
      name: 'Test',
      version: '1.0.0',
      builtin: false,
      config: [],
      resources: [{ type: 'skill', path: 'skills/current' }],
    };
    const capabilities = {
      version: 1,
      capabilities: [
        {
          id: 'plugin:test-plugin:old',
          type: 'skill',
          enabled: true,
          source: 'cat-cafe',
          pluginId: manifest.id,
        },
      ],
    };

    assert.equal(registry.deriveStatus(manifest, capabilities, {}), 'partial');
  });

  it('parses limb as supported resource type', () => {
    tmpDir = mkdtempSync(join(os.tmpdir(), 'plugin-test-'));
    const yamlPath = writeTmpManifest(
      tmpDir,
      'test-plugin',
      [
        'id: test-plugin',
        'name: Test',
        'version: 1.0.0',
        'resources:',
        '  - type: limb',
        '    path: limb.yml',
        '  - type: skill',
        '    path: skills/test',
      ].join('\n'),
    );
    const manifest = parsePluginManifest(yamlPath);
    assert.equal(manifest.resources.length, 2, 'both limb and skill should be parsed');
    assert.equal(manifest.resources[0].type, 'limb');
    assert.equal(manifest.resources[1].type, 'skill');
  });

  it('parses schedule resource with factoryId and name', () => {
    tmpDir = mkdtempSync(join(os.tmpdir(), 'plugin-test-'));
    const yamlPath = writeTmpManifest(
      tmpDir,
      'test-plugin',
      [
        'id: test-plugin',
        'name: Test',
        'version: 1.0.0',
        'resources:',
        '  - type: schedule',
        '    name: my-poller',
        '    factoryId: test.my-poller',
        '  - type: skill',
        '    path: skills/test',
      ].join('\n'),
    );
    const manifest = parsePluginManifest(yamlPath);
    assert.equal(manifest.resources.length, 2, 'schedule should be parsed as first-class resource');
    assert.equal(manifest.resources[0].type, 'schedule');
    assert.equal(manifest.resources[0].factoryId, 'test.my-poller');
    assert.equal(manifest.resources[0].name, 'my-poller');
    assert.equal(manifest.resources[1].type, 'skill');
  });

  it('rejects schedule resource without factoryId', () => {
    tmpDir = mkdtempSync(join(os.tmpdir(), 'plugin-test-'));
    const yamlPath = writeTmpManifest(
      tmpDir,
      'test-plugin',
      [
        'id: test-plugin',
        'name: Test',
        'version: 1.0.0',
        'resources:',
        '  - type: schedule',
        '    name: my-poller',
      ].join('\n'),
    );
    assert.throws(() => parsePluginManifest(yamlPath), /factoryId/);
  });

  it('rejects schedule resource without name', () => {
    tmpDir = mkdtempSync(join(os.tmpdir(), 'plugin-test-'));
    const yamlPath = writeTmpManifest(
      tmpDir,
      'test-plugin',
      [
        'id: test-plugin',
        'name: Test',
        'version: 1.0.0',
        'resources:',
        '  - type: schedule',
        '    factoryId: test.poller',
      ].join('\n'),
    );
    assert.throws(() => parsePluginManifest(yamlPath), /name/);
  });

  it('rejects unknown resource types instead of silently dropping them', () => {
    tmpDir = mkdtempSync(join(os.tmpdir(), 'plugin-test-'));
    const yamlPath = writeTmpManifest(
      tmpDir,
      'typo-plugin',
      ['id: typo-plugin', 'name: Typo', 'version: 1.0.0', 'resources:', '  - type: skll', '    path: skills/test'].join(
        '\n',
      ),
    );
    assert.throws(() => parsePluginManifest(yamlPath), /Unsupported resource type 'skll'/);
  });

  it('rejects absolute Windows resource paths', () => {
    tmpDir = mkdtempSync(join(os.tmpdir(), 'plugin-test-'));
    const yamlPath = writeTmpManifest(
      tmpDir,
      'win-path-plugin',
      [
        'id: win-path-plugin',
        'name: WinPath',
        'version: 1.0.0',
        'resources:',
        '  - type: skill',
        '    path: "C:\\\\secret\\\\skill"',
      ].join('\n'),
    );
    assert.throws(() => parsePluginManifest(yamlPath), /must be relative without/);
  });

  it('rejects resource entries missing type-specific required fields', () => {
    tmpDir = mkdtempSync(join(os.tmpdir(), 'plugin-test-'));
    const missingSkillPath = writeTmpManifest(
      tmpDir,
      'missing-skill-path',
      ['id: missing-skill-path', 'name: MissingSkillPath', 'version: 1.0.0', 'resources:', '  - type: skill'].join(
        '\n',
      ),
    );
    assert.throws(() => parsePluginManifest(missingSkillPath), /Skill resource .* must have a 'path'/);

    const missingMcpCommand = writeTmpManifest(
      tmpDir,
      'missing-mcp-command',
      [
        'id: missing-mcp-command',
        'name: MissingMcpCommand',
        'version: 1.0.0',
        'resources:',
        '  - type: mcp',
        '    name: local',
      ].join('\n'),
    );
    assert.throws(() => parsePluginManifest(missingMcpCommand), /MCP resource .* must have a 'command'/);
  });

  it('rejects invalid MCP transport declarations', () => {
    tmpDir = mkdtempSync(join(os.tmpdir(), 'plugin-test-'));
    const invalidTransport = writeTmpManifest(
      tmpDir,
      'invalid-mcp-transport',
      [
        'id: invalid-mcp-transport',
        'name: InvalidMcpTransport',
        'version: 1.0.0',
        'resources:',
        '  - type: mcp',
        '    name: remote',
        '    command: node',
        '    transport: websocket',
      ].join('\n'),
    );
    assert.throws(() => parsePluginManifest(invalidTransport), /Invalid MCP resource transport/);

    const streamableWithoutUrl = writeTmpManifest(
      tmpDir,
      'streamable-mcp-no-url',
      [
        'id: streamable-mcp-no-url',
        'name: StreamableMcpNoUrl',
        'version: 1.0.0',
        'resources:',
        '  - type: mcp',
        '    name: remote',
        '    transport: streamableHttp',
      ].join('\n'),
    );
    assert.throws(() => parsePluginManifest(streamableWithoutUrl), /must have a 'url' field/);
  });

  it('parses streamableHttp MCP resources with URL transport metadata', () => {
    tmpDir = mkdtempSync(join(os.tmpdir(), 'plugin-test-'));
    const yamlPath = writeTmpManifest(
      tmpDir,
      'streamable-mcp',
      [
        'id: streamable-mcp',
        'name: StreamableMcp',
        'version: 1.0.0',
        'resources:',
        '  - type: mcp',
        '    name: remote',
        '    transport: streamableHttp',
        '    url: https://example.test/mcp',
      ].join('\n'),
    );

    const manifest = parsePluginManifest(yamlPath);
    assert.deepEqual(manifest.resources[0], {
      type: 'mcp',
      path: undefined,
      name: 'remote',
      command: undefined,
      args: undefined,
      transport: 'streamableHttp',
      url: 'https://example.test/mcp',
    });
  });

  it('parses healthCheck from YAML', () => {
    tmpDir = mkdtempSync(join(os.tmpdir(), 'plugin-test-'));
    const yamlPath = writeTmpManifest(
      tmpDir,
      'test-plugin',
      ['id: test-plugin', 'name: Test', 'version: 1.0.0', 'healthCheck:', '  limbCommand: check_status'].join('\n'),
    );
    const manifest = parsePluginManifest(yamlPath);
    assert.ok(manifest.healthCheck, 'healthCheck should be parsed');
    assert.equal(manifest.healthCheck.limbCommand, 'check_status');
    assert.equal(manifest.healthCheck.mcpProbe, undefined);
  });

  it('omits healthCheck when not declared', () => {
    tmpDir = mkdtempSync(join(os.tmpdir(), 'plugin-test-'));
    const yamlPath = writeTmpManifest(
      tmpDir,
      'test-plugin',
      ['id: test-plugin', 'name: Test', 'version: 1.0.0'].join('\n'),
    );
    const manifest = parsePluginManifest(yamlPath);
    assert.equal(manifest.healthCheck, undefined);
  });

  it('rejects MCP resource without name', () => {
    tmpDir = mkdtempSync(join(os.tmpdir(), 'plugin-test-'));
    const yamlPath = writeTmpManifest(
      tmpDir,
      'no-name-mcp',
      [
        'id: no-name-mcp',
        'name: NoName',
        'version: 1.0.0',
        'resources:',
        '  - type: mcp',
        '    command: node',
        '    args: [server.js]',
      ].join('\n'),
    );
    assert.throws(() => parsePluginManifest(yamlPath), /must have a 'name' field/);
  });

  it('rejects duplicate MCP resource names within same plugin', () => {
    tmpDir = mkdtempSync(join(os.tmpdir(), 'plugin-test-'));
    const yamlPath = writeTmpManifest(
      tmpDir,
      'dup-mcp',
      [
        'id: dup-mcp',
        'name: DupMcp',
        'version: 1.0.0',
        'resources:',
        '  - type: mcp',
        '    name: shared',
        '    command: node',
        '    args: [a.js]',
        '  - type: mcp',
        '    name: shared',
        '    command: node',
        '    args: [b.js]',
      ].join('\n'),
    );
    assert.throws(() => parsePluginManifest(yamlPath), /Duplicate resource capability ID/);
  });

  it('uses MCP resource name as the stable capability ID even when path is present', () => {
    assert.equal(
      resourceCapId('test-plugin', { type: 'mcp', name: 'local', path: 'servers/local.yaml', command: 'node' }),
      'plugin:test-plugin:local',
    );
  });

  it('rejects envName with newline injection', () => {
    tmpDir = mkdtempSync(join(os.tmpdir(), 'plugin-test-'));
    const yamlPath = writeTmpManifest(
      tmpDir,
      'evil-plugin',
      [
        'id: evil-plugin',
        'name: Evil',
        'version: 1.0.0',
        'config:',
        '  - envName: "EVIL_PLUGIN_KEY\\nCAT_CAFE_SECRET"',
        '    label: Injected',
      ].join('\n'),
    );
    assert.throws(() => parsePluginManifest(yamlPath), /Invalid envName/);
  });

  it('rejects envName with spaces', () => {
    tmpDir = mkdtempSync(join(os.tmpdir(), 'plugin-test-'));
    const yamlPath = writeTmpManifest(
      tmpDir,
      'evil-plugin',
      [
        'id: evil-plugin',
        'name: Evil',
        'version: 1.0.0',
        'config:',
        '  - envName: "EVIL KEY"',
        '    label: Spaced',
      ].join('\n'),
    );
    assert.throws(() => parsePluginManifest(yamlPath), /Invalid envName/);
  });

  it('rejects envName with equals sign', () => {
    tmpDir = mkdtempSync(join(os.tmpdir(), 'plugin-test-'));
    const yamlPath = writeTmpManifest(
      tmpDir,
      'evil-plugin',
      [
        'id: evil-plugin',
        'name: Evil',
        'version: 1.0.0',
        'config:',
        '  - envName: "KEY=value"',
        '    label: Equals',
      ].join('\n'),
    );
    assert.throws(() => parsePluginManifest(yamlPath), /Invalid envName/);
  });
});

describe('validateEnvSafety security', () => {
  it('community plugin cannot use unprefixed env var', () => {
    const manifest = {
      id: 'evil-plugin',
      name: 'Evil',
      version: '1.0.0',
      builtin: false,
      config: [{ envName: 'OPENAI_API_KEY', label: 'Key', sensitive: true, required: true }],
      resources: [],
    };
    const result = validateEnvSafety(manifest, new Map());
    assert.equal(result.ok, false);
    assert.ok(result.errors[0].includes('must start with'));
  });

  it('community plugin with self-declared builtin=true still fails prefix check', () => {
    const manifest = {
      id: 'evil-plugin',
      name: 'Evil',
      version: '1.0.0',
      builtin: false,
      config: [{ envName: 'GITHUB_TOKEN', label: 'Token', sensitive: true, required: true }],
      resources: [],
    };
    const result = validateEnvSafety(manifest, new Map());
    assert.equal(result.ok, false);
    assert.ok(result.errors[0].includes('must start with'));
  });

  it('builtin plugin can use non-prefixed env var', () => {
    const manifest = {
      id: 'github',
      name: 'GitHub',
      version: '1.0.0',
      builtin: true,
      config: [{ envName: 'GITHUB_TOKEN', label: 'Token', sensitive: true, required: true }],
      resources: [],
    };
    const result = validateEnvSafety(manifest, new Map());
    assert.equal(result.ok, true);
  });

  it('rejects system env vars even for builtin plugins', () => {
    const manifest = {
      id: 'github',
      name: 'GitHub',
      version: '1.0.0',
      builtin: true,
      config: [{ envName: 'CAT_CAFE_SECRET', label: 'Secret', sensitive: true, required: true }],
      resources: [],
    };
    const result = validateEnvSafety(manifest, new Map());
    assert.equal(result.ok, false);
    assert.ok(result.errors[0].includes('reserved system'));
  });

  it('rejects cross-plugin env collision', () => {
    const manifest = {
      id: 'my-plugin',
      name: 'Mine',
      version: '1.0.0',
      builtin: false,
      config: [{ envName: 'MY_PLUGIN_KEY', label: 'Key', sensitive: true, required: true }],
      resources: [],
    };
    const claims = new Map([['MY_PLUGIN_KEY', 'other-plugin']]);
    const result = validateEnvSafety(manifest, claims);
    assert.equal(result.ok, false);
    assert.ok(result.errors[0].includes('already claimed'));
  });

  it('rejects cross-plugin env collision with case-insensitive names', () => {
    const manifest = {
      id: 'my-plugin',
      name: 'Mine',
      version: '1.0.0',
      builtin: false,
      config: [{ envName: 'my_plugin_key', label: 'Key', sensitive: true, required: true }],
      resources: [],
    };
    const claims = new Map([['MY_PLUGIN_KEY', 'other-plugin']]);
    const result = validateEnvSafety(manifest, claims);
    assert.equal(result.ok, false);
    assert.ok(result.errors[0].includes('already claimed'));
  });
});

describe('PluginResourceActivator skill safety', () => {
  it('normalizes Windows-style skill resource paths for activation and disable cleanup', async () => {
    const root = mkdtempSync(join(os.tmpdir(), 'plugin-activator-root-'));
    const pluginsDir = join(root, 'plugins');
    const projectRoot = join(root, 'project');
    const skillSourceDir = join(pluginsDir, 'test-plugin', 'skills', 'plugin-skill');
    mkdirSync(skillSourceDir, { recursive: true });
    writeFileSync(join(skillSourceDir, 'SKILL.md'), '# Test Skill\n');

    let persisted = { version: 1, capabilities: [] };
    const activator = new PluginResourceActivator({
      resolveProjectRoot: () => projectRoot,
      pluginsDir,
      limbRegistry: {},
      readCapabilities: async () => structuredClone(persisted),
      writeCapabilities: async (config) => {
        persisted = structuredClone(config);
      },
      withCapabilityLock: async (fn) => fn(),
    });
    const manifest = {
      id: 'test-plugin',
      name: 'Test Plugin',
      version: '1.0.0',
      builtin: false,
      config: [],
      resources: [{ type: 'skill', path: 'skills\\plugin-skill' }],
    };

    const enableResult = await activator.enablePlugin(manifest);

    assert.equal(enableResult.status, 'success');
    const codexLink = join(projectRoot, '.codex', 'skills', 'plugin-skill');
    // F228: mountSkillForProject creates relative symlinks; compare resolved targets
    assert.equal(realpathSync(codexLink), realpathSync(skillSourceDir));
    assert.equal(existsSync(join(projectRoot, '.codex', 'skills', 'skills')), false);
    assert.equal(persisted.capabilities[0].id, 'plugin-skill');
    assert.equal(persisted.capabilities[0].enabled, true);

    const disableResult = await activator.disablePlugin(manifest);

    assert.equal(disableResult.status, 'success');
    assert.equal(existsSync(codexLink), false);
    assert.equal(persisted.capabilities[0].id, 'plugin-skill');
    assert.equal(persisted.capabilities[0].enabled, false);
  });

  it('inherits main default mount rules when activating external project skills', async () => {
    const root = mkdtempSync(join(os.tmpdir(), 'plugin-activator-root-'));
    const mainRoot = join(root, 'main');
    const pluginsDir = join(root, 'plugins');
    const projectRoot = join(root, 'external-project');
    const skillSourceDir = join(pluginsDir, 'test-plugin', 'skills', 'plugin-skill');
    mkdirSync(skillSourceDir, { recursive: true });
    mkdirSync(join(mainRoot, '.cat-cafe'), { recursive: true });
    writeFileSync(join(skillSourceDir, 'SKILL.md'), '# Test Skill\n');
    writeFileSync(
      join(mainRoot, '.cat-cafe', 'capabilities.json'),
      JSON.stringify({
        version: 2,
        capabilities: [],
        defaultMountRules: [
          { name: 'claude', path: '.claude/skills', enabled: true },
          { name: 'codex', path: '.codex/skills', enabled: false },
          { name: 'gemini', path: '.gemini/skills', enabled: false },
          { name: 'kimi', path: '.kimi/skills', enabled: false },
          { name: 'acp', path: '.acp/skills', enabled: true },
        ],
      }),
    );

    let persisted = { version: 1, capabilities: [] };
    const activator = new PluginResourceActivator({
      resolveProjectRoot: () => projectRoot,
      resolveMainProjectRoot: () => mainRoot,
      pluginsDir,
      limbRegistry: {},
      readCapabilities: async () => structuredClone(persisted),
      writeCapabilities: async (config) => {
        persisted = structuredClone(config);
      },
      withCapabilityLock: async (fn) => fn(),
    });
    const manifest = {
      id: 'test-plugin',
      name: 'Test Plugin',
      version: '1.0.0',
      builtin: false,
      config: [],
      resources: [{ type: 'skill', path: 'skills/plugin-skill' }],
    };

    const enableResult = await activator.enablePlugin(manifest);

    assert.equal(enableResult.status, 'success');
    assert.equal(realpathSync(join(projectRoot, '.claude', 'skills', 'plugin-skill')), realpathSync(skillSourceDir));
    assert.equal(realpathSync(join(projectRoot, '.acp', 'skills', 'plugin-skill')), realpathSync(skillSourceDir));
    assert.equal(
      existsSync(join(projectRoot, '.codex', 'skills', 'plugin-skill')),
      false,
      'plugin skill activation must honor disabled default providers inherited from main project',
    );
  });

  it('honors existing plugin skill mountPaths policy during activation', async () => {
    const root = mkdtempSync(join(os.tmpdir(), 'plugin-activator-root-'));
    const pluginsDir = join(root, 'plugins');
    const projectRoot = join(root, 'project');
    const skillSourceDir = join(pluginsDir, 'test-plugin', 'skills', 'plugin-skill');
    mkdirSync(skillSourceDir, { recursive: true });
    writeFileSync(join(skillSourceDir, 'SKILL.md'), '# Test Skill\n');

    let persisted = {
      version: 1,
      capabilities: [
        {
          id: 'plugin-skill',
          type: 'skill',
          enabled: false,
          source: 'cat-cafe',
          pluginId: 'test-plugin',
          mountPaths: ['claude'],
        },
      ],
    };
    const activator = new PluginResourceActivator({
      resolveProjectRoot: () => projectRoot,
      pluginsDir,
      limbRegistry: {},
      readCapabilities: async () => structuredClone(persisted),
      writeCapabilities: async (config) => {
        persisted = structuredClone(config);
      },
      withCapabilityLock: async (fn) => fn(),
    });
    const manifest = {
      id: 'test-plugin',
      name: 'Test Plugin',
      version: '1.0.0',
      builtin: false,
      config: [],
      resources: [{ type: 'skill', path: 'skills/plugin-skill' }],
    };

    const enableResult = await activator.enablePlugin(manifest);

    assert.equal(enableResult.status, 'success');
    assert.equal(realpathSync(join(projectRoot, '.claude', 'skills', 'plugin-skill')), realpathSync(skillSourceDir));
    assert.equal(
      existsSync(join(projectRoot, '.codex', 'skills', 'plugin-skill')),
      false,
      'activation must not mount outside existing plugin mountPaths',
    );
    assert.deepEqual(persisted.capabilities[0].mountPaths, ['claude']);
    assert.equal(persisted.capabilities[0].enabled, true);
  });

  it('rejects plugin skill activation through provider skills root symlink', async () => {
    const root = mkdtempSync(join(os.tmpdir(), 'plugin-activator-root-'));
    const pluginsDir = join(root, 'plugins');
    const projectRoot = join(root, 'project');
    const sharedSkillsDir = join(root, 'shared-skills');
    const skillSourceDir = join(pluginsDir, 'test-plugin', 'skills', 'plugin-skill');
    mkdirSync(skillSourceDir, { recursive: true });
    writeFileSync(join(skillSourceDir, 'SKILL.md'), '# Test Skill\n');
    mkdirSync(sharedSkillsDir, { recursive: true });
    mkdirSync(join(projectRoot, '.claude'), { recursive: true });
    symlinkSync(sharedSkillsDir, join(projectRoot, '.claude', 'skills'), 'dir');

    const manifest = {
      id: 'test-plugin',
      name: 'Test Plugin',
      version: '1.0.0',
      builtin: false,
      config: [],
      resources: [{ type: 'skill', path: 'skills/plugin-skill' }],
    };
    const activator = new PluginResourceActivator({
      resolveProjectRoot: () => projectRoot,
      pluginsDir,
      limbRegistry: {},
      readCapabilities: async () => ({ version: 1, capabilities: [] }),
      writeCapabilities: async () => {},
      withCapabilityLock: async (fn) => fn(),
    });

    const result = await activator.enablePlugin(manifest);

    assert.equal(result.status, 'failed');
    // F228: mountSkillForProject delegates to isManagedDirectoryLevelSkillsSymlink
    // which uses "directory-level skills mount" in its error messages
    assert.match(result.resources[0].error, /directory-level skills mount/);
    assert.equal(existsSync(join(sharedSkillsDir, 'plugin-skill')), false);
  });

  it('rejects plugin skill source symlinks that escape the plugin root', async () => {
    const root = mkdtempSync(join(os.tmpdir(), 'plugin-activator-root-'));
    const pluginsDir = join(root, 'plugins');
    const projectRoot = join(root, 'project');
    const externalSkillDir = join(root, 'external-skill');
    const skillLinkPath = join(pluginsDir, 'test-plugin', 'skills', 'plugin-skill');
    mkdirSync(externalSkillDir, { recursive: true });
    mkdirSync(join(pluginsDir, 'test-plugin', 'skills'), { recursive: true });
    symlinkSync(externalSkillDir, skillLinkPath, 'dir');

    let persisted = { version: 1, capabilities: [] };
    const activator = new PluginResourceActivator({
      resolveProjectRoot: () => projectRoot,
      pluginsDir,
      limbRegistry: {},
      readCapabilities: async () => structuredClone(persisted),
      writeCapabilities: async (config) => {
        persisted = structuredClone(config);
      },
      withCapabilityLock: async (fn) => fn(),
    });

    const result = await activator.enablePlugin({
      id: 'test-plugin',
      name: 'Test Plugin',
      version: '1.0.0',
      builtin: false,
      config: [],
      resources: [{ type: 'skill', path: 'skills/plugin-skill' }],
    });

    assert.equal(result.status, 'failed');
    assert.match(result.resources[0].error, /must resolve inside plugin root/);
    assert.equal(existsSync(join(projectRoot, '.codex', 'skills', 'plugin-skill')), false);
    assert.deepEqual(persisted.capabilities, []);
  });

  it('rejects skill resource that resolves to a file instead of a directory', async () => {
    const root = mkdtempSync(join(os.tmpdir(), 'plugin-activator-root-'));
    const pluginsDir = join(root, 'plugins');
    const projectRoot = join(root, 'project');
    const skillParent = join(pluginsDir, 'test-plugin', 'skills');
    mkdirSync(skillParent, { recursive: true });
    // Create a regular file instead of a directory
    writeFileSync(join(skillParent, 'plugin-skill'), 'not a directory');

    let persisted = { version: 1, capabilities: [] };
    const activator = new PluginResourceActivator({
      resolveProjectRoot: () => projectRoot,
      pluginsDir,
      limbRegistry: {},
      readCapabilities: async () => structuredClone(persisted),
      writeCapabilities: async (config) => {
        persisted = structuredClone(config);
      },
      withCapabilityLock: async (fn) => fn(),
    });

    const result = await activator.enablePlugin({
      id: 'test-plugin',
      name: 'Test Plugin',
      version: '1.0.0',
      builtin: false,
      config: [],
      resources: [{ type: 'skill', path: 'skills/plugin-skill' }],
    });

    assert.equal(result.status, 'failed');
    assert.match(result.resources[0].error, /must be a directory/);
    // No symlinks should be created
    assert.equal(existsSync(join(projectRoot, '.codex', 'skills', 'plugin-skill')), false);
    assert.deepEqual(persisted.capabilities, []);
  });

  it('rejects skill resource directory that lacks SKILL.md', async () => {
    const root = mkdtempSync(join(os.tmpdir(), 'plugin-activator-root-'));
    const pluginsDir = join(root, 'plugins');
    const projectRoot = join(root, 'project');
    // Directory exists but has no SKILL.md
    const skillDir = join(pluginsDir, 'test-plugin', 'skills', 'plugin-skill');
    mkdirSync(skillDir, { recursive: true });

    let persisted = { version: 1, capabilities: [] };
    const activator = new PluginResourceActivator({
      resolveProjectRoot: () => projectRoot,
      pluginsDir,
      limbRegistry: {},
      readCapabilities: async () => structuredClone(persisted),
      writeCapabilities: async (config) => {
        persisted = structuredClone(config);
      },
      withCapabilityLock: async (fn) => fn(),
    });

    const result = await activator.enablePlugin({
      id: 'test-plugin',
      name: 'Test Plugin',
      version: '1.0.0',
      builtin: false,
      config: [],
      resources: [{ type: 'skill', path: 'skills/plugin-skill' }],
    });

    assert.equal(result.status, 'failed');
    assert.match(result.resources[0].error, /must contain SKILL\.md/);
    assert.equal(existsSync(join(projectRoot, '.codex', 'skills', 'plugin-skill')), false);
    assert.deepEqual(persisted.capabilities, []);
  });

  it('rolls back capability state and symlinks when CLI regeneration fails', async () => {
    const root = mkdtempSync(join(os.tmpdir(), 'plugin-activator-root-'));
    const pluginsDir = join(root, 'plugins');
    const projectRoot = join(root, 'project');
    const skillSourceDir = join(pluginsDir, 'test-plugin', 'skills', 'plugin-skill');
    mkdirSync(skillSourceDir, { recursive: true });
    writeFileSync(join(skillSourceDir, 'SKILL.md'), '# Test Skill\n');

    let persisted = {
      version: 1,
      capabilities: [{ id: 'existing', type: 'skill', enabled: true, source: 'cat-cafe' }],
    };
    let writes = 0;
    const activator = new PluginResourceActivator({
      resolveProjectRoot: () => projectRoot,
      pluginsDir,
      limbRegistry: {},
      readCapabilities: async () => structuredClone(persisted),
      writeCapabilities: async (config) => {
        persisted = structuredClone(config);
        if (writes++ === 0) throw new Error('generateCliConfigs failed');
      },
      withCapabilityLock: async (fn) => fn(),
    });

    const result = await activator.enablePlugin({
      id: 'test-plugin',
      name: 'Test Plugin',
      version: '1.0.0',
      builtin: false,
      config: [],
      resources: [{ type: 'skill', path: 'skills/plugin-skill' }],
    });

    assert.equal(result.status, 'failed');
    assert.deepEqual(
      persisted.capabilities.map((c) => c.id),
      ['existing'],
    );
    assert.equal(existsSync(join(projectRoot, '.codex', 'skills', 'plugin-skill')), false);
  });

  it('preserves existing plugin skill mounts when activation capability write fails', async () => {
    const root = mkdtempSync(join(os.tmpdir(), 'plugin-activator-root-'));
    const pluginsDir = join(root, 'plugins');
    const projectRoot = join(root, 'project');
    const skillSourceDir = join(pluginsDir, 'test-plugin', 'skills', 'plugin-skill');
    const codexLink = join(projectRoot, '.codex', 'skills', 'plugin-skill');
    mkdirSync(skillSourceDir, { recursive: true });
    mkdirSync(join(projectRoot, '.codex', 'skills'), { recursive: true });
    writeFileSync(join(skillSourceDir, 'SKILL.md'), '# Test Skill\n');
    symlinkSync(skillSourceDir, codexLink, 'dir');

    let persisted = {
      version: 1,
      capabilities: [
        {
          id: 'plugin-skill',
          type: 'skill',
          enabled: true,
          source: 'cat-cafe',
          pluginId: 'test-plugin',
        },
      ],
    };
    let writes = 0;
    const activator = new PluginResourceActivator({
      resolveProjectRoot: () => projectRoot,
      pluginsDir,
      limbRegistry: {},
      readCapabilities: async () => structuredClone(persisted),
      writeCapabilities: async (config) => {
        persisted = structuredClone(config);
        if (writes++ === 0) throw new Error('generateCliConfigs failed');
      },
      withCapabilityLock: async (fn) => fn(),
    });

    const result = await activator.enablePlugin({
      id: 'test-plugin',
      name: 'Test Plugin',
      version: '1.0.0',
      builtin: false,
      config: [],
      resources: [{ type: 'skill', path: 'skills/plugin-skill' }],
    });

    assert.equal(result.status, 'failed');
    assert.equal(realpathSync(codexLink), realpathSync(skillSourceDir));
    assert.deepEqual(persisted.capabilities, [
      {
        id: 'plugin-skill',
        type: 'skill',
        enabled: true,
        source: 'cat-cafe',
        pluginId: 'test-plugin',
      },
    ]);
  });

  it('persists plugin MCP workingDir and env from resolved config sources', async () => {
    const root = mkdtempSync(join(os.tmpdir(), 'plugin-activator-root-'));
    const pluginsDir = join(root, 'plugins');
    const projectRoot = join(root, 'project');
    process.env.TEST_PLUGIN_TOKEN = 'from-env';
    let persisted = { version: 1, capabilities: [] };
    try {
      const activator = new PluginResourceActivator({
        resolveProjectRoot: () => projectRoot,
        pluginsDir,
        limbRegistry: {},
        readCapabilities: async () => structuredClone(persisted),
        writeCapabilities: async (config) => {
          persisted = structuredClone(config);
        },
        withCapabilityLock: async (fn) => fn(),
      });

      const result = await activator.enablePlugin({
        id: 'test-plugin',
        name: 'Test Plugin',
        version: '1.0.0',
        builtin: false,
        config: [{ envName: 'TEST_PLUGIN_TOKEN', label: 'Token', sensitive: true, required: true }],
        resources: [{ type: 'mcp', name: 'local', command: 'node', args: ['server.js'] }],
      });

      assert.equal(result.status, 'success');
      assert.equal(persisted.capabilities[0].mcpServer.workingDir, join(pluginsDir, 'test-plugin'));
      assert.deepEqual(persisted.capabilities[0].mcpServer.env, { TEST_PLUGIN_TOKEN: 'from-env' });
    } finally {
      delete process.env.TEST_PLUGIN_TOKEN;
    }
  });

  it('persists plugin streamableHttp MCP URL descriptors', async () => {
    const root = mkdtempSync(join(os.tmpdir(), 'plugin-activator-root-'));
    const pluginsDir = join(root, 'plugins');
    const projectRoot = join(root, 'project');
    let persisted = { version: 1, capabilities: [] };
    const activator = new PluginResourceActivator({
      resolveProjectRoot: () => projectRoot,
      pluginsDir,
      limbRegistry: {},
      readCapabilities: async () => structuredClone(persisted),
      writeCapabilities: async (config) => {
        persisted = structuredClone(config);
      },
      withCapabilityLock: async (fn) => fn(),
    });

    const result = await activator.enablePlugin({
      id: 'test-plugin',
      name: 'Test Plugin',
      version: '1.0.0',
      builtin: false,
      config: [],
      resources: [{ type: 'mcp', name: 'remote', transport: 'streamableHttp', url: 'https://example.test/mcp' }],
    });

    assert.equal(result.status, 'success');
    assert.equal(persisted.capabilities[0].mcpServer.transport, 'streamableHttp');
    assert.equal(persisted.capabilities[0].mcpServer.url, 'https://example.test/mcp');
    assert.equal(persisted.capabilities[0].mcpServer.command, '');
  });

  it('removes stale plugin-owned MCP and limb capabilities during disable', async () => {
    const root = mkdtempSync(join(os.tmpdir(), 'plugin-activator-root-'));
    const pluginsDir = join(root, 'plugins');
    const projectRoot = join(root, 'project');
    const deregistered = [];
    let persisted = {
      version: 1,
      capabilities: [
        {
          id: 'plugin:test-plugin:current',
          type: 'mcp',
          enabled: true,
          source: 'cat-cafe',
          pluginId: 'test-plugin',
        },
        {
          id: 'plugin:test-plugin:old-mcp',
          type: 'mcp',
          enabled: true,
          source: 'cat-cafe',
          pluginId: 'test-plugin',
        },
        {
          id: 'plugin:test-plugin:old-limb',
          type: 'limb',
          enabled: true,
          source: 'cat-cafe',
          pluginId: 'test-plugin',
          limbNodeId: 'old-node',
        },
        {
          id: 'plugin:other-plugin:keep',
          type: 'mcp',
          enabled: true,
          source: 'cat-cafe',
          pluginId: 'other-plugin',
        },
      ],
    };
    const activator = new PluginResourceActivator({
      resolveProjectRoot: () => projectRoot,
      pluginsDir,
      limbRegistry: {
        deregister: (nodeId) => {
          deregistered.push(nodeId);
        },
      },
      readCapabilities: async () => structuredClone(persisted),
      writeCapabilities: async (config) => {
        persisted = structuredClone(config);
      },
      withCapabilityLock: async (fn) => fn(),
    });

    const result = await activator.disablePlugin({
      id: 'test-plugin',
      name: 'Test Plugin',
      version: '1.0.0',
      builtin: false,
      config: [],
      resources: [{ type: 'mcp', name: 'current', command: 'node' }],
    });

    assert.equal(result.status, 'success');
    assert.deepEqual(
      persisted.capabilities.map((c) => c.id),
      ['plugin:other-plugin:keep'],
    );
    assert.deepEqual(deregistered, ['old-node']);
  });
});

describe('PluginResourceActivator conflict & rollback (review P1-2, P2-1)', () => {
  it('P1-2: enablePlugin fails when all mount points conflict (no silent success)', async () => {
    const root = mkdtempSync(join(os.tmpdir(), 'plugin-activator-p12-'));
    const pluginsDir = join(root, 'plugins');
    const projectRoot = join(root, 'project');
    const skillSourceDir = join(pluginsDir, 'test-plugin', 'skills', 'my-skill');
    mkdirSync(skillSourceDir, { recursive: true });
    writeFileSync(join(skillSourceDir, 'SKILL.md'), '# Test Skill\n');

    // Create user-owned directories at ALL standard provider paths → all conflict
    for (const provider of ['claude', 'codex', 'gemini', 'kimi']) {
      const userDir = join(projectRoot, `.${provider}`, 'skills', 'my-skill');
      mkdirSync(userDir, { recursive: true });
      writeFileSync(join(userDir, 'user-file.md'), 'user content');
    }

    let persisted = { version: 1, capabilities: [] };
    const activator = new PluginResourceActivator({
      resolveProjectRoot: () => projectRoot,
      pluginsDir,
      limbRegistry: {},
      readCapabilities: async () => structuredClone(persisted),
      writeCapabilities: async (config) => {
        persisted = structuredClone(config);
      },
      withCapabilityLock: async (fn) => fn(),
    });
    const manifest = {
      id: 'test-plugin',
      name: 'Test Plugin',
      version: '1.0.0',
      builtin: false,
      config: [],
      resources: [{ type: 'skill', path: 'skills/my-skill' }],
    };

    const result = await activator.enablePlugin(manifest);

    // Must report failure — not silent success with zero mounts
    assert.equal(result.status, 'failed', 'all-conflict activation must fail');
    const skillResult = result.resources?.find((r) => r.type === 'skill');
    assert.ok(skillResult, 'skill result should exist in resources');
    assert.equal(skillResult.ok, false, 'skill activation should report ok=false');
    assert.ok(skillResult.error, 'skill result should have an error message');
    assert.ok(skillResult.error.includes('All mount points conflict'), 'error should mention all-conflict');
  });

  it('P2-1: rollback cleans up custom mount alias symlinks (not just standard providers)', async () => {
    // Original bug: rollback used mountRules.mountPoints[m.mountPointId].path to rebuild
    // the link path, which misses custom aliases entirely. Fix uses m.path directly.
    // This test disables ALL standard providers and uses ONLY a custom alias (acp)
    // so the old buggy code would leave the symlink behind.
    const root = mkdtempSync(join(os.tmpdir(), 'plugin-activator-p21-'));
    const pluginsDir = join(root, 'plugins');
    const projectRoot = join(root, 'project');
    const skillSourceDir = join(pluginsDir, 'test-plugin', 'skills', 'rollback-skill');
    mkdirSync(skillSourceDir, { recursive: true });
    writeFileSync(join(skillSourceDir, 'SKILL.md'), '# Test Skill\n');

    // Write capabilities.json with custom-only mount rules (standard providers disabled)
    const catCafeDir = join(projectRoot, '.cat-cafe');
    mkdirSync(catCafeDir, { recursive: true });
    writeFileSync(
      join(catCafeDir, 'capabilities.json'),
      JSON.stringify({
        version: 2,
        capabilities: [],
        mountRules: [
          { name: 'claude', path: '.claude/skills', enabled: false },
          { name: 'codex', path: '.codex/skills', enabled: false },
          { name: 'gemini', path: '.gemini/skills', enabled: false },
          { name: 'kimi', path: '.kimi/skills', enabled: false },
          { name: 'acp', path: '.acp/skills', enabled: true },
        ],
      }),
    );

    let writeCallCount = 0;
    const activator = new PluginResourceActivator({
      resolveProjectRoot: () => projectRoot,
      pluginsDir,
      limbRegistry: {},
      readCapabilities: async () => {
        // Read real config for mount rules resolution, but fail on write
        const { readCapabilitiesConfig } = await import('../dist/config/capabilities/capability-orchestrator.js');
        return readCapabilitiesConfig(projectRoot);
      },
      writeCapabilities: async () => {
        writeCallCount++;
        throw new Error('Simulated config write failure');
      },
      withCapabilityLock: async (fn) => fn(),
    });
    const manifest = {
      id: 'test-plugin',
      name: 'Test Plugin',
      version: '1.0.0',
      builtin: false,
      config: [],
      resources: [{ type: 'skill', path: 'skills/rollback-skill' }],
    };

    const result = await activator.enablePlugin(manifest);

    assert.equal(result.status, 'failed', 'config write failure should fail activation');
    const skillResult = result.resources?.find((r) => r.type === 'skill');
    assert.equal(skillResult?.ok, false, 'skill activation should report ok=false');
    assert.ok(skillResult?.error?.includes('Simulated config write failure'), 'error should propagate');

    // The custom acp symlink must be cleaned up by rollback
    const acpLink = join(projectRoot, '.acp', 'skills', 'rollback-skill');
    assert.equal(existsSync(acpLink), false, 'custom alias symlink should be removed by rollback');

    // Standard providers were disabled — no symlinks should exist there either
    for (const provider of ['claude', 'codex', 'gemini', 'kimi']) {
      const linkPath = join(projectRoot, `.${provider}`, 'skills', 'rollback-skill');
      assert.equal(existsSync(linkPath), false, `disabled ${provider} should have no symlink`);
    }
  });
});

describe('PluginResourceActivator limb activation safety', () => {
  function testLimbNode(nodeId) {
    return {
      nodeId,
      displayName: 'Test Limb',
      platform: 'test',
      capabilities: [],
      register: async () => {},
      invoke: async () => ({ ok: true }),
      healthCheck: async () => 'online',
      deregister: async () => {},
    };
  }

  it('updates capability type when reusing a plugin-owned entry', async () => {
    const root = mkdtempSync(join(os.tmpdir(), 'plugin-limb-activator-'));
    const pluginsDir = join(root, 'plugins');
    const projectRoot = join(root, 'project');
    mkdirSync(join(pluginsDir, 'test-plugin'), { recursive: true });
    writeFileSync(join(pluginsDir, 'test-plugin', 'shared'), 'nodeId: new-node\n');
    let persisted = {
      version: 1,
      capabilities: [
        {
          id: 'plugin:test-plugin:shared',
          type: 'mcp',
          enabled: true,
          source: 'cat-cafe',
          pluginId: 'test-plugin',
          mcpServer: { command: 'node', args: ['old.js'], transport: 'stdio' },
        },
      ],
    };
    const registered = [];

    const activator = new PluginResourceActivator({
      resolveProjectRoot: () => projectRoot,
      pluginsDir,
      limbRegistry: {
        register: async (node) => {
          registered.push(node.nodeId);
        },
      },
      readCapabilities: async () => structuredClone(persisted),
      writeCapabilities: async (config) => {
        persisted = structuredClone(config);
      },
      withCapabilityLock: async (fn) => fn(),
      limbAdapterFactory: async () => testLimbNode('new-node'),
    });

    const result = await activator.enablePlugin({
      id: 'test-plugin',
      name: 'Test Plugin',
      version: '1.0.0',
      builtin: false,
      config: [],
      resources: [{ type: 'limb', path: 'shared' }],
    });

    assert.equal(result.status, 'success');
    assert.deepEqual(registered, ['new-node']);
    assert.equal(persisted.capabilities[0].type, 'limb');
    assert.equal(persisted.capabilities[0].limbNodeId, 'new-node');
    assert.equal(persisted.capabilities[0].mcpServer, undefined);
  });

  it('rejects plugin limb source symlinks that escape the plugin root', async () => {
    const root = mkdtempSync(join(os.tmpdir(), 'plugin-limb-activator-'));
    const pluginsDir = join(root, 'plugins');
    const projectRoot = join(root, 'project');
    const pluginLimbDir = join(pluginsDir, 'test-plugin', 'limbs');
    const outsideDir = join(root, 'outside');
    mkdirSync(pluginLimbDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    const outsideYaml = join(outsideDir, 'node.yaml');
    writeFileSync(outsideYaml, ['nodeId: outside-node', 'displayName: Outside', 'platform: test'].join('\n'));
    symlinkSync(outsideYaml, join(pluginLimbDir, 'node.yaml'));

    let adapterCalled = false;
    let persisted = { version: 1, capabilities: [] };
    const activator = new PluginResourceActivator({
      resolveProjectRoot: () => projectRoot,
      pluginsDir,
      limbRegistry: {
        register: async () => {},
      },
      readCapabilities: async () => structuredClone(persisted),
      writeCapabilities: async (config) => {
        persisted = structuredClone(config);
      },
      withCapabilityLock: async (fn) => fn(),
      limbAdapterFactory: async () => {
        adapterCalled = true;
        return testLimbNode('outside-node');
      },
    });

    const result = await activator.enablePlugin({
      id: 'test-plugin',
      name: 'Test Plugin',
      version: '1.0.0',
      builtin: false,
      config: [],
      resources: [{ type: 'limb', path: 'limbs/node.yaml' }],
    });

    assert.equal(result.status, 'failed');
    assert.match(result.resources[0].error, /must resolve inside plugin root/);
    assert.equal(adapterCalled, false, 'escaping limb resource must be rejected before adapter load');
    assert.deepEqual(persisted.capabilities, [], 'escaping limb resource must not persist enabled state');
  });

  it('preserves an existing limb capability entry when re-enable registration fails', async () => {
    const root = mkdtempSync(join(os.tmpdir(), 'plugin-limb-activator-'));
    const pluginsDir = join(root, 'plugins');
    const projectRoot = join(root, 'project');
    const resource = { type: 'limb', path: 'limbs/node.yaml' };
    mkdirSync(join(pluginsDir, 'test-plugin', 'limbs'), { recursive: true });
    writeFileSync(join(pluginsDir, 'test-plugin', 'limbs', 'node.yaml'), 'nodeId: existing-node\n');
    const existingEntry = {
      id: 'plugin:test-plugin:limbs/node.yaml',
      type: 'limb',
      enabled: true,
      source: 'cat-cafe',
      pluginId: 'test-plugin',
      limbNodeId: 'existing-node',
    };
    let persisted = { version: 1, capabilities: [existingEntry] };
    const before = structuredClone(persisted);

    const activator = new PluginResourceActivator({
      resolveProjectRoot: () => projectRoot,
      pluginsDir,
      limbRegistry: {
        register: async () => {
          throw new Error('node already registered');
        },
      },
      readCapabilities: async () => structuredClone(persisted),
      writeCapabilities: async (config) => {
        persisted = structuredClone(config);
      },
      withCapabilityLock: async (fn) => fn(),
      limbAdapterFactory: async () => testLimbNode('existing-node'),
    });

    const result = await activator.enablePlugin({
      id: 'test-plugin',
      name: 'Test Plugin',
      version: '1.0.0',
      builtin: false,
      config: [],
      resources: [resource],
    });

    assert.equal(result.status, 'failed');
    assert.match(result.resources[0].error, /already registered/);
    assert.deepEqual(persisted, before, 'failed limb re-enable must restore the previous capability entry');
  });

  it('does not deregister a limb unless the plugin owns an enabled capability entry', async () => {
    const root = mkdtempSync(join(os.tmpdir(), 'plugin-limb-activator-'));
    const pluginsDir = join(root, 'plugins');
    const projectRoot = join(root, 'project');
    mkdirSync(join(pluginsDir, 'test-plugin', 'limbs'), { recursive: true });
    writeFileSync(
      join(pluginsDir, 'test-plugin', 'limbs', 'node.yaml'),
      [
        'nodeId: shared-node',
        'displayName: Shared Node',
        'platform: test',
        'capabilities:',
        '  - cap: shared',
        '    commands: [ping]',
        '    authLevel: free',
      ].join('\n'),
    );

    const deregistered = [];
    let persisted = { version: 1, capabilities: [] };
    const activator = new PluginResourceActivator({
      resolveProjectRoot: () => projectRoot,
      pluginsDir,
      limbRegistry: {
        deregister: (nodeId) => {
          deregistered.push(nodeId);
        },
      },
      readCapabilities: async () => structuredClone(persisted),
      writeCapabilities: async (config) => {
        persisted = structuredClone(config);
      },
      withCapabilityLock: async (fn) => fn(),
    });

    const result = await activator.disablePlugin({
      id: 'test-plugin',
      name: 'Test Plugin',
      version: '1.0.0',
      builtin: false,
      config: [],
      resources: [{ type: 'limb', path: 'limbs/node.yaml' }],
    });

    assert.equal(result.status, 'success');
    assert.deepEqual(deregistered, [], 'disable must not deregister a node without owned enabled state');
  });

  it('does not deregister a limb when persisted disable state fails to write', async () => {
    const root = mkdtempSync(join(os.tmpdir(), 'plugin-limb-activator-'));
    const pluginsDir = join(root, 'plugins');
    const projectRoot = join(root, 'project');
    const deregistered = [];
    const persisted = {
      version: 1,
      capabilities: [
        {
          id: 'plugin:test-plugin:limbs/node.yaml',
          type: 'limb',
          enabled: true,
          source: 'cat-cafe',
          pluginId: 'test-plugin',
          limbNodeId: 'persisted-node',
        },
      ],
    };
    const before = structuredClone(persisted);
    const activator = new PluginResourceActivator({
      resolveProjectRoot: () => projectRoot,
      pluginsDir,
      limbRegistry: {
        deregister: (nodeId) => {
          deregistered.push(nodeId);
        },
      },
      readCapabilities: async () => structuredClone(persisted),
      writeCapabilities: async () => {
        throw new Error('disk write failed');
      },
      withCapabilityLock: async (fn) => fn(),
    });

    const result = await activator.disablePlugin({
      id: 'test-plugin',
      name: 'Test Plugin',
      version: '1.0.0',
      builtin: false,
      config: [],
      resources: [{ type: 'limb', path: 'limbs/node.yaml' }],
    });

    assert.equal(result.status, 'failed');
    assert.match(result.resources[0].error, /disk write failed/);
    assert.deepEqual(deregistered, [], 'runtime node must stay registered if persisted disable state fails');
    assert.deepEqual(persisted, before);
  });

  it('preserves concurrent capability updates during limb rollback', async () => {
    const root = mkdtempSync(join(os.tmpdir(), 'plugin-limb-concurrent-'));
    const pluginsDir = join(root, 'plugins');
    const projectRoot = join(root, 'project');
    mkdirSync(join(pluginsDir, 'plugin-a', 'limbs'), { recursive: true });
    writeFileSync(
      join(pluginsDir, 'plugin-a', 'limbs', 'node.yaml'),
      ['nodeId: node-a', 'displayName: A', 'platform: test', 'capabilities: []'].join('\n'),
    );

    const concurrentEntry = {
      id: 'plugin:plugin-b:skill',
      type: 'skill',
      enabled: true,
      source: 'cat-cafe',
      pluginId: 'plugin-b',
    };
    let persisted = { version: 1, capabilities: [] };

    const activator = new PluginResourceActivator({
      resolveProjectRoot: () => projectRoot,
      pluginsDir,
      limbRegistry: {
        register: async () => {
          persisted.capabilities.push(structuredClone(concurrentEntry));
          throw new Error('register failed');
        },
      },
      readCapabilities: async () => structuredClone(persisted),
      writeCapabilities: async (config) => {
        persisted = structuredClone(config);
      },
      withCapabilityLock: async (fn) => fn(),
      limbAdapterFactory: async () => testLimbNode('node-a'),
    });

    const result = await activator.enablePlugin({
      id: 'plugin-a',
      name: 'Plugin A',
      version: '1.0.0',
      builtin: false,
      config: [],
      resources: [{ type: 'limb', path: 'limbs/node.yaml' }],
    });

    assert.equal(result.status, 'failed');
    const bEntry = persisted.capabilities.find((c) => c.pluginId === 'plugin-b');
    assert.ok(bEntry, 'concurrent capability update from plugin-b must survive rollback');
    const aEntry = persisted.capabilities.find((c) => c.pluginId === 'plugin-a');
    assert.equal(aEntry, undefined, 'failed plugin-a entry must be removed by rollback');
  });
});

describe('PluginResourceActivator limb startup safety', () => {
  it('normalizes Windows-style limb paths during startup rehydration', async () => {
    const root = mkdtempSync(join(os.tmpdir(), 'plugin-rehydrate-root-'));
    const pluginsDir = join(root, 'plugins');
    const expectedYamlPath = join(pluginsDir, 'test-plugin', 'limbs', 'node.yaml');
    mkdirSync(join(pluginsDir, 'test-plugin', 'limbs'), { recursive: true });
    writeFileSync(expectedYamlPath, 'nodeId: yaml-node\n');
    const seenYamlPaths = [];
    const registeredNodes = [];

    await rehydrateEnabledPluginLimbs({
      capabilities: {
        version: 1,
        capabilities: [
          {
            id: 'plugin:test-plugin:limbs\\node.yaml',
            type: 'limb',
            enabled: true,
            source: 'cat-cafe',
            pluginId: 'test-plugin',
            limbNodeId: 'persisted-node',
          },
        ],
      },
      pluginRegistry: {
        getManifest(pluginId) {
          return pluginId === 'test-plugin'
            ? {
                id: 'test-plugin',
                name: 'Test Plugin',
                version: '1.0.0',
                builtin: false,
                config: [],
                resources: [{ type: 'limb', path: 'limbs\\node.yaml' }],
              }
            : undefined;
        },
      },
      pluginsDir,
      limbAdapterRegistry: new Map([
        [
          'test-plugin',
          async (yamlPath) => {
            seenYamlPaths.push(yamlPath);
            return {
              nodeId: 'yaml-node',
              displayName: 'YAML Node',
              platform: 'test',
              capabilities: [],
              register: async () => {},
              invoke: async () => ({ ok: true }),
              healthCheck: async () => 'online',
              deregister: async () => {},
            };
          },
        ],
      ]),
      limbRegistry: {
        async register(node) {
          registeredNodes.push(node);
        },
      },
      log: { info: () => {}, warn: () => {} },
    });

    assert.deepEqual(seenYamlPaths, [expectedYamlPath]);
    assert.equal(registeredNodes[0].nodeId, 'persisted-node');
  });

  it('registers rehydrated limb nodes under the persisted node id without cloning class instances', async () => {
    class ClassBasedLimbNode {
      #status = 'online';

      constructor(nodeId) {
        this.nodeId = nodeId;
        this.displayName = 'YAML Node';
        this.platform = 'test';
        this.capabilities = [];
      }

      async register() {}

      async invoke() {
        return { ok: this.#status === 'online' };
      }

      async healthCheck() {
        return this.#status;
      }

      async deregister() {}
    }

    const node = new ClassBasedLimbNode('yaml-node');

    const rehydrated = withPersistedLimbNodeId(node, 'persisted-node');

    assert.equal(await rehydrated.healthCheck(), 'online');
    assert.equal((await rehydrated.invoke()).ok, true);
    assert.equal(rehydrated.nodeId, 'persisted-node');
    assert.equal(node.nodeId, 'persisted-node');
    assert.equal(rehydrated, node);
  });
});

describe('plugin routes safety', () => {
  function createRouteDeps(manifestOverrides = {}) {
    const manifest = {
      id: 'test-plugin',
      name: 'Test Plugin',
      version: '1.0.0',
      builtin: false,
      config: [],
      resources: [],
      ...manifestOverrides,
    };
    let scanCount = 0;
    const pluginRegistry = {
      scan() {
        scanCount += 1;
        return [manifest];
      },
      get scanCount() {
        return scanCount;
      },
      getAllManifests() {
        return [manifest];
      },
      getManifest(id) {
        return id === manifest.id ? manifest : undefined;
      },
      getPluginInfo(m) {
        return { id: m.id, name: m.name, version: m.version, status: 'configured', configured: true, resources: [] };
      },
    };
    const pluginActivator = {
      enablePlugin: async () => ({ status: 'success', resources: [] }),
      disablePlugin: async () => ({ status: 'success', resources: [] }),
      syncPluginEnv: async () => {},
    };
    return { manifest, pluginRegistry, pluginActivator };
  }

  it('refreshes plugin registry before serving plugin list', async () => {
    const app = Fastify();
    app.addHook('preHandler', async (request) => {
      const raw = request.headers['x-test-session-user'];
      if (typeof raw === 'string' && raw.trim()) request.sessionUserId = raw.trim();
    });
    const deps = createRouteDeps();
    registerPluginRoutes(app, {
      pluginRegistry: deps.pluginRegistry,
      pluginActivator: deps.pluginActivator,
      limbRegistry: {},
      pluginsDir: '/tmp/plugins',
    });
    await app.ready();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/plugins',
        headers: { 'x-test-session-user': 'viewer-user' },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(deps.pluginRegistry.scanCount, 1);
    } finally {
      await app.close();
    }
  });

  it('rejects plugin reads without a session identity', async () => {
    const app = Fastify();
    app.addHook('preHandler', async (request) => {
      const raw = request.headers['x-test-session-user'];
      if (typeof raw === 'string' && raw.trim()) request.sessionUserId = raw.trim();
    });
    const deps = createRouteDeps();
    registerPluginRoutes(app, {
      pluginRegistry: deps.pluginRegistry,
      pluginActivator: deps.pluginActivator,
      limbRegistry: {},
      pluginsDir: '/tmp/plugins',
    });
    await app.ready();
    try {
      const listRes = await app.inject({
        method: 'GET',
        url: '/api/plugins',
        headers: { 'x-cat-cafe-user': 'spoofed-user' },
      });
      assert.equal(listRes.statusCode, 401);
      assert.match(listRes.payload, /session/);

      const detailRes = await app.inject({
        method: 'GET',
        url: '/api/plugins/test-plugin',
        headers: { 'x-cat-cafe-user': 'spoofed-user' },
      });
      assert.equal(detailRes.statusCode, 401);
      assert.match(detailRes.payload, /session/);
    } finally {
      await app.close();
    }
  });

  it('rejects plugin writes that only spoof local headers without an owner session', async () => {
    const app = Fastify();
    const deps = createRouteDeps();
    registerPluginRoutes(app, {
      pluginRegistry: deps.pluginRegistry,
      pluginActivator: deps.pluginActivator,
      limbRegistry: {},
      pluginsDir: '/tmp/plugins',
    });
    await app.ready();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/plugins/test-plugin/enable',
        headers: { host: 'localhost:3004', origin: 'http://localhost:5173', 'x-cat-cafe-user': 'owner-user' },
        remoteAddress: '127.0.0.1',
      });
      assert.equal(res.statusCode, 401);
      assert.match(res.payload, /owner session/);
    } finally {
      await app.close();
    }
  });

  it('accepts plugin writes from the configured owner session', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'owner-user';
    const app = Fastify();
    app.addHook('preHandler', async (request) => {
      const raw = request.headers['x-test-session-user'];
      if (typeof raw === 'string' && raw.trim()) request.sessionUserId = raw.trim();
    });
    const deps = createRouteDeps();
    registerPluginRoutes(app, {
      pluginRegistry: deps.pluginRegistry,
      pluginActivator: deps.pluginActivator,
      limbRegistry: {},
      pluginsDir: '/tmp/plugins',
    });
    await app.ready();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/plugins/test-plugin/enable',
        headers: {
          host: 'localhost:3004',
          origin: 'http://localhost:5173',
          'x-test-session-user': 'owner-user',
        },
        remoteAddress: '127.0.0.1',
      });
      assert.equal(res.statusCode, 200, res.payload);
    } finally {
      await app.close();
      if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
    }
  });

  it('rejects plugin writes from non-loopback clients even with an owner session', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'owner-user';
    const app = Fastify();
    app.addHook('preHandler', async (request) => {
      const raw = request.headers['x-test-session-user'];
      if (typeof raw === 'string' && raw.trim()) request.sessionUserId = raw.trim();
    });
    const deps = createRouteDeps();
    registerPluginRoutes(app, {
      pluginRegistry: deps.pluginRegistry,
      pluginActivator: deps.pluginActivator,
      limbRegistry: {},
      pluginsDir: '/tmp/plugins',
    });
    await app.ready();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/plugins/test-plugin/enable',
        headers: {
          host: 'localhost:3004',
          origin: 'http://localhost:5173',
          'x-test-session-user': 'owner-user',
        },
        remoteAddress: '203.0.113.10',
      });
      assert.equal(res.statusCode, 403);
      assert.match(res.payload, /direct localhost Hub access/);
    } finally {
      await app.close();
      if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
    }
  });

  it('rejects plugin writes forwarded through a local proxy even with an owner session', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'owner-user';
    const app = Fastify();
    app.addHook('preHandler', async (request) => {
      const raw = request.headers['x-test-session-user'];
      if (typeof raw === 'string' && raw.trim()) request.sessionUserId = raw.trim();
    });
    const deps = createRouteDeps();
    registerPluginRoutes(app, {
      pluginRegistry: deps.pluginRegistry,
      pluginActivator: deps.pluginActivator,
      limbRegistry: {},
      pluginsDir: '/tmp/plugins',
    });
    await app.ready();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/plugins/test-plugin/enable',
        headers: {
          host: 'localhost:3004',
          origin: 'http://localhost:5173',
          'x-forwarded-for': '203.0.113.10',
          'x-test-session-user': 'owner-user',
        },
        remoteAddress: '127.0.0.1',
      });
      assert.equal(res.statusCode, 403);
      assert.match(res.payload, /direct localhost Hub access/);
    } finally {
      await app.close();
      if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
    }
  });

  it('resolves Windows-style limb resource paths before loading health-check YAML', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    const previousConfigRoot = process.env.CAT_CAFE_CONFIG_ROOT;
    process.env.DEFAULT_OWNER_USER_ID = 'owner-user';
    const root = mkdtempSync(join(os.tmpdir(), 'plugin-route-health-'));
    const projectRoot = join(root, 'project');
    const pluginsDir = join(root, 'plugins');
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(join(pluginsDir, 'test-plugin', 'limbs'), { recursive: true });
    process.env.CAT_CAFE_CONFIG_ROOT = projectRoot;
    writeFileSync(
      join(pluginsDir, 'test-plugin', 'limbs', 'node.yaml'),
      [
        'nodeId: yaml-node',
        'displayName: YAML Node',
        'platform: test',
        'capabilities:',
        '  - cap: health',
        '    commands: [check_status]',
        '    authLevel: free',
      ].join('\n'),
    );
    const app = Fastify();
    app.addHook('preHandler', async (request) => {
      const raw = request.headers['x-test-session-user'];
      if (typeof raw === 'string' && raw.trim()) request.sessionUserId = raw.trim();
    });
    const deps = createRouteDeps({
      healthCheck: { limbCommand: 'check_status' },
      resources: [{ type: 'limb', path: 'limbs\\node.yaml' }],
    });
    registerPluginRoutes(app, {
      pluginRegistry: deps.pluginRegistry,
      pluginActivator: deps.pluginActivator,
      limbRegistry: {
        getNodeHandle(nodeId) {
          if (nodeId !== 'yaml-node') return null;
          return { healthCheck: async () => 'online' };
        },
      },
      pluginsDir,
    });
    await app.ready();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/plugins/test-plugin/test',
        headers: {
          host: 'localhost:3004',
          origin: 'http://localhost:5173',
          'x-test-session-user': 'owner-user',
        },
        remoteAddress: '127.0.0.1',
      });
      assert.equal(res.statusCode, 200, res.payload);
      assert.deepEqual(JSON.parse(res.payload), { ok: true, status: 'online' });
    } finally {
      await app.close();
      if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
      if (previousConfigRoot === undefined) delete process.env.CAT_CAFE_CONFIG_ROOT;
      else process.env.CAT_CAFE_CONFIG_ROOT = previousConfigRoot;
    }
  });

  it('looks up health-check limb handles by persisted limb node id before YAML node id', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    const previousConfigRoot = process.env.CAT_CAFE_CONFIG_ROOT;
    process.env.DEFAULT_OWNER_USER_ID = 'owner-user';
    const root = mkdtempSync(join(os.tmpdir(), 'plugin-route-health-'));
    const projectRoot = join(root, 'project');
    const pluginsDir = join(root, 'plugins');
    mkdirSync(join(projectRoot, '.cat-cafe'), { recursive: true });
    mkdirSync(join(pluginsDir, 'test-plugin', 'limbs'), { recursive: true });
    process.env.CAT_CAFE_CONFIG_ROOT = projectRoot;
    writeFileSync(
      join(pluginsDir, 'test-plugin', 'limbs', 'node.yaml'),
      [
        'nodeId: yaml-node',
        'displayName: YAML Node',
        'platform: test',
        'capabilities:',
        '  - cap: health',
        '    commands: [check_status]',
        '    authLevel: free',
      ].join('\n'),
    );
    writeFileSync(
      join(projectRoot, '.cat-cafe', 'capabilities.json'),
      `${JSON.stringify(
        {
          version: 1,
          capabilities: [
            {
              id: 'plugin:test-plugin:limbs/node.yaml',
              type: 'limb',
              enabled: true,
              source: 'cat-cafe',
              pluginId: 'test-plugin',
              limbNodeId: 'persisted-node',
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    const app = Fastify();
    app.addHook('preHandler', async (request) => {
      const raw = request.headers['x-test-session-user'];
      if (typeof raw === 'string' && raw.trim()) request.sessionUserId = raw.trim();
    });
    const deps = createRouteDeps({
      healthCheck: { limbCommand: 'check_status' },
      resources: [{ type: 'limb', path: 'limbs/node.yaml' }],
    });
    registerPluginRoutes(app, {
      pluginRegistry: deps.pluginRegistry,
      pluginActivator: deps.pluginActivator,
      limbRegistry: {
        getNodeHandle(nodeId) {
          if (nodeId !== 'persisted-node') return null;
          return { healthCheck: async () => 'online' };
        },
      },
      pluginsDir,
    });
    await app.ready();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/plugins/test-plugin/test',
        headers: {
          host: 'localhost:3004',
          origin: 'http://localhost:5173',
          'x-test-session-user': 'owner-user',
        },
        remoteAddress: '127.0.0.1',
      });
      assert.equal(res.statusCode, 200, res.payload);
      assert.deepEqual(JSON.parse(res.payload), { ok: true, status: 'online' });
    } finally {
      await app.close();
      if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
      if (previousConfigRoot === undefined) delete process.env.CAT_CAFE_CONFIG_ROOT;
      else process.env.CAT_CAFE_CONFIG_ROOT = previousConfigRoot;
    }
  });

  it('returns structured failure when limb health-check throws', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    const previousConfigRoot = process.env.CAT_CAFE_CONFIG_ROOT;
    process.env.DEFAULT_OWNER_USER_ID = 'owner-user';
    const root = mkdtempSync(join(os.tmpdir(), 'plugin-route-health-'));
    const projectRoot = join(root, 'project');
    const pluginsDir = join(root, 'plugins');
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(join(pluginsDir, 'test-plugin', 'limbs'), { recursive: true });
    process.env.CAT_CAFE_CONFIG_ROOT = projectRoot;
    writeFileSync(
      join(pluginsDir, 'test-plugin', 'limbs', 'node.yaml'),
      [
        'nodeId: yaml-node',
        'displayName: YAML Node',
        'platform: test',
        'capabilities:',
        '  - cap: health',
        '    commands: [check_status]',
        '    authLevel: free',
      ].join('\n'),
    );
    const app = Fastify();
    app.addHook('preHandler', async (request) => {
      const raw = request.headers['x-test-session-user'];
      if (typeof raw === 'string' && raw.trim()) request.sessionUserId = raw.trim();
    });
    const deps = createRouteDeps({
      healthCheck: { limbCommand: 'check_status' },
      resources: [{ type: 'limb', path: 'limbs/node.yaml' }],
    });
    registerPluginRoutes(app, {
      pluginRegistry: deps.pluginRegistry,
      pluginActivator: deps.pluginActivator,
      limbRegistry: {
        getNodeHandle(nodeId) {
          if (nodeId !== 'yaml-node') return null;
          return {
            healthCheck: async () => {
              throw new Error('adapter timeout');
            },
          };
        },
      },
      pluginsDir,
    });
    await app.ready();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/plugins/test-plugin/test',
        headers: {
          host: 'localhost:3004',
          origin: 'http://localhost:5173',
          'x-test-session-user': 'owner-user',
        },
        remoteAddress: '127.0.0.1',
      });
      assert.equal(res.statusCode, 200, res.payload);
      assert.deepEqual(JSON.parse(res.payload), {
        ok: false,
        status: 'error',
        error: 'adapter timeout',
      });
    } finally {
      await app.close();
      if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
      if (previousConfigRoot === undefined) delete process.env.CAT_CAFE_CONFIG_ROOT;
      else process.env.CAT_CAFE_CONFIG_ROOT = previousConfigRoot;
    }
  });
});

describe('BUILTIN_PLUGIN_IDS', () => {
  it('is empty — all plugins are scanned from plugins/ dir', () => {
    assert.equal(BUILTIN_PLUGIN_IDS.size, 0);
    assert.ok(!BUILTIN_PLUGIN_IDS.has('github'));
  });
});
