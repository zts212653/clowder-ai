import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { CodexAgentService } from '../dist/domains/cats/services/agents/providers/CodexAgentService.js';

test(
  'the actual provider launch replaces personal app-server/config/image/account inputs with the isolated public carrier',
  { skip: spawnSync('codex', ['--version']).status !== 0, timeout: 15000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'collective-provider-'));
    let launch;
    let stdin = '';
    const service = new CodexAgentService({
      catId: 'codex-sol',
      model: 'gpt-6-astra',
      carrierMode: 'app_server',
      cliCommand: 'PRIVATE_WRAPPER',
      l0CompilerFn: async () => {
        throw new Error('PRIVATE_L0_COMPILER_CALLED');
      },
      spawnFn: (command, args, options) => {
        launch = { command, args, options };
        const proc = new EventEmitter();
        proc.stdout = new PassThrough();
        proc.stderr = new PassThrough();
        proc.stdin = new PassThrough();
        proc.stdin.on('data', (chunk) => {
          stdin += String(chunk);
        });
        proc.pid = 12345;
        proc.exitCode = null;
        proc.kill = () => true;
        setImmediate(() => {
          proc.stdout.end(
            `${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } })}\n`,
          );
          proc.stderr.end();
          proc.exitCode = 0;
          proc.emit('exit', 0, null);
          proc.emit('close', 0, null);
        });
        return proc;
      },
    });
    try {
      const events = [];
      for await (const event of service.invoke('PUBLIC_A', {
        systemPrompt: 'Public Astra identity',
        workingDirectory: directory,
        toolExecutionPolicy: { mode: 'collective_participation' },
        cliConfigArgs: ['--config sandbox_mode="danger-full-access"', '--config developer_instructions="PRIVATE_RULE"'],
        contentBlocks: [{ type: 'image', url: 'file:///PRIVATE_IMAGE.png' }],
        accountEnv: { HOME: '/PRIVATE_HOME', CODEX_HOME: '/PRIVATE_CODEX_HOME', PRIVATE_ACCOUNT_SECRET: 'canary' },
        callbackEnv: {
          CAT_CAFE_MCP_PROFILE: 'collective-participation',
          CAT_CAFE_INVOCATION_ID: 'public-inv',
          CAT_CAFE_CALLBACK_TOKEN: 'test-token',
          CAT_CAFE_API_URL: 'http://127.0.0.1:3182',
          CAT_CAFE_USER_ID: 'owner',
          CAT_CAFE_CAT_ID: 'codex-sol',
          CAT_CAFE_THREAD_ID: 'public',
          CODEX_AUTH_MODE: 'api_key',
          OPENAI_API_KEY: 'fake-test-only',
        },
      }))
        events.push(event);
      assert.ok(launch, JSON.stringify(events));
      assert.equal(launch.args[0], 'exec');
      assert.ok(launch.args.includes('--ephemeral'));
      assert.ok(launch.args.includes('permissions.collective.filesystem={"/"="deny",":minimal"="read"}'));
      assert.equal(launch.args.includes('--image'), false);
      assert.doesNotMatch(JSON.stringify(launch.args), /PRIVATE_|danger-full-access|app-server/);
      assert.doesNotMatch(launch.command, /PRIVATE_WRAPPER/);
      assert.ok(launch.options.env.HOME.startsWith(directory));
      assert.ok(launch.options.env.CODEX_HOME.startsWith(directory));
      assert.equal(launch.options.env.PRIVATE_ACCOUNT_SECRET, undefined);
      assert.match(stdin, /PUBLIC_A/);
      assert.doesNotMatch(stdin, /PRIVATE_/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
