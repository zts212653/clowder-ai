import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mock, test } from 'node:test';
import { ensureFakeCliOnPath } from './helpers/fake-cli-path.js';
import {
  buildFakeL0Compiler,
  collect,
  createMockProcess,
  emitEvents,
} from './helpers/provider-archive-test-helpers.js';

const { ClaudeAgentService } = await import('../dist/domains/cats/services/agents/providers/ClaudeAgentService.js');
const { boundClaudeCacheRetentionArgs } = await import(
  '../dist/domains/cats/services/agents/providers/claude-cache-retention-replay.js'
);
ensureFakeCliOnPath('claude');

test('F338: the bounded fork budget includes inherited long-parent spend and replaces caller overrides', () => {
  const args = [
    '--model',
    'claude-sonnet-5-5',
    '--max-budget-usd',
    '500',
    '--max-turns=999',
    '--resume',
    'wrong',
    '--continue',
  ];
  boundClaudeCacheRetentionArgs(args, 'parent');
  assert.equal(args.filter((arg) => arg === '--max-budget-usd').length, 1);
  assert.equal(args[args.indexOf('--max-budget-usd') + 1], '2');
  assert.equal(args[args.indexOf('--max-turns') + 1], '1');
  assert.equal(args[args.indexOf('--resume') + 1], 'parent');
  assert.ok(args.includes('--fork-session'));
  assert.ok(!args.includes('--continue'));
  assert.deepEqual(args.slice(0, 2), ['--model', 'claude-sonnet-5-5']);
});

test('F338: retention forks the parent and replays the last actual native instructions, without compiling current L0', async () => {
  const proc = createMockProcess();
  let launched;
  const spawnFn = mock.fn((_command, args, options) => {
    launched = {
      args,
      env: options.env,
      l0: readFileSync(args[args.indexOf('--system-prompt-file') + 1], 'utf8'),
      append: readFileSync(args[args.indexOf('--append-system-prompt-file') + 1], 'utf8'),
      settings: JSON.parse(readFileSync(args[args.indexOf('--settings') + 1], 'utf8')),
    };
    return proc;
  });
  const l0CompilerFn = mock.fn(buildFakeL0Compiler('CURRENT L0 MUST NOT REPLACE THE PARENT PREFIX'));
  const service = new ClaudeAgentService({ catId: 'sonnet', model: 'claude-sonnet-5-5', spawnFn, l0CompilerFn });
  const promise = collect(
    service.invoke('Reply OK.', {
      sessionId: '00000000-0000-4000-8000-000000000001',
      invocationId: '00000000-0000-4000-8000-000000000003',
      systemPrompt: 'CURRENT APPEND MUST NOT REPLACE THE PARENT PREFIX',
      callbackEnv: {
        CAT_CAFE_API_URL: 'http://127.0.0.1:3314',
        CAT_CAFE_INVOCATION_ID: '00000000-0000-4000-8000-000000000003',
        CAT_CAFE_CALLBACK_TOKEN: randomUUID(),
        CAT_CAFE_MCP_TRANSPORT: 'stdio',
      },
      frozenNativeMcpConfig: {
        servers: { 'retained-tools': { command: process.execPath, args: ['fixture-server.mjs'] } },
        source: 'capabilities.json',
        pluginMcpServerNames: [],
        catCafeMcpServerNames: [],
      },
      toolExecutionPolicy: { mode: 'callback_allowlist', allowedCallbackRoutes: [] },
      cacheRetentionReplay: {
        sourceInvocationId: '00000000-0000-4000-8000-000000000002',
        nativeSystemPrompt: 'FROZEN PARENT L0',
        appendSystemPrompt: 'FROZEN PARENT APPEND',
      },
    }),
  );
  await emitEvents(proc, [{ type: 'result', subtype: 'success' }]);
  await promise;
  assert.ok(
    launched.args.includes('--fork-session'),
    'a retention request must fork instead of appending to the parent',
  );
  assert.equal(l0CompilerFn.mock.callCount(), 0, 'mutable L0 must not be recompiled');
  assert.equal(launched.l0, 'FROZEN PARENT L0');
  assert.equal(launched.append, 'FROZEN PARENT APPEND');
  assert.equal(launched.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
  assert.equal(launched.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS, '1');
  assert.ok(
    launched.settings.hooks.PreToolUse.some((group) => group.matcher === '*' && group.hooks.length > 0),
    'all native and MCP tool execution must be denied without removing tool schemas',
  );
  const deny = launched.settings.hooks.PreToolUse.find((group) => group.matcher === '*');
  const output = JSON.parse(
    execFileSync('/bin/sh', ['-c', deny.hooks[0].command], {
      encoding: 'utf8',
      input: JSON.stringify({ tool_name: 'mcp__fixture__write' }),
    }),
  );
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  assert.ok(
    !launched.args.includes('--tools'),
    'retention must not replace the original tool schemas with an empty set',
  );
});

test('F338: retention refuses the source turn credential and any callback grant before launch', async () => {
  const service = new ClaudeAgentService({
    model: 'claude-sonnet-5-5',
    spawnFn: () => assert.fail('rejected retention must never spawn'),
    l0CompilerFn: () => assert.fail('must reject before compilation'),
  });
  for (const allowedCallbackRoutes of [[], ['POST /api/callbacks/post-message']]) {
    await assert.rejects(
      collect(
        service.invoke('OK', {
          invocationId: 'same-turn',
          sessionId: 'parent',
          callbackEnv: { CAT_CAFE_INVOCATION_ID: 'same-turn', CAT_CAFE_CALLBACK_TOKEN: 'fixture' },
          toolExecutionPolicy: { mode: 'callback_allowlist', allowedCallbackRoutes },
          cacheRetentionReplay: {
            sourceInvocationId: allowedCallbackRoutes.length === 0 ? 'same-turn' : 'different-source-turn',
            nativeSystemPrompt: 'parent-prefix',
          },
        }),
      ),
      /independent_denied_principal_required/,
    );
  }
});
