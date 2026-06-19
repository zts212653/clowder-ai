import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  installPlugin,
  listInstalledPlugins,
  resolvePluginsDir,
  uninstallPlugin,
} from '../dist/infrastructure/connectors/plugins/plugin-installer.js';

const TEST_ROOT = '/tmp/cat-cafe-plugin-installer-test';
const BUILTIN_IDS = new Set(['feishu', 'dingtalk', 'telegram', 'weixin', 'wecom-bot', 'wecom-agent', 'xiaoyi']);

/** Convert connector id to valid env var prefix (replace hyphens with underscores). */
function envPrefix(id) {
  return id.toUpperCase().replace(/-/g, '_');
}

function cleanup() {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
}

async function waitForFile(path, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${path}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Create a minimal valid plugin tar.gz for testing. */
function createTestPlugin(id, { name, missingYaml, missingEntry, extraFiles } = {}) {
  const tmpDir = join(TEST_ROOT, '.tmp-create');
  const pluginDir = join(tmpDir, id);
  mkdirSync(pluginDir, { recursive: true });

  if (!missingYaml) {
    writeFileSync(
      join(pluginDir, 'connector.yaml'),
      `id: ${id}\nname: ${name ?? id}\ndocs_url: https://example.com\nconfig:\n  - envName: ${envPrefix(id)}_TOKEN\n    label: Token\n    sensitive: true\nsteps:\n  - text: Step 1\n  - text: Step 2\n  - text: Step 3\n`,
    );
  }

  if (!missingEntry) {
    writeFileSync(
      join(pluginDir, 'index.js'),
      `export default {\n  id: '${id}',\n  definition: { id: '${id}', name: '${name ?? id}', icon: '${id}' },\n  requiredEnvKeys: ['${envPrefix(id)}_TOKEN'],\n  isConfigured: (env) => !!env['${envPrefix(id)}_TOKEN'],\n  createAdapter: () => ({}),\n};\n`,
    );
  }

  if (extraFiles) {
    for (const [path, content] of Object.entries(extraFiles)) {
      const filePath = join(pluginDir, path);
      mkdirSync(join(filePath, '..'), { recursive: true });
      writeFileSync(filePath, content);
    }
  }

  const archivePath = join(TEST_ROOT, `${id}.tar.gz`);
  execSync(`tar czf ${archivePath} -C ${tmpDir} ${id}`);
  rmSync(tmpDir, { recursive: true });
  return archivePath;
}

beforeEach(() => {
  cleanup();
  mkdirSync(TEST_ROOT, { recursive: true });
});

afterEach(() => {
  cleanup();
});

describe('installPlugin', { concurrency: false }, () => {
  it('installs a valid plugin to .cat-cafe/plugins/<id>/', async () => {
    const archive = createTestPlugin('my-chat');
    const result = await installPlugin(TEST_ROOT, archive, BUILTIN_IDS);

    assert.equal(result.id, 'my-chat');
    assert.equal(result.action, 'installed');
    assert.ok(existsSync(join(resolvePluginsDir(TEST_ROOT), 'my-chat', 'connector.yaml')));
    assert.ok(existsSync(join(resolvePluginsDir(TEST_ROOT), 'my-chat', 'index.js')));
  });

  it('rejects archive without connector.yaml', async () => {
    const archive = createTestPlugin('no-yaml', { missingYaml: true });
    const result = await installPlugin(TEST_ROOT, archive, BUILTIN_IDS);

    assert.equal(result.code, 'MISSING_MANIFEST');
  });

  it('rejects archive without index.js', async () => {
    const archive = createTestPlugin('no-entry', { missingEntry: true });
    const result = await installPlugin(TEST_ROOT, archive, BUILTIN_IDS);

    assert.equal(result.code, 'MISSING_ENTRY');
  });

  it('rejects plugin whose ID conflicts with a built-in connector', async () => {
    const archive = createTestPlugin('feishu');
    const result = await installPlugin(TEST_ROOT, archive, BUILTIN_IDS);

    assert.equal(result.code, 'ID_CONFLICT');
    assert.ok(result.message.includes('feishu'));
  });

  it('rejects symlinked connector.yaml before rewriting the manifest', async () => {
    const victimPath = join(TEST_ROOT, 'victim-connector.yaml');
    const victimContent =
      'id: feishu\nname: Feishu\ndocs_url: https://example.com\nconfig: []\nsteps:\n  - text: Step\n  - text: Step\n  - text: Step\n';
    writeFileSync(victimPath, victimContent);

    const tmpDir = join(TEST_ROOT, '.tmp-symlink');
    const pluginDir = join(tmpDir, 'symlink-manifest');
    mkdirSync(pluginDir, { recursive: true });
    symlinkSync(victimPath, join(pluginDir, 'connector.yaml'));
    writeFileSync(
      join(pluginDir, 'index.js'),
      "export default { id: 'symlink-manifest', definition: {}, requiredEnvKeys: [], isConfigured: () => false, createAdapter: () => ({}) };",
    );

    const archivePath = join(TEST_ROOT, 'symlink-manifest.tar.gz');
    execSync(`tar czf ${archivePath} -C ${tmpDir} symlink-manifest`);
    rmSync(tmpDir, { recursive: true });

    const result = await installPlugin(TEST_ROOT, archivePath, BUILTIN_IDS);
    assert.equal(result.code, 'INVALID_ARCHIVE');
    assert.match(result.message, /symlink/i);
    assert.equal(readFileSync(victimPath, 'utf8'), victimContent, 'external symlink target must not be rewritten');
  });

  it('rejects symlinked index.js before installing the plugin entrypoint', async () => {
    const entryTarget = join(TEST_ROOT, 'external-entry.js');
    writeFileSync(entryTarget, "export default { id: 'external-entry' };\n");

    const tmpDir = join(TEST_ROOT, '.tmp-symlink-entry');
    const pluginDir = join(tmpDir, 'symlink-entry');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'connector.yaml'),
      'id: symlink-entry\nname: Symlink Entry\ndocs_url: https://example.com\nconfig:\n  - envName: SYMLINK_ENTRY_TOKEN\n    label: Token\n    sensitive: true\nsteps:\n  - text: Step\n  - text: Step\n  - text: Step\n',
    );
    symlinkSync(entryTarget, join(pluginDir, 'index.js'));

    const archivePath = join(TEST_ROOT, 'symlink-entry.tar.gz');
    execSync(`tar czf ${archivePath} -C ${tmpDir} symlink-entry`);
    rmSync(tmpDir, { recursive: true });

    const result = await installPlugin(TEST_ROOT, archivePath, BUILTIN_IDS);
    assert.equal(result.code, 'INVALID_ARCHIVE');
    assert.match(result.message, /symlink/i);
    assert.equal(
      existsSync(join(resolvePluginsDir(TEST_ROOT), 'symlink-entry')),
      false,
      'symlinked entrypoint archive must not be installed',
    );
  });

  it('rejects extracted plugin archives containing symlinked asset files', async () => {
    const assetTarget = join(TEST_ROOT, 'external-icon.png');
    writeFileSync(assetTarget, 'private-icon');

    const tmpDir = join(TEST_ROOT, '.tmp-symlink-asset');
    const pluginDir = join(tmpDir, 'symlink-asset');
    mkdirSync(join(pluginDir, 'assets'), { recursive: true });
    writeFileSync(
      join(pluginDir, 'connector.yaml'),
      'id: symlink-asset\nname: Symlink Asset\ndocs_url: https://example.com\nconfig:\n  - envName: SYMLINK_ASSET_TOKEN\n    label: Token\n    sensitive: true\nsteps:\n  - text: Step\n  - text: Step\n  - text: Step\n',
    );
    writeFileSync(
      join(pluginDir, 'index.js'),
      "export default { id: 'symlink-asset', definition: {}, requiredEnvKeys: [], isConfigured: () => false, createAdapter: () => ({}) };",
    );
    symlinkSync(assetTarget, join(pluginDir, 'assets', 'icon.png'));

    const archivePath = join(TEST_ROOT, 'symlink-asset.tar.gz');
    execSync(`tar czf ${archivePath} -C ${tmpDir} symlink-asset`);
    rmSync(tmpDir, { recursive: true });

    const result = await installPlugin(TEST_ROOT, archivePath, BUILTIN_IDS);
    assert.equal(result.code, 'INVALID_ARCHIVE');
    assert.match(result.message, /symlink/i);
    assert.equal(
      existsSync(join(resolvePluginsDir(TEST_ROOT), 'symlink-asset')),
      false,
      'plugin archives with symlinked assets must not be installed',
    );
  });

  it('updates an existing plugin (replaces files, preserves config)', async () => {
    // Install v1
    const v1 = createTestPlugin('my-chat', { name: 'My Chat v1' });
    await installPlugin(TEST_ROOT, v1, BUILTIN_IDS);

    // Write config (simulates user configuration)
    const configDir = join(TEST_ROOT, '.cat-cafe', 'im-connector-config');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'my-chat.json'), '{"MY_CHAT_TOKEN":"secret"}');

    // Install v2 (update)
    const v2 = createTestPlugin('my-chat', { name: 'My Chat v2' });
    const result = await installPlugin(TEST_ROOT, v2, BUILTIN_IDS);

    assert.equal(result.action, 'updated');
    assert.equal(result.name, 'My Chat v2'); // manifest name field from YAML

    // Config preserved
    assert.ok(existsSync(join(configDir, 'my-chat.json')), 'config must survive update');
  });

  it('rejects plugin with path-traversal ID (install)', async () => {
    // Create an archive whose connector.yaml has a malicious ID
    const tmpDir = join(TEST_ROOT, '.tmp-traversal');
    const pluginDir = join(tmpDir, 'evil');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'connector.yaml'),
      'id: ../../etc\nname: Evil\ndocs_url: https://x.com\nconfig:\n  - envName: EVIL_TOKEN\n    label: Token\n    sensitive: true\nsteps:\n  - text: Step\n  - text: Step\n  - text: Step\n',
    );
    writeFileSync(
      join(pluginDir, 'index.js'),
      'export default { id: "../../etc", definition: {}, requiredEnvKeys: [], isConfigured: () => false, createAdapter: () => ({}) };',
    );
    const archivePath = join(TEST_ROOT, 'evil.tar.gz');
    execSync(`tar czf ${archivePath} -C ${tmpDir} evil`);
    rmSync(tmpDir, { recursive: true });

    const result = await installPlugin(TEST_ROOT, archivePath, BUILTIN_IDS);
    assert.equal(result.code, 'INVALID_ARCHIVE');
    assert.ok(result.message.includes('Invalid connector ID'));
  });

  it('preserves assets directory in installed plugin', async () => {
    const archive = createTestPlugin('with-assets', {
      extraFiles: { 'assets/icon.png': 'fake-png-data' },
    });
    const result = await installPlugin(TEST_ROOT, archive, BUILTIN_IDS);

    assert.equal(result.id, 'with-assets');
    assert.ok(existsSync(join(resolvePluginsDir(TEST_ROOT), 'with-assets', 'assets', 'icon.png')));
  });

  it('keeps concurrent install extractions isolated per request', async () => {
    const archiveA = createTestPlugin('race-a');
    const archiveB = createTestPlugin('race-b');
    const fakeBin = join(TEST_ROOT, 'fake-bin');
    const controlDir = join(TEST_ROOT, 'tar-control');
    const fakeTar = join(fakeBin, 'tar');
    mkdirSync(fakeBin, { recursive: true });
    mkdirSync(controlDir, { recursive: true });
    writeFileSync(
      fakeTar,
      `#!/bin/sh
set -eu
archive="$2"
dest="$4"
base="$(basename "$archive")"
id="\${base%.tar.gz}"
env_name="$(printf '%s' "$id" | tr '[:lower:]-' '[:upper:]_')_TOKEN"
mkdir -p "$dest/$id"
cat > "$dest/$id/connector.yaml" <<YAML
id: $id
name: $id
docs_url: https://example.com
config:
  - envName: $env_name
    label: Token
    sensitive: true
steps:
  - text: Step 1
  - text: Step 2
  - text: Step 3
YAML
cat > "$dest/$id/index.js" <<JS
export default {
  id: '$id',
  definition: { id: '$id', name: '$id', icon: '$id' },
  requiredEnvKeys: ['$env_name'],
  isConfigured: (env) => !!env['$env_name'],
  createAdapter: () => ({}),
};
JS
touch "${controlDir}/$id-started"
while [ ! -e "${controlDir}/$id-release" ]; do
  sleep 0.01
done
`,
    );
    chmodSync(fakeTar, 0o755);

    const originalPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${originalPath ?? ''}`;
    try {
      const first = installPlugin(TEST_ROOT, archiveA, BUILTIN_IDS);
      await waitForFile(join(controlDir, 'race-a-started'));

      const second = installPlugin(TEST_ROOT, archiveB, BUILTIN_IDS);
      await waitForFile(join(controlDir, 'race-b-started'));

      writeFileSync(join(controlDir, 'race-a-release'), '');
      await new Promise((resolve) => setTimeout(resolve, 100));
      writeFileSync(join(controlDir, 'race-b-release'), '');

      const [resultA, resultB] = await Promise.all([first, second]);
      assert.equal(resultA.id, 'race-a');
      assert.equal(resultB.id, 'race-b');
      assert.ok(existsSync(join(resolvePluginsDir(TEST_ROOT), 'race-a', 'connector.yaml')));
      assert.ok(existsSync(join(resolvePluginsDir(TEST_ROOT), 'race-b', 'connector.yaml')));
    } finally {
      writeFileSync(join(controlDir, 'race-a-release'), '');
      writeFileSync(join(controlDir, 'race-b-release'), '');
      process.env.PATH = originalPath;
    }
  });
});

describe('uninstallPlugin', { concurrency: false }, () => {
  it('removes plugin directory', async () => {
    const archive = createTestPlugin('to-remove');
    await installPlugin(TEST_ROOT, archive, BUILTIN_IDS);

    const result = uninstallPlugin(TEST_ROOT, 'to-remove');
    assert.equal(result.action, 'uninstalled');
    assert.equal(result.configPreserved, true);
    assert.ok(!existsSync(join(resolvePluginsDir(TEST_ROOT), 'to-remove')));
  });

  it('removes cached plugin module copies', async () => {
    const archive = createTestPlugin('remove-cache');
    await installPlugin(TEST_ROOT, archive, BUILTIN_IDS);

    const cacheRoot = join(TEST_ROOT, '.cat-cafe', 'plugin-module-cache', 'remove-cache');
    mkdirSync(join(cacheRoot, 'abc123'), { recursive: true });
    writeFileSync(join(cacheRoot, 'abc123', 'index.js'), 'export default {};');

    const result = uninstallPlugin(TEST_ROOT, 'remove-cache');
    assert.equal(result.action, 'uninstalled');
    assert.ok(!existsSync(cacheRoot), 'module cache subtree must be removed with the plugin');
  });

  it('preserves config by default', async () => {
    const archive = createTestPlugin('keep-config');
    await installPlugin(TEST_ROOT, archive, BUILTIN_IDS);

    const configDir = join(TEST_ROOT, '.cat-cafe', 'im-connector-config');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'keep-config.json'), '{"KEY":"val"}');

    uninstallPlugin(TEST_ROOT, 'keep-config');
    assert.ok(existsSync(join(configDir, 'keep-config.json')), 'config preserved after uninstall');
  });

  it('clears config when clearConfig=true', async () => {
    const archive = createTestPlugin('clear-config');
    await installPlugin(TEST_ROOT, archive, BUILTIN_IDS);

    const configDir = join(TEST_ROOT, '.cat-cafe', 'im-connector-config');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'clear-config.json'), '{"KEY":"val"}');

    uninstallPlugin(TEST_ROOT, 'clear-config', { clearConfig: true });
    assert.ok(!existsSync(join(configDir, 'clear-config.json')), 'config cleared');
  });

  it('returns error for non-existent plugin', () => {
    const result = uninstallPlugin(TEST_ROOT, 'nonexistent');
    assert.equal(result.code, 'INVALID_ARCHIVE');
  });

  it('rejects path-traversal IDs (uninstall)', () => {
    const traversalIds = ['../../etc', '../passwd', 'a/b', '.hidden'];
    for (const id of traversalIds) {
      const result = uninstallPlugin(TEST_ROOT, id);
      assert.equal(result.code, 'INVALID_ARCHIVE', `Expected rejection for ID '${id}'`);
      assert.ok(result.message.includes('Invalid connector ID'), `Expected ID validation message for '${id}'`);
    }
  });
});

describe('listInstalledPlugins', { concurrency: false }, () => {
  it('returns empty array when no plugins installed', () => {
    const result = listInstalledPlugins(TEST_ROOT);
    assert.deepEqual(result, []);
  });

  it('lists installed plugins with metadata', async () => {
    await installPlugin(TEST_ROOT, createTestPlugin('chat-a', { name: 'Chat A' }), BUILTIN_IDS);
    await installPlugin(TEST_ROOT, createTestPlugin('chat-b', { name: 'Chat B' }), BUILTIN_IDS);

    const result = listInstalledPlugins(TEST_ROOT);
    assert.equal(result.length, 2);

    const a = result.find((p) => p.id === 'chat-a');
    assert.ok(a);
    assert.equal(a.hasManifest, true);
    assert.equal(a.hasEntry, true);
  });
});
