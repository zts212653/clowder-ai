import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { resolveCodexAccountLaunch } from '../src/config/codex-account-launch.js';
import { CodexAgentService } from '../src/domains/cats/services/agents/providers/CodexAgentService.js';
import { writeAgentCommandFile } from '../src/domains/terminal/tmux-command-file.js';
import { F320AccountWire } from './helpers/f320-account-wire.js';
import { installAmbientCodexAccount } from './helpers/f320-auth-environment.js';
import { fakeL0Compiler } from './helpers/fake-l0-compiler.js';

test('Codex invoke passes its finalized environment to the real tmux writer', async (t) => {
  installAmbientCodexAccount(t);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'issue1666-service-writer-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const invalidKeys = Object.entries(process.env).filter(([key]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key));
  for (const [key] of invalidKeys) delete process.env[key];
  t.after(() => {
    for (const [key, value] of invalidKeys) process.env[key] = value;
  });
  const bin = join(root, 'bin');
  await mkdir(bin);
  for (const name of ['bash', 'env', 'rm']) {
    await writeFile(join(bin, name), 'fixture tool: discovered but never executed', { mode: 0o755 });
  }
  const originalPath = process.env.PATH;
  process.env.PATH = bin + delimiter + (originalPath ?? '');
  t.after(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  });
  const account = {
    id: 'writer-api-fixture',
    authType: 'api_key' as const,
    apiKey: 'writer-selected-key',
    envVars: { HOME: root },
  };
  const launch = resolveCodexAccountLaunch(account, { cwd: root, env: { HOME: root } });
  const service = new CodexAgentService({
    carrierMode: 'app_server',
    cliCommand: process.execPath,
    l0CompilerFn: fakeL0Compiler,
    rawArchive: { append: async () => {} },
  });
  let scriptCount = 0;
  for await (const event of service.invoke('fixture', {
    workingDirectory: root,
    invocationId: 'writer-invocation',
    codexAccountLaunch: launch,
    accountEnv: account.envVars,
    callbackEnv: { CODEX_AUTH_MODE: 'api_key', OPENAI_API_KEY: account.apiKey },
    agentCarrierSessionFactory: async (options) => {
      const directory = await mkdtemp(join(root, 'command-'));
      const argv = await writeAgentCommandFile(
        directory,
        {
          cwd: options.cwd,
          env: options.env,
          inheritParentEnv: options.inheritParentEnv,
        },
        ':',
      );
      const scriptPath = argv.at(-1);
      assert.ok(scriptPath, 'writeAgentCommandFile must return at least one argument');
      const script = await readFile(scriptPath, 'utf8');
      scriptCount++;
      assert.equal(
        script.includes('export CODEX_API_KEY='),
        false,
        'actual writer must not restore ambient CODEX_API_KEY',
      );
      assert.equal(
        script.includes("export OPENAI_API_KEY='writer-selected-key'"),
        true,
        'actual script must carry the selected fixture account',
      );
      return new F320AccountWire({});
    },
  })) {
    assert.notEqual(event.type, 'error', event.error);
  }
  assert.equal(scriptCount, 1, 'the real service invocation must reach the writer and produce one script');
});
