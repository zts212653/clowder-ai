import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { prepareInvocationExecutionBinding } from '../dist/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { KimiAgentService } from '../dist/domains/cats/services/agents/providers/KimiAgentService.js';
import { prepareKimiMcpConfig } from '../dist/domains/cats/services/agents/providers/kimi-mcp-config.js';
import { ensureFakeCliOnPath } from './helpers/fake-cli-path.js';
import {
  buildFakeL0Compiler,
  createMockArchive,
  createMockProcess,
  emitEvents,
} from './helpers/provider-archive-test-helpers.js';

ensureFakeCliOnPath('kimi');

for (const scenario of [
  'capabilities',
  'project-mcp',
  'member-off',
  'native-file-change',
  'injection-disabled',
  'actual-invoke',
  'project-root-change',
  'prototype-native-before',
  'prototype-native-after',
  'nested-optional-malformed',
  'nested-optional-changed',
]) {
  test(`Kimi native MCP writer consumes its admitted configuration: ${scenario}`, async (t) => {
    const artifacts = join(process.cwd(), 'artifacts', 'role-agent-refactor', 'kimi-mcp-freeze');
    mkdirSync(artifacts, { recursive: true });
    const root = mkdtempSync(join(artifacts, 'fixture-'));
    t.diagnostic(`retained isolated Kimi MCP fixture: ${root}`);
    const host = join(root, 'host');
    const project = join(root, 'project');
    const workingDirectory = scenario.startsWith('nested-optional-') ? join(project, 'nested') : project;
    const nativeBefore = join(root, 'native-before');
    const nativeAfter = join(root, 'native-after');
    const mcpServerPath = join(host, 'packages', 'mcp-server', 'dist', 'index.js');
    for (const dir of [
      join(host, '.cat-cafe'),
      join(host, 'packages', 'mcp-server', 'dist'),
      join(project, '.git'),
      workingDirectory,
      nativeBefore,
      nativeAfter,
    ])
      mkdirSync(dir, { recursive: true });
    copyFileSync(process.env.CAT_TEMPLATE_PATH, join(host, 'cat-template.json'));
    writeFileSync(mcpServerPath, '// never executed');
    const nativeFile = join(nativeBefore, 'mcp.json');
    writeFileSync(nativeFile, JSON.stringify({ mcpServers: { homeTool: { command: 'never-executed' } } }));
    if (scenario === 'prototype-native-before')
      writeFileSync(
        nativeFile,
        JSON.stringify({
          mcpServers: {
            homeTool: { command: 'never-executed' },
            ['__proto__']: { command: 'never-executed' },
          },
        }),
      );
    const keys = ['CAT_CAFE_CONFIG_ROOT', 'CAT_CAFE_PROJECT_ALLOWED_ROOTS', 'KIMI_CODE_HOME'];
    const old = new Map(keys.map((key) => [key, process.env[key]]));
    process.env.CAT_CAFE_CONFIG_ROOT = host;
    process.env.CAT_CAFE_PROJECT_ALLOWED_ROOTS = root;
    process.env.KIMI_CODE_HOME = nativeBefore;
    const all = catRegistry.getAllConfigs();
    const id = 'kimi-mcp-freeze';
    const member = {
      ...all.kimi,
      id,
      accountRef: undefined,
      configurationSource: 'native_tool',
      mcpSupport: scenario !== 'member-off' && !scenario.startsWith('prototype-native-'),
    };
    catRegistry.register(id, member);
    t.after(() => {
      old.forEach((value, key) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      });
      catRegistry.reset();
      Object.entries(all).forEach(([key, config]) => catRegistry.register(key, config));
    });
    const writeConfig = (marker) => {
      const server = { command: process.execPath, args: [`--fixture=${marker}`], env: { FIXTURE_SCOPE: marker } };
      writeFileSync(
        join(host, '.cat-cafe', 'capabilities.json'),
        JSON.stringify({
          version: 1,
          capabilities:
            scenario === 'project-mcp' || scenario === 'nested-optional-changed'
              ? []
              : [{ id: 'fixture-server', type: 'mcp', globalEnabled: true, enabled: true, mcpServer: server }],
        }),
      );
      if (scenario === 'project-mcp' || scenario === 'nested-optional-changed')
        writeFileSync(
          join(workingDirectory, '.mcp.json'),
          JSON.stringify({ mcpServers: { 'fixture-server': server } }),
        );
    };
    writeConfig('before');
    if (scenario === 'nested-optional-malformed') writeFileSync(join(workingDirectory, '.mcp.json'), '{malformed');
    const configuredPath = scenario === 'injection-disabled' ? '' : mcpServerPath;
    const proc = createMockProcess();
    let launched;
    const service = new KimiAgentService({
      catId: id,
      mcpServerPath: configuredPath,
      l0CompilerFn: buildFakeL0Compiler(),
      rawArchive: createMockArchive(),
      spawnFn: (_command, _args, options) => {
        launched = {
          env: options.env,
          servers: JSON.parse(readFileSync(join(workingDirectory, '.kimi-code', 'mcp.json'), 'utf8')).mcpServers,
        };
        setImmediate(() => void emitEvents(proc, [{ role: 'assistant', content: 'owned-fixture-reply' }]));
        return proc;
      },
    });
    const binding = await prepareInvocationExecutionBinding(
      {
        apiUrl: 'http://127.0.0.1:13004',
        threadStore: { get: () => ({ id: 'thread', projectPath: workingDirectory, createdBy: 'owner' }) },
      },
      {
        catId: id,
        threadId: 'thread',
        userId: 'owner',
        service,
      },
    );
    if (scenario === 'prototype-native-before') {
      const servers = binding.providerOptions.frozenKimiMcpConfig.mcpConfig.servers;
      assert.ok(Object.hasOwn(servers, '__proto__'), 'capture must preserve native denial names as own properties');
      assert.equal(servers.__proto__.enabled, false);
    }
    writeConfig('after');
    if (scenario === 'nested-optional-changed') writeFileSync(join(workingDirectory, '.mcp.json'), '{malformed');
    if (scenario === 'member-off') {
      catRegistry.reset();
      Object.entries(all).forEach(([key, config]) => catRegistry.register(key, config));
      catRegistry.register(id, { ...member, mcpSupport: true });
    }
    if (scenario === 'native-file-change')
      writeFileSync(nativeFile, JSON.stringify({ mcpServers: { newHomeTool: { command: 'never-executed' } } }));
    else if (scenario !== 'member-off') process.env.KIMI_CODE_HOME = nativeAfter;
    if (scenario === 'project-root-change') renameSync(join(project, '.git'), join(project, '.git-before'));
    if (scenario === 'prototype-native-after')
      writeFileSync(
        nativeFile,
        JSON.stringify({
          mcpServers: {
            homeTool: { command: 'never-executed' },
            ['__proto__']: { command: 'never-executed' },
          },
        }),
      );
    const prepare = () =>
      prepareKimiMcpConfig({
        ...binding.providerOptions,
        workingDirectory,
        mcpServerPath: configuredPath,
        callbackEnv: { CAT_CAFE_CAT_ID: id },
      });
    if (scenario === 'project-root-change') {
      await assert.rejects(async () => {
        const unexpected = await prepare();
        await unexpected.dispose();
      }, /native project root changed/i);
      assert.equal(existsSync(join(workingDirectory, '.kimi-code', 'mcp.json')), false);
      return;
    }
    if (scenario === 'actual-invoke') {
      const messages = await Array.fromAsync(
        service.invoke('isolated task', {
          ...binding.providerOptions,
          frozenL0Input: binding.frozenL0Input,
          executionPreferences: binding.executionPreferences,
          workingDirectory,
          callbackEnv: { CAT_CAFE_CAT_ID: id },
        }),
      );
      assert.deepEqual(
        messages.filter((message) => message.type === 'error'),
        [],
      );
      assert.equal(launched.env.KIMI_CODE_HOME, nativeBefore);
      assert.deepEqual(launched.servers['fixture-server'].args, ['--fixture=before']);
      assert.equal(launched.servers.homeTool.enabled, false);
      assert.equal(existsSync(join(nativeAfter, 'config.toml')), false, 'secret hooks must not write the later HOME');
      assert.equal(
        existsSync(join(workingDirectory, '.kimi-code', 'mcp.json')),
        false,
        'actual invocation releases its project config lease',
      );
      return;
    }
    const lease = await prepare();
    try {
      if (scenario === 'injection-disabled') {
        assert.equal(
          lease.env.KIMI_CODE_HOME,
          nativeBefore,
          'native discovery and actual execution must use the same HOME',
        );
        assert.equal(existsSync(join(workingDirectory, '.kimi-code', 'mcp.json')), false);
        return;
      }
      const servers = JSON.parse(readFileSync(join(workingDirectory, '.kimi-code', 'mcp.json'), 'utf8')).mcpServers;
      if (scenario === 'native-file-change')
        assert.equal(servers.newHomeTool.enabled, false, 'new ambient tools must not widen the admitted surface');
      if (scenario.startsWith('prototype-native-')) {
        assert.ok(Object.hasOwn(servers, '__proto__'), 'materialization must retain every native denial name');
        assert.equal(servers.__proto__.enabled, false);
      }
      if (!member.mcpSupport) assert.ok(Object.values(servers).every((server) => server.enabled === false));
      else {
        assert.deepEqual(servers['fixture-server'].args, ['--fixture=before']);
        assert.equal(servers['fixture-server'].env.FIXTURE_SCOPE, 'before');
      }
      assert.equal(servers.homeTool.enabled, false, 'native-only tools remain denied');
      assert.equal(
        lease.env.KIMI_CODE_HOME,
        nativeBefore,
        'native discovery and actual execution must use the same HOME',
      );
    } finally {
      await lease.dispose();
    }
  });
}
