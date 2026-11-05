import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { prepareOpenCodeAcpSpawnConfig } from '../src/domains/cats/services/agents/providers/opencode-acp-spawn-config.js';
import {
  writeOpenCodeInstructionsOnlyConfig,
  writeOpenCodeRuntimeConfig,
} from '../src/domains/cats/services/agents/providers/opencode-config-writer.js';
import { withOpenCodeSecretGuard } from '../src/domains/cats/services/agents/providers/opencode-secret-config.js';

test('both OpenCode config owners install native shell checks and leave MCP direct after project merge', async () => {
  const root = await mkdtemp(join(tmpdir(), 'secret-opencode-'));
  try {
    await mkdir(join(root, '.cat-cafe'));
    await writeFile(join(root, '.cat-cafe/capabilities.json'), '{"version":2,"capabilities":[]}');
    await writeFile(
      join(root, 'opencode.json'),
      JSON.stringify({
        mcp: {
          external: { type: 'local', command: ['node', '/fixture/browser.js'], environment: { FIXTURE: 'kept' } },
          disabled: { type: 'remote', url: 'https://example.invalid/mcp', enabled: false },
        },
      }),
    );
    const full = JSON.parse(
      await readFile(
        await writeOpenCodeRuntimeConfig(
          root,
          'opencode',
          'full',
          {
            providerName: 'fixture',
            models: ['fixture'],
            capabilitiesProjectRoot: root,
          },
          root,
        ),
        'utf8',
      ),
    );
    const fallback = JSON.parse(
      await readFile(writeOpenCodeInstructionsOnlyConfig(root, 'opencode', 'fallback', ['fixture.md']), 'utf8'),
    );
    for (const config of [full, fallback])
      assert.ok(config.plugin.some((path: string) => new URL(path).pathname.endsWith('/secret-opencode-plugin.mjs')));
    const external = full.mcp.external;
    assert.deepEqual(external.command, ['node', '/fixture/browser.js']);
    assert.equal(external.environment.FIXTURE, 'kept');
    assert.equal(full.mcp.disabled.enabled, false);
    assert.equal(fallback.provider, undefined, 'native subscription auth stays in its original owner');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('OpenCode ACP keeps the guard for unresolved native model/account configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'secret-opencode-native-'));
  try {
    const prepared = await prepareOpenCodeAcpSpawnConfig({
      projectRoot: root,
      profileId: 'native-opencode',
      clientId: 'opencode',
      defaultModel: 'native-unresolved-model',
      account: { id: 'owner-native', authType: 'oauth' },
    });
    assert.ok(prepared);
    const config = JSON.parse(await readFile(prepared.configPath, 'utf8'));
    assert.ok(config.plugin.some((path: string) => path.endsWith('/secret-opencode-plugin.mjs')));
    assert.equal(config.provider, undefined);
    assert.equal(config.model, undefined);
    assert.equal(prepared.env.CAT_CAFE_GUARD_NODE, process.execPath);
    assert.deepEqual(prepared.runtimeConfigSummary.providerKeys, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('OpenCode keeps native OAuth while explicit static remote transports use guarded HTTP/SSE negotiation', () => {
  const native = { type: 'remote', url: 'https://example.invalid/oauth' };
  const config = withOpenCodeSecretGuard({
    mcp: {
      native,
      static: {
        type: 'remote',
        url: 'https://example.invalid/mcp',
        oauth: false,
        headers: { Authorization: 'fixture-transport-owned' },
      },
    },
  });
  assert.equal(config.mcp.native, native);
  assert.deepEqual(config.mcp.static, {
    type: 'remote',
    url: 'https://example.invalid/mcp',
    oauth: false,
    headers: { Authorization: 'fixture-transport-owned' },
  });
});
