import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { namedAlphaEnvironment } from '../../../../scripts/lib/alpha-coordinates.mjs';
import { CodexAgentService } from '../../dist/domains/cats/services/agents/providers/CodexAgentService.js';
import { resolveClaudeMcpConfig } from '../../dist/domains/cats/services/agents/providers/claude-mcp-config.js';
import { writeOpenCodeRuntimeConfig } from '../../dist/domains/cats/services/agents/providers/opencode-config-writer.js';
import { fakeL0Compiler } from './fake-l0-compiler.js';

export const memberIds = ['codex', 'opus', 'kimi', 'glm52'];
export const callbackFixture = {
  CAT_CAFE_API_URL: 'http://127.0.0.1:1',
  CAT_CAFE_INVOCATION_ID: 'fixture',
  CAT_CAFE_CALLBACK_TOKEN: 'fixture',
};
export const managed = (extra = {}) => ({
  id: 'cat-cafe-collab',
  type: 'mcp',
  source: 'cat-cafe',
  enabled: true,
  globalEnabled: true,
  mcpServer: { command: 'node', args: ['/stale/collab.js'] },
  ...extra,
});
export const capabilityFile = (root) => join(root, '.cat-cafe/capabilities.json');
export function putConfig(root, capabilities) {
  mkdirSync(join(root, '.cat-cafe'), { recursive: true });
  writeFileSync(capabilityFile(root), JSON.stringify({ version: 2, capabilities }));
}

export function fixture(t) {
  assert.equal(process.env.CAT_CAFE_TEST_SANDBOX, '1', 'use with-test-home.sh');
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'invoke-mcp-workspace-')));
  const main = join(dir, 'workspace');
  const runtime = join(dir, 'alpha');
  const project = join(dir, 'project');
  for (const root of [main, runtime, project]) {
    mkdirSync(root);
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages: []\n');
  }
  const dist = join(runtime, 'packages/mcp-server/dist');
  mkdirSync(dist, { recursive: true });
  for (const entry of ['index', 'collab', 'memory', 'signals', 'limb', 'audio', 'finance'])
    writeFileSync(join(dist, `${entry}.js`), '// Never executed\n');
  putConfig(main, [managed()]);
  putConfig(runtime, [{ id: 'plugin:github:cicd-check', type: 'schedule', enabled: true, source: 'cat-cafe' }]);
  const keys = [
    'CAT_CAFE_DEPLOYMENT_ID',
    'CAT_CAFE_RUNTIME_ROOT',
    'CAT_CAFE_WORKSPACE_ROOT',
    'PROJECT_ALLOWED_ROOTS',
    'CAT_CAFE_CODEX_CARRIER',
  ];
  const old = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const cwd = process.cwd();
  const named = namedAlphaEnvironment({
    v: 1,
    instance: 'mcp-fixture',
    branch: 'alpha/mcp-fixture-main-sync',
    mainRoot: main,
    alphaRoot: runtime,
    targetSha: 'a'.repeat(40),
    ports: { frontend: 5311, api: 5312, preview: 5411, service: 5511, redis: 15397 },
  });
  Object.assign(process.env, {
    CAT_CAFE_DEPLOYMENT_ID: named.CAT_CAFE_DEPLOYMENT_ID,
    CAT_CAFE_RUNTIME_ROOT: named.CAT_CAFE_RUNTIME_ROOT,
    CAT_CAFE_WORKSPACE_ROOT: named.CAT_CAFE_WORKSPACE_ROOT,
    PROJECT_ALLOWED_ROOTS: dir,
    CAT_CAFE_CODEX_CARRIER: 'exec_json',
  });
  process.chdir(runtime);
  const gemini = join(main, '.gemini/settings.json');
  const agy = join(homedir(), '.gemini/antigravity/mcp_config.json');
  for (const path of [gemini, agy]) {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, '{"sentinel":"existing owner configuration"}');
  }
  t.after(() => {
    process.chdir(cwd);
    for (const k of keys) {
      if (old[k] === undefined) delete process.env[k];
      else process.env[k] = old[k];
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    main,
    runtime,
    project,
    dist,
    mcpServerPath: join(dist, 'index.js'),
    sentinelPaths: [capabilityFile(main), capabilityFile(runtime), gemini, agy],
  };
}

async function codexConfig(_f, workingDirectory) {
  let captured;
  const events = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const proc = {
    stdout,
    stderr,
    pid: 123456789,
    exitCode: null,
    stdin: {
      write: () => true,
      end() {},
      on() {
        return this;
      },
    },
    on(event, fn) {
      events.on(event, fn);
      return this;
    },
    once(event, fn) {
      events.once(event, fn);
      return this;
    },
    kill() {
      throw new Error('No real child belongs to this test');
    },
  };
  const service = new CodexAgentService({
    catId: 'codex',
    cliCommand: process.execPath,
    l0CompilerFn: fakeL0Compiler,
    spawnFn(_command, args) {
      captured = args;
      setImmediate(() => {
        stdout.write('{"type":"thread.started","thread_id":"mock-only"}\n');
        stdout.end();
        stderr.end();
        events.emit('exit', 0, null);
        setImmediate(() => events.emit('close', 0, null));
      });
      return proc;
    },
  });
  const output = [];
  for await (const event of service.invoke('fixture', {
    workingDirectory,
    callbackEnv: {
      CAT_CAFE_CAT_ID: 'codex',
      CAT_CAFE_API_URL: 'http://127.0.0.1:1',
      CAT_CAFE_INVOCATION_ID: 'fixture',
      CAT_CAFE_CALLBACK_TOKEN: 'fixture',
      CODEX_AUTH_MODE: 'oauth',
    },
  }))
    output.push(event);
  if (!captured) throw new Error(JSON.stringify(output));
  const result = {};
  for (const value of captured) {
    const match = /^mcp_servers\.([^.]+)\.enabled=true$/.exec(value);
    if (!match) continue;
    const name = match[1];
    const field = (key) => {
      const prefix = `mcp_servers.${name}.${key}=`;
      const value = captured.find((v) => v.startsWith(prefix));
      return value ? JSON.parse(value.slice(prefix.length)) : undefined;
    };
    const env = {};
    for (const key of [...Object.keys(callbackFixture), 'ALLOWED_WORKSPACE_DIRS']) {
      const value = field(`env.${key}`);
      if (value !== undefined) env[key] = value;
    }
    result[name] = { args: field('args') ?? [], command: field('command'), env };
  }
  return result;
}

export const providers = {
  codex: codexConfig,
  claude: async (f, workingDirectory) =>
    (
      await resolveClaudeMcpConfig({
        workingDirectory,
        mcpServerPath: f.mcpServerPath,
        callbackEnv: { ...callbackFixture, CAT_CAFE_CAT_ID: 'opus' },
      })
    ).servers,
  opencode: async (f, workingDirectory) => {
    const path = await writeOpenCodeRuntimeConfig(
      f.runtime,
      'glm52',
      'fixture',
      {
        providerName: 'fixture',
        models: ['fixture'],
        mcpServerPath: f.mcpServerPath,
        catId: 'glm52',
        allowedWorkspaceDirs: f.main,
      },
      workingDirectory,
    );
    const config = JSON.parse(readFileSync(path, 'utf8')).mcp ?? {};
    return Object.fromEntries(
      Object.entries(config)
        .filter(([, v]) => v.enabled !== false)
        .map(([name, v]) => [name, { ...v, command: v.command[0], args: v.command.slice(1), env: v.environment }]),
    );
  },
};
