import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { prepareKimiMcpConfig } from '../dist/domains/cats/services/agents/providers/kimi-mcp-config.js';
import { nativeLoaders, nativeSchemas } from './helpers/kimi-native-contract.js';
import { kimiNativeFixture, managedCapability } from './helpers/kimi-native-fixture.js';

const transports = {
  stdio: { command: 'never-executed', args: ['--no-spawn'] },
  http: { transport: 'http', url: 'https://example.invalid/mcp' },
  sse: { transport: 'sse', url: 'https://example.invalid/events' },
};

for (const injectionDisabled of [false, true]) {
  test(`member MCP off denies every native layer with injection ${injectionDisabled ? 'disabled' : 'configured'}`, async (t) => {
    const member = catRegistry.getOrThrow('kimi').config;
    const previous = member.mcpSupport;
    t.after(() => {
      if (previous === undefined) delete member.mcpSupport;
      else member.mcpSupport = previous;
    });
    const f = await kimiNativeFixture(t, { capabilities: [managedCapability()] });
    const originals = new Map([
      [join(f.native, 'mcp.json'), { mcpServers: { homeTool: transports.http } }],
      [join(f.project, '.mcp.json'), { mcpServers: { rootTool: transports.stdio } }],
      [join(f.cwd, '.mcp.json'), { mcpServers: { cwdTool: transports.sse } }],
      [f.file, { mcpServers: { originalProjectTool: transports.stdio } }],
    ]);
    for (const [file, value] of originals) {
      await f.put(file, value);
      originals.set(file, await readFile(file));
    }
    member.mcpSupport = false;
    const lease = injectionDisabled
      ? await prepareKimiMcpConfig({
          workingDirectory: f.cwd,
          mcpServerPath: '',
          callbackEnv: { CAT_CAFE_CAT_ID: 'kimi', KIMI_CODE_HOME: f.native },
        })
      : await f.lease();
    try {
      await assertNativeDisabled(f);
    } finally {
      await lease.dispose();
    }
    for (const [file, before] of originals) assert.deepEqual(await readFile(file), before);
    if (!injectionDisabled) {
      member.mcpSupport = true;
      const enabled = await f.lease();
      try {
        for (const load of Object.values(nativeLoaders)) {
          const effective = await load(f.loadInput);
          for (const name of ['cat-cafe-collab', 'rootTool', 'cwdTool']) {
            assert.ok(effective[name] && effective[name].enabled !== false, `${name}: explicit enable must still work`);
          }
          assert.equal(effective.homeTool.enabled, false);
        }
      } finally {
        await enabled.dispose();
      }
    }
  });
}

test('native transport inference ignores foreign type hints on valid HOME entries', async (t) => {
  const f = await kimiNativeFixture(t);
  const mcpServers = {
    httpHint: { type: 'streamable-http', url: 'https://example.invalid/mcp' },
    stdioHint: { type: 'http', command: 'never-executed' },
    explicitTransport: { type: 'stdio', transport: 'sse', url: 'https://example.invalid/events' },
  };
  for (const schema of Object.values(nativeSchemas)) {
    for (const entry of Object.values(mcpServers)) assert.ok(schema.safeParse(entry).success);
  }
  await f.put(join(f.native, 'mcp.json'), { mcpServers });
  const lease = await f.lease();
  try {
    await assertNativeDisabled(f, Object.keys(mcpServers));
  } finally {
    await lease.dispose();
  }
});

async function assertNativeDisabled(f, names) {
  const surface = await f.surface();
  for (const [version, schema] of Object.entries(nativeSchemas)) {
    for (const [name, entry] of Object.entries(surface)) {
      assert.ok(schema.safeParse(entry).success, `${version}: ${name} must pass the actual native schema`);
    }
  }
  for (const [version, load] of Object.entries(nativeLoaders)) {
    const effective = await load(f.loadInput);
    for (const name of names ?? Object.keys(effective)) {
      assert.equal(effective[name]?.enabled, false, `${version}: ${name} must stay disabled`);
    }
  }
}

for (const [transport, entry] of Object.entries(transports)) {
  test(`native HOME ${transport} denial passes both pinned parsers and native loaders`, async (t) => {
    const f = await kimiNativeFixture(t);
    const nativeFile = join(f.native, 'mcp.json');
    await f.put(nativeFile, { mcpServers: { privateTool: entry } });
    const before = await readFile(nativeFile);
    const lease = await f.lease();
    try {
      await assertNativeDisabled(f, ['privateTool']);
    } finally {
      await lease.dispose();
    }
    assert.deepEqual(await readFile(nativeFile), before);
  });
}

for (const nested of [false, true]) {
  for (const empty of [false, true]) {
    for (const [transport, entry] of Object.entries(transports)) {
      test(`Git-root ${transport} MCP cannot bypass ${empty ? 'empty registry' : 'explicit disable'} from ${nested ? 'nested cwd' : 'repo root'}`, async (t) => {
        const f = await kimiNativeFixture(t, {
          nested,
          capabilities: empty ? [] : [managedCapability({ globalEnabled: false })],
        });
        const rootFile = join(f.project, '.mcp.json');
        await f.put(rootFile, { mcpServers: { 'cat-cafe-collab': entry } });
        const before = await readFile(rootFile);
        const lease = await f.lease();
        try {
          await assertNativeDisabled(f, ['cat-cafe-collab']);
        } finally {
          await lease.dispose();
        }
        assert.deepEqual(await readFile(rootFile), before);
      });
    }
  }
}

test('root user MCP keeps its source-relative cwd while retired and managed aliases stay disabled', async (t) => {
  const f = await kimiNativeFixture(t, { capabilities: [managedCapability({ globalEnabled: false })] });
  await f.put(join(f.project, '.mcp.json'), {
    mcpServers: {
      filesystem: { command: 'never-executed', cwd: './tools', args: ['relative-script.js'] },
      'cat-cafe': transports.stdio,
      github: { command: 'npx', args: ['@modelcontextprotocol/server-github'] },
    },
  });
  const lease = await f.lease();
  try {
    await assertNativeDisabled(f, ['cat-cafe', 'github']);
    for (const load of Object.values(nativeLoaders)) {
      const effective = await load(f.loadInput);
      assert.notEqual(effective.filesystem.enabled, false);
      assert.equal(resolve(effective.filesystem.cwd), join(f.project, 'tools'));
      assert.deepEqual(effective.filesystem.args, ['relative-script.js']);
    }
  } finally {
    await lease.dispose();
  }
});

test('a retired registry name cannot re-enter through a different project command', async (t) => {
  const f = await kimiNativeFixture(t, {
    capabilities: [
      managedCapability({
        id: 'retired-native',
        pluginId: 'github',
        mcpServer: { command: 'npx', args: ['@modelcontextprotocol/server-github'] },
      }),
    ],
  });
  await f.put(join(f.project, '.mcp.json'), { mcpServers: { 'retired-native': transports.stdio } });
  const lease = await f.lease();
  try {
    await assertNativeDisabled(f, ['retired-native']);
  } finally {
    await lease.dispose();
  }
});

test('native server names matching Object properties cannot evade denial', async (t) => {
  const f = await kimiNativeFixture(t);
  const names = ['__proto__', 'constructor', 'toString'];
  await f.put(join(f.native, 'mcp.json'), {
    mcpServers: Object.fromEntries(names.map((name) => [name, transports.stdio])),
  });
  const lease = await f.lease();
  try {
    for (const load of Object.values(nativeLoaders)) {
      const effective = await load(f.loadInput);
      for (const name of names) {
        assert.ok(!Object.hasOwn(effective, name) || effective[name].enabled === false, `${name} cannot become active`);
      }
    }
  } finally {
    await lease.dispose();
  }
});

test('gitdir worktree discovery and nested user MCP paths follow their actual source roots', async (t) => {
  const f = await kimiNativeFixture(t);
  await rm(join(f.project, '.git'), { recursive: true });
  await writeFile(join(f.project, '.git'), 'gitdir: ../control/worktrees/fixture\n');
  await f.put(join(f.project, '.mcp.json'), {
    mcpServers: {
      inherited: { command: 'never-executed', cwd: './root-tools' },
      override: { command: 'never-executed', cwd: './old' },
    },
  });
  await f.put(join(f.cwd, '.mcp.json'), {
    mcpServers: { override: { command: 'never-executed', cwd: './local-tools' } },
  });
  const lease = await f.lease();
  try {
    for (const load of Object.values(nativeLoaders)) {
      const effective = await load(f.loadInput);
      assert.equal(resolve(effective.inherited.cwd), join(f.project, 'root-tools'));
      assert.equal(resolve(effective.override.cwd), join(f.cwd, 'local-tools'));
    }
  } finally {
    await lease.dispose();
  }
});

test('host-approved collaboration remains executable and per-cat denial cannot leak from lower layers', async (t) => {
  const f = await kimiNativeFixture(t, { capabilities: [managedCapability()] });
  await f.put(join(f.project, '.mcp.json'), { mcpServers: { 'cat-cafe-collab': transports.stdio } });
  const lease = await f.lease();
  try {
    for (const load of Object.values(nativeLoaders)) {
      const effective = await load(f.loadInput);
      assert.notEqual(effective['cat-cafe-collab'].enabled, false);
      assert.deepEqual(effective['cat-cafe-collab'].args, [join(f.dist, 'collab.js')]);
    }
  } finally {
    await lease.dispose();
  }
  await f.put(f.registry, { version: 2, capabilities: [managedCapability({ blockedCats: ['kimi'] })] });
  const denied = await f.lease();
  try {
    await assertNativeDisabled(f, ['cat-cafe-collab']);
  } finally {
    await denied.dispose();
  }
});
