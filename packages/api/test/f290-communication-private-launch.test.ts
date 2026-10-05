import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { CANONICAL_TOOL_REGISTRY } from '../../mcp-server/src/canonical-server-tools.js';
import { COLLECTIVE_WORK_TOOLS } from '../src/domains/cats/services/agents/invocation/tool-execution-policy.js';
import { CodexAgentService } from '../src/domains/cats/services/agents/providers/CodexAgentService.js';
import type { SpawnFn } from '../src/utils/cli-types.js';

test(
  'production private provider keeps named Cat/model/home compiler while replacing global flags, MCP and arbitrary account environment',
  { skip: spawnSync('codex', ['--version']).status !== 0 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'f290-private-launch-'));
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    let launch: { command: string; args: readonly string[]; env: Record<string, string | undefined> } | undefined;
    const compiles: unknown[] = [];
    const spawnFn: SpawnFn = (command, args, options) => {
      launch = { command, args, env: options.env ?? {} };
      const child = new EventEmitter();
      Object.assign(child, {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: new PassThrough(),
        pid: 12345,
        exitCode: null,
        kill: () => true,
      });
      const proc = child as ReturnType<SpawnFn>;
      setImmediate(() => {
        proc.stdout?.emit(
          'data',
          `${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } })}\n`,
        );
        proc.stdout?.emit('end');
        proc.stderr?.emit('end');
        child.emit('exit', 0, null);
        child.emit('close', 0, null);
      });
      return proc;
    };
    const service = new CodexAgentService({
      catId: 'codex-sol',
      model: 'gpt-6-astra',
      carrierMode: 'app_server',
      cliCommand: 'PRIVATE_WRAPPER',
      spawnFn,
      l0CompilerFn: async (input) => {
        compiles.push(input);
        return 'HOME_L0_IDENTITY_CANARY';
      },
    });
    try {
      const events = [];
      for await (const event of service.invoke('CURRENT_TASK_CANARY', {
        systemPrompt: 'Exact private task boundary',
        workingDirectory: workspace,
        toolExecutionPolicy: {
          mode: 'collective_work',
          taskId: 'A',
          threadId: 'private-A',
          executionRevision: 1,
          executionRef: 'message:admission-A',
          workspaceRoot: workspace,
          readOnlyRoots: [],
        },
        cliConfigArgs: [
          '--dangerously-bypass-approvals-and-sandbox',
          '--config developer_instructions="ATTACK_OVERRIDE"',
        ],
        contentBlocks: [{ type: 'image', url: 'file:///PRIVATE_IMAGE.png' }],
        accountEnv: { HOME: '/PRIVATE_HOME', PRIVATE_ACCOUNT_SECRET: 'canary' },
        callbackEnv: {
          CAT_CAFE_INVOCATION_ID: 'private-inv',
          CAT_CAFE_CALLBACK_TOKEN: 'callback-test-only',
          CAT_CAFE_API_URL: 'http://127.0.0.1:3182',
          CAT_CAFE_CAT_ID: 'codex-sol',
          CAT_CAFE_USER_ID: 'owner',
          CAT_CAFE_THREAD_ID: 'private-A',
          CODEX_AUTH_MODE: 'api_key',
          OPENAI_API_KEY: 'account-test-only',
        },
      }))
        events.push(event);
      assert.ok(launch, JSON.stringify(events));
      assert.equal(launch.args[0], 'exec');
      assert.deepEqual(compiles, [{ catId: 'codex-sol', userId: 'owner', projection: 'collective-work' }]);
      assert.equal(launch.env.CAT_CAFE_MCP_PROFILE, 'collective-work');
      assert.ok(launch.args.includes('mcp_servers.cat-cafe-collab.env={CAT_CAFE_MCP_PROFILE="collective-work"}'));
      const enabled = launch.args.find((arg) => arg.startsWith('mcp_servers.cat-cafe-collab.enabled_tools='));
      assert.ok(enabled);
      assert.deepEqual(
        JSON.parse(enabled.slice(enabled.indexOf('=') + 1)).sort(),
        CANONICAL_TOOL_REGISTRY.filter((tool) => tool.policy.runtimeProfiles.includes('collective-work'))
          .map((tool) => tool.name)
          .sort(),
      );
      assert.deepEqual(
        CANONICAL_TOOL_REGISTRY.filter((tool) => tool.policy.runtimeProfiles.includes('collective-work'))
          .map((tool) => tool.name)
          .sort(),
        CANONICAL_TOOL_REGISTRY.filter((tool) => COLLECTIVE_WORK_TOOLS.has(tool.name))
          .map((tool) => tool.name)
          .sort(),
      );
      assert.match(JSON.stringify(launch.args), /HOME_L0_IDENTITY_CANARY/);
      assert.match(JSON.stringify(launch.args), /gpt-6-astra/);
      assert.doesNotMatch(JSON.stringify(launch.args), /danger-full-access|PRIVATE_|ATTACK_OVERRIDE|app-server/);
      assert.match(JSON.stringify(launch.args), /shell_environment_policy.inherit=\\"none/);
      assert.equal(launch.env.PRIVATE_ACCOUNT_SECRET, undefined);
      assert.equal(launch.env.CAT_CAFE_CALLBACK_TOKEN, 'callback-test-only');
      assert.ok(launch.env.HOME?.startsWith(root));
      assert.notEqual(launch.env.HOME, workspace, 'authentication control directory is outside the shell workspace');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
