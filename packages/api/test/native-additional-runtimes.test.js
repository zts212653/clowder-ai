import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { discoverAdditionalRuntimes } from '../dist/routes/native-additional-runtimes.js';

test('detects Kimi and bridged Pi without disclosing authentication or probing OpenCode', () => {
  const root = mkdtempSync(join(tmpdir(), 'additional-runtime-'));
  const keys = ['KIMI_CODE_HOME', 'KIMI_SHARE_DIR', 'KIMI_CONFIG_FILE', 'PI_CODING_AGENT_DIR'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  try {
    mkdirSync(join(root, '.kimi-code'), { recursive: true });
    writeFileSync(
      join(root, '.kimi-code/config.toml'),
      'default_model="kimi-code/k3"\n[models."kimi-code/k3"]\nprovider="native"\n[providers.native]\napi_key="sensitive-sentinel"\n',
    );
    const bridge = join(root, 'pi-acp-bridge.js');
    writeFileSync(bridge, '// owned bundled adapter');
    const command = (name) => (name === 'pi-acp' ? null : join(root, `${name}.cmd`));
    const found = discoverAdditionalRuntimes(root, command, { piBridgeEntry: bridge });
    assert.deepEqual(
      found.map((r) => r.id),
      ['kimi', 'pi'],
    );
    assert.deepEqual(
      found.slice(0, 1).map((r) => r.configuredModel),
      ['kimi-code/k3'],
    );
    assert.equal(found[1].installed, true);
    assert.equal(found[1].discoveryStatus, 'configured');
    assert.equal(found[1].acp.command, process.execPath);
    assert.doesNotMatch(JSON.stringify(found), /sensitive-sentinel|api_key/);
    // Current kimi-code migrates to ~/.kimi-code; the old ~/.kimi may still exist.
    writeFileSync(join(root, '.kimi-code/config.toml'), 'default_model="native-current-model"\n');
    const modernOnly = (name) => (name === 'kimi-cli' ? null : command(name));
    assert.equal(discoverAdditionalRuntimes(root, modernOnly)[0].configuredModel, 'native-current-model');
    const bridged = discoverAdditionalRuntimes(root, (name) => join(root, `${name}.cmd`));
    assert.deepEqual(bridged[1].acp, { command: join(root, 'pi-acp.cmd'), startupArgs: [], transport: 'stdio' });
  } finally {
    for (const [key, value] of Object.entries(previous))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    rmSync(root, { recursive: true, force: true });
  }
});
