import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolveCodexAccountLaunch } from '../dist/config/codex-account-launch.js';
import {
  CodexAgentService,
  codexConfigObjectFromArgs,
} from '../dist/domains/cats/services/agents/providers/CodexAgentService.js';
import { writeMcpProbe } from './helpers/mcp-probe.js';

// This suite tests only the provider's launch boundary. The Host resolver and
// public source admission are separate authorities; these callbacks are fakes,
// not evidence that a real public/Work invocation has been admitted.
const policy = {
  mode: 'plugin_native',
  pluginInstanceId: 'instance-a',
  contributionId: 'native',
};

async function collect(stream) {
  const messages = [];
  for await (const message of stream) messages.push(message);
  return messages;
}

function configValues(args) {
  const values = new Map();
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--config' && args[i] !== '-c') continue;
    const expression = args[++i];
    const split = expression.indexOf('=');
    if (split >= 0) values.set(expression.slice(0, split), expression.slice(split + 1));
  }
  return values;
}

async function fixture(t, serviceOverrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'codex-native-launch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'public-workspace');
  const packageRoot = join(root, 'admitted-package');
  await mkdir(join(workspace, '.cat-cafe'), { recursive: true, mode: 0o700 });
  await mkdir(packageRoot, { mode: 0o700 });
  await writeFile(
    join(workspace, '.cat-cafe/capabilities.json'),
    JSON.stringify({
      version: 1,
      capabilities: [
        {
          id: 'ambient-unrelated',
          name: 'Ambient unrelated',
          type: 'mcp',
          enabled: true,
          mcpServer: { command: 'ambient-unrelated-command', args: ['ambient-unrelated.js'] },
        },
      ],
    }),
  );
  const calls = [];
  const projections = [];
  let duringL0 = async () => {};
  let duringSpawn = async () => {};
  let current = true;
  let currentChecks = 0;
  const server = {
    name: 'plugin__fixture__native',
    transport: 'stdio',
    command: process.execPath,
    args: [join(packageRoot, 'native.mjs'), '--bound'],
    workingDirectory: packageRoot,
    env: { CLOWDER_PLUGIN_ACTION_TOKEN: 'activation-fixture', CAT_CAFE_CALLBACK_TOKEN: 'stale-fixture' },
  };
  const launch = {
    server,
    sandbox: { kind: 'public', workspaceRoot: workspace },
    assertCurrent: () => {
      currentChecks++;
      if (!current) throw new Error('native_launch_admission_expired');
    },
  };
  const spawnFn = (_command, args, options) => {
    const descriptor = codexConfigObjectFromArgs(args).mcp_servers?.[server.name];
    const inherited = Object.fromEntries(
      (descriptor?.env_vars ?? [])
        .filter((key) => options.env[key] !== undefined)
        .map((key) => [key, options.env[key]]),
    );
    const spec = descriptor ? { ...descriptor, env: { ...inherited, ...descriptor.env } } : undefined;
    const specPath = spec?.env?.CAT_CAFE_CREDENTIAL_FILE;
    const specMode = specPath ? statSync(specPath).mode & 0o777 : undefined;
    const authentication = specPath ? JSON.parse(readFileSync(specPath, 'utf8')) : undefined;
    const authPath = options.env.CODEX_HOME && join(options.env.CODEX_HOME, 'auth.json');
    const authTarget = authPath && existsSync(authPath) ? realpathSync(authPath) : undefined;
    calls.push({
      args: [...args],
      options: { ...options, env: { ...options.env } },
      spec,
      authentication,
      specMode,
      specPath,
      authTarget,
    });
    // Incompatible carriers must be refused before touching any app-server
    // transport. Never simulate its handshake or start a real process here.
    if (args.includes('app-server')) throw new Error('unexpected_app_server_spawn');
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.exitCode = null;
    child.kill = () => {
      child.stdout.end();
      child.emit('exit', null, 'SIGTERM');
      child.emit('close', null, 'SIGTERM');
      return true;
    };
    setImmediate(async () => {
      try {
        await duringSpawn(calls.at(-1));
      } catch (error) {
        child.emit('error', error);
        child.kill();
        return;
      }
      child.stdout.end(`${JSON.stringify({ type: 'turn.completed', usage: {} })}\n`);
      child.exitCode = 0;
      child.emit('exit', 0, null);
      child.emit('close', 0, null);
    });
    return child;
  };
  const service = new CodexAgentService({
    carrierMode: 'exec_json',
    model: 'gpt-5.3-codex',
    cliCommand: process.execPath,
    spawnFn,
    l0CompilerFn: async (input) => {
      projections.push(input.projection);
      await duringL0();
      return '# Public fixture identity\n';
    },
    ...serviceOverrides,
  });
  const options = {
    signal: new AbortController().signal,
    workingDirectory: workspace,
    toolExecutionPolicy: structuredClone(policy),
    pluginNativeLaunch: launch,
    callbackEnv: {
      CODEX_AUTH_MODE: 'api_key',
      CAT_CAFE_CAT_ID: 'codex',
      CAT_CAFE_INVOCATION_ID: 'invocation-fixture',
      CAT_CAFE_CALLBACK_TOKEN: 'current-fixture',
    },
    accountEnv: { OPENAI_API_KEY: 'not-a-real-key' },
  };
  return {
    root,
    workspace,
    packageRoot,
    service,
    options,
    launch,
    calls,
    projections,
    setCurrent: (value) => {
      current = value;
    },
    onL0: (fn) => {
      duringL0 = fn;
    },
    onSpawn: (fn) => {
      duringSpawn = fn;
    },
    currentChecks: () => currentChecks,
  };
}

test('the admitted plugin runs directly without a protection process or native hooks', async (t) => {
  const f = await fixture(t);
  f.options.callbackEnv.CAT_CAFE_CALLBACK_TOKEN += '-long-fixture-value';
  const file = join(f.packageRoot, 'result.txt');
  await writeFile(file, 'clean');
  writeMcpProbe(f.launch.server.args[0], `return {text:readFileSync(${JSON.stringify(file)},'utf8')};`);
  let checked = false;
  f.onSpawn(async (call) => {
    const config = codexConfigObjectFromArgs(call.args);
    assert.equal(config.features.hooks, false);
    const server = config.mcp_servers[f.launch.server.name];
    const client = new Client({ name: 'private-plugin-consumer', version: '1' });
    const transport = new StdioClientTransport({
      command: server.command,
      args: server.args,
      env: call.spec.env,
      stderr: 'pipe',
    });
    transport.stderr?.on('data', () => {});
    try {
      await client.connect(transport);
      assert.equal((await client.listTools()).tools[0].name, 'probe');
      const clean = await client.callTool({ name: 'probe', arguments: {} });
      assert.equal(JSON.parse(clean.content[0].text).text, 'clean');
      const fake = ['ghp', '_', 'Z'.repeat(36)].join('');
      const blocked = await client.callTool({ name: 'probe', arguments: { text: fake } });
      assert.notEqual(blocked.isError, true);
      await writeFile(file, fake);
      const redacted = await client.callTool({ name: 'probe', arguments: {} });
      assert.ok(JSON.stringify(redacted).includes(fake), 'third-party MCP result inspection was explicitly retired');
      checked = true;
    } finally {
      await client.close();
    }
  });
  const messages = await collect(f.service.invoke('Fixture prompt', f.options));
  assert.equal(checked, true, JSON.stringify(messages));
});

async function refused(f, options) {
  let messages = [];
  let thrown;
  try {
    messages = await collect(f.service.invoke('Fixture prompt', options));
  } catch (error) {
    thrown = error;
  }
  assert.equal(f.calls.length, 0, 'native admission refusal must precede provider spawn');
  assert.ok(thrown || messages.some((message) => message.type === 'error'), 'refusal must be explicit');
}

test(
  'native dotted plugin identity is carried as a literal MCP key without ambient servers',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const name = 'plugin__dev.clowder.xiangqi__xiangqi-analysis';
    f.launch.server.name = name;
    const messages = await collect(f.service.invoke('Fixture prompt', f.options));
    assert.equal(f.calls.length, 1, JSON.stringify(messages));
    const args = f.calls[0].args;
    const servers = codexConfigObjectFromArgs(args).mcp_servers;
    assert.deepEqual(Object.keys(servers), [name]);
    assert.equal(servers[name].enabled, true);
    assert.equal(f.calls[0].spec.env.CLOWDER_PLUGIN_ACTION_TOKEN, 'activation-fixture');
    assert.equal(
      args.some((arg) => arg.startsWith('mcp_servers."')),
      false,
    );
  },
);

test('native launch refuses missing or unpaired Host admission', { timeout: 15000 }, async (t) => {
  for (const shape of ['absent', 'no-current-check', 'no-policy', 'no-signal']) {
    const f = await fixture(t);
    const options = { ...f.options };
    if (shape === 'absent') delete options.pluginNativeLaunch;
    else if (shape === 'no-current-check') options.pluginNativeLaunch = { ...f.launch, assertCurrent: undefined };
    else if (shape === 'no-policy') delete options.toolExecutionPolicy;
    else delete options.signal;
    await refused(f, options);
  }
});

test(
  'public launch exposes only the admitted server and closes ambient tool surfaces',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const messages = await collect(
      f.service.invoke('Fixture prompt', {
        ...f.options,
        cliConfigArgs: ['--config mcp_servers.evil.command="evil"', '--config features.shell_tool=true', '--add-dir /'],
      }),
    );
    assert.equal(
      messages.some((message) => message.type === 'error'),
      false,
    );
    assert.equal(f.calls.length, 1);
    const { args } = f.calls[0];
    for (const flag of ['--ignore-user-config', '--ignore-rules', '--strict-config', '--ephemeral']) {
      assert.ok(args.includes(flag), `public launch requires ${flag}`);
    }
    assert.equal(args.includes('--add-dir'), false);
    const values = configValues(args);
    const configured = codexConfigObjectFromArgs(args).mcp_servers;
    assert.deepEqual(Object.keys(configured), [f.launch.server.name]);
    assert.equal(configured[f.launch.server.name].command, process.execPath);
    const { spec, specMode, specPath } = f.calls[0];
    assert.equal(spec.command, process.execPath);
    assert.deepEqual(spec.args, [join(f.packageRoot, 'native.mjs'), '--bound']);
    assert.equal(spec.cwd, f.packageRoot);
    assert.equal(spec.env.CAT_CAFE_CALLBACK_TOKEN, undefined);
    assert.equal(f.calls[0].authentication.callbackToken, 'current-fixture');
    assert.equal(spec.env.CLOWDER_PLUGIN_ACTION_TOKEN, 'activation-fixture');
    assert.equal(spec.env.OPENAI_API_KEY, undefined);
    assert.equal(specMode, 0o600);
    assert.equal(existsSync(specPath), false, 'owned credential file is removed after child completion');
    assert.equal(args.join('\n').includes('current-fixture'), false);
    assert.equal(args.join('\n').includes('activation-fixture'), false);
    assert.equal(args.join('\n').includes('stale-fixture'), false);
    assert.equal(args.join('\n').includes('ambient-unrelated'), false);
    for (const feature of [
      'shell_tool',
      'unified_exec',
      'apply_patch_freeform',
      'apps',
      'plugins',
      'multi_agent',
      'browser_use',
      'hooks',
    ]) {
      assert.equal(values.get(`features.${feature}`), 'false', `${feature} must be disabled`);
    }
    assert.equal(values.get('web_search'), '"disabled"');
    assert.equal(values.get('approval_policy'), '"never"');
    const network = [...values].filter(([key]) => key.startsWith('permissions.') && key.endsWith('.network'));
    assert.equal(network.length, 1);
    assert.equal(network[0][1], '{enabled=false}');
    const filesystem = [...values].filter(([key]) => key.startsWith('permissions.') && key.endsWith('.filesystem'));
    assert.equal(filesystem.length, 1);
    assert.match(filesystem[0][1], /deny/);
    assert.equal(filesystem[0][1].includes('write'), false);
    assert.match(filesystem[0][1], /":tmpdir"="deny"/);
    assert.match(filesystem[0][1], /":slash_tmp"="deny"/);
  },
);

test(
  'public child environment cannot inherit secrets or account overrides of the isolation roots',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const parentKey = 'F202_NATIVE_PARENT_SECRET';
    const old = process.env[parentKey];
    process.env[parentKey] = 'parent-only-fixture';
    t.after(() => {
      if (old === undefined) delete process.env[parentKey];
      else process.env[parentKey] = old;
    });
    await collect(
      f.service.invoke('Fixture prompt', {
        ...f.options,
        accountEnv: {
          ...f.options.accountEnv,
          HOME: '/ambient-home',
          CODEX_HOME: '/ambient-codex',
          NODE_OPTIONS: '--require /untrusted.cjs',
          PATH: '/untrusted-bin',
          GITHUB_TOKEN: 'account-unrelated',
        },
      }),
    );
    assert.equal(f.calls.length, 1);
    const { env, cwd } = f.calls[0].options;
    assert.equal(env[parentKey], undefined, 'ambient parent secrets must not enter the provider');
    assert.equal(env.NODE_OPTIONS, undefined);
    assert.equal(env.GITHUB_TOKEN, undefined);
    assert.equal(env.CAT_CAFE_CALLBACK_TOKEN, undefined, 'callback credentials belong to the admitted MCP server');
    assert.equal(env.PATH.includes('/untrusted-bin'), false);
    assert.ok(isAbsolute(env.HOME));
    assert.notEqual(env.HOME, process.env.HOME);
    assert.notEqual(env.HOME, '/ambient-home');
    assert.equal(relative(env.HOME, env.CODEX_HOME).startsWith('..'), false);
    assert.equal(cwd, realpathSync(f.workspace));
    assert.equal(env.PWD, realpathSync(f.workspace));
    assert.equal(env.INIT_CWD, realpathSync(f.workspace));
    assert.equal(existsSync(env.HOME), false, 'private HOME is cleaned after completion');
  },
);

test(
  'native authority is checked before preparation and again after asynchronous L0 compilation',
  { timeout: 15000 },
  async (t) => {
    for (const timing of ['before', 'during-l0', 'before-spawn']) {
      const f = await fixture(t);
      if (timing === 'before') f.setCurrent(false);
      else if (timing === 'during-l0')
        f.onL0(async () => {
          f.setCurrent(false);
        });
      else
        f.options.beforeProviderLaunch = async () => {
          f.setCurrent(false);
        };
      await refused(f, f.options);
      assert.ok(f.currentChecks() >= (timing === 'before' ? 1 : 2));
      if (timing === 'before') assert.equal(f.projections.length, 0);
    }
  },
);

test('public identity and descriptor remain bound across preparation awaits', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  f.onL0(async () => {
    f.launch.server.command = '/mutated-command';
    f.launch.server.args.push('mutated-argument');
    f.launch.server.env.CLOWDER_PLUGIN_ACTION_TOKEN = 'mutated-token';
  });
  const messages = await collect(f.service.invoke('Fixture prompt', f.options));
  assert.equal(
    messages.some((message) => message.type === 'error'),
    false,
  );
  assert.deepEqual(f.projections, ['public']);
  assert.equal(f.calls.length, 1);
  const args = f.calls[0].args.join('\n');
  assert.equal(args.includes('mutated-'), false);
  assert.equal(f.calls[0].spec.env.CLOWDER_PLUGIN_ACTION_TOKEN, 'activation-fixture');
  assert.ok(f.currentChecks() >= 2);
});

test(
  'native public launch rejects session reuse, alternate carriers, and unadmitted Work',
  { timeout: 15000 },
  async (t) => {
    for (const shape of ['resume', 'app-server', 'required-tools', 'work']) {
      const f = await fixture(t, shape === 'app-server' ? { carrierMode: 'app_server' } : {});
      const options = { ...f.options };
      if (shape === 'resume') options.sessionId = 'old-owner-session';
      else if (shape === 'required-tools') options.requiredTools = ['shell'];
      else if (shape === 'work')
        options.pluginNativeLaunch = {
          ...f.launch,
          sandbox: { kind: 'entrusted_work', workspaceRoot: f.workspace, readOnlyRoots: [] },
        };
      await refused(f, options);
    }
  },
);

test(
  'public preparation fails closed for abort, descriptor errors and owner-only launch inputs',
  { timeout: 15000 },
  async (t) => {
    for (const shape of ['abort', 'token', 'cwd', 'system-prompt', 'spawn-override']) {
      const f = await fixture(t);
      if (shape === 'abort') {
        const abort = new AbortController();
        f.options.signal = abort.signal;
        f.onL0(async () => abort.abort(new Error('fixture source revoked')));
      } else if (shape === 'token') delete f.launch.server.env.CLOWDER_PLUGIN_ACTION_TOKEN;
      else if (shape === 'cwd') f.options.workingDirectory = f.root;
      else if (shape === 'system-prompt') f.options.systemPrompt = 'Private owner instructions';
      else
        f.options.spawnCliOverride = () => {
          throw new Error('must not call alternate spawn');
        };
      await refused(f, f.options);
      assert.equal(
        f.service.supportsToolExecutionPolicy(policy),
        false,
        'provider capability is not enabled by this launch implementation',
      );
    }
  },
);

test(
  'OAuth public HOME uses the selected account rather than ambient login and projects only auth',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const accountRoot = join(f.root, 'account-codex');
    await mkdir(accountRoot, { mode: 0o700 });
    await writeFile(join(accountRoot, 'auth.json'), '{}', { mode: 0o600 });
    await writeFile(join(accountRoot, 'config.toml'), 'private_fixture=true');
    const previous = process.env.CODEX_HOME;
    const ambientRoot = join(f.root, 'ambient-account');
    await mkdir(ambientRoot);
    await writeFile(join(ambientRoot, 'auth.json'), '{"account":"ambient"}');
    process.env.CODEX_HOME = ambientRoot;
    t.after(() => {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
    });
    const messages = await collect(
      f.service.invoke('Fixture prompt', {
        ...f.options,
        codexAccountLaunch: resolveCodexAccountLaunch(
          { id: 'selected-oauth', authType: 'oauth', envVars: { CODEX_HOME: accountRoot } },
          { cwd: f.workspace },
        ),
        callbackEnv: { ...f.options.callbackEnv, CODEX_AUTH_MODE: 'oauth' },
      }),
    );
    assert.equal(
      messages.some((message) => message.type === 'error'),
      false,
    );
    assert.equal(f.calls.length, 1);
    const call = f.calls[0];
    assert.equal(call.authTarget, realpathSync(join(accountRoot, 'auth.json')));
    assert.equal(call.options.env.OPENAI_API_KEY, undefined);
    assert.notEqual(call.spec.env.HOME, call.options.env.HOME);
    assert.equal(existsSync(call.options.env.HOME), false);
    assert.equal(readFileSync(join(accountRoot, 'auth.json'), 'utf8'), '{}');
    assert.equal(readFileSync(join(accountRoot, 'config.toml'), 'utf8'), 'private_fixture=true');
  },
);
