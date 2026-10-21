import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ensureFakeCliOnPath } from './helpers/fake-cli-path.js';
import { fakeL0Compiler } from './helpers/fake-l0-compiler.js';

ensureFakeCliOnPath('claude');
ensureFakeCliOnPath('codex');
ensureFakeCliOnPath('agy');
ensureFakeCliOnPath('opencode');

const POLICY = {
  mode: 'read_only',
  replayDeniedToolNames: ['mcp__cat-cafe-collab__cat_cafe_post_message'],
};

async function collect(iterable) {
  const messages = [];
  for await (const message of iterable) messages.push(message);
  return messages;
}

describe('F254 provider-native read-only enforcement', () => {
  it('Claude disables all tools, ignores MCP config, and cannot be overridden by member CLI args', async () => {
    const { ClaudeAgentService } = await import('../dist/domains/cats/services/agents/providers/ClaudeAgentService.js');
    let captured;
    const service = new ClaudeAgentService({
      catId: 'opus',
      model: 'claude-test-model',
      l0CompilerFn: async ({ outPath }) => {
        writeFileSync(outPath, 'test L0', 'utf8');
        return 'test L0';
      },
    });
    await collect(
      service.invoke('supplement check', {
        toolExecutionPolicy: POLICY,
        callbackEnv: { CAT_CAFE_READONLY: 'true' },
        accountEnv: { CAT_CAFE_READONLY: 'false' },
        cliConfigArgs: ['--permission-mode bypassPermissions --tools default --mcp-config unsafe.json'],
        spawnCliOverride: async function* (options) {
          captured = options;
          yield { type: 'result', subtype: 'success' };
        },
      }),
    );

    assert.equal(service.supportsToolExecutionPolicy(POLICY), true);
    const args = captured.args;
    assert.equal(args[args.indexOf('--permission-mode') + 1], 'plan');
    assert.equal(args[args.indexOf('--tools') + 1], '');
    assert.ok(args.includes('--strict-mcp-config'));
    assert.equal(args.includes('--chrome'), false);
    assert.equal(args.includes('bypassPermissions'), false);
    assert.equal(args.includes('default'), false);
    assert.equal(args.includes('unsafe.json'), false);
    assert.equal(captured.env.CAT_CAFE_READONLY, 'true');
  });

  for (const inGitRepository of [false, true]) {
    for (const resume of [false, true]) {
      it(`Codex read-only ${resume ? 'resume' : 'exec'} supports ${inGitRepository ? 'Git' : 'non-Git'} workspaces without granting capabilities`, async (t) => {
        const workingDirectory = mkdtempSync(join(tmpdir(), 'codex-read-only-'));
        t.after(() => rmSync(workingDirectory, { recursive: true, force: true }));
        if (inGitRepository) mkdirSync(join(workingDirectory, '.git'));
        const { CodexAgentService } = await import(
          '../dist/domains/cats/services/agents/providers/CodexAgentService.js'
        );
        let captured;
        const service = new CodexAgentService({
          catId: 'codex-sol',
          model: 'gpt-test',
          carrierMode: 'exec_json',
          l0CompilerFn: fakeL0Compiler,
        });
        await collect(
          service.invoke('supplement check', {
            workingDirectory,
            ...(resume ? { sessionId: 'thread-codex-read-only' } : {}),
            toolExecutionPolicy: POLICY,
            callbackEnv: {
              CAT_CAFE_READONLY: 'true',
              CAT_CAFE_API_URL: 'http://127.0.0.1:3004',
              CAT_CAFE_INVOCATION_ID: 'inv-read-only',
              CAT_CAFE_CALLBACK_TOKEN: 'tok-read-only',
              CAT_CAFE_CAT_ID: 'codex-sol',
            },
            accountEnv: { CAT_CAFE_READONLY: 'false' },
            cliConfigArgs: ['--sandbox danger-full-access --config approval_policy="on-request"'],
            spawnCliOverride: async function* (options) {
              captured = options;
              yield { type: 'thread.started', thread_id: 'thread-codex-read-only' };
              yield { type: 'turn.completed' };
            },
          }),
        );

        assert.equal(service.supportsToolExecutionPolicy(POLICY), true);
        const args = captured.args;
        assert.equal(args.includes('--skip-git-repo-check'), !inGitRepository);
        if (resume) {
          assert.deepEqual(args.slice(0, 3), ['exec', 'resume', 'thread-codex-read-only']);
          assert.ok(args.includes('sandbox_mode="read-only"'));
          assert.equal(args.includes('--sandbox'), false);
        } else {
          assert.equal(args[0], 'exec');
          assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
        }
        assert.equal(args.includes('--add-dir'), false);
        assert.ok(args.includes('approval_policy="never"'));
        assert.equal(args.includes('approval_policy="on-request"'), false);
        assert.ok(args.includes('--ignore-user-config'));
        assert.ok(args.includes('mcp_servers={}'));
        assert.ok(args.includes('apps._default.enabled=false'));
        assert.equal(args.includes('danger-full-access'), false);
        assert.equal(
          args.some((arg) => arg.startsWith('mcp_servers.cat-cafe')),
          false,
        );
        assert.equal(captured.env.CAT_CAFE_READONLY, 'true');
      });
    }
  }

  it('OpenCode selects a pure read-only agent whose inline policy overrides project grants', async () => {
    const { OpenCodeAgentService } = await import(
      '../dist/domains/cats/services/agents/providers/OpenCodeAgentService.js'
    );
    let captured;
    const service = new OpenCodeAgentService({ catId: 'opencode', model: 'test/model' });
    await collect(
      service.invoke('supplement check', {
        toolExecutionPolicy: POLICY,
        accountEnv: { CAT_CAFE_READONLY: 'false' },
        cliConfigArgs: ['--agent unsafe --auto'],
        spawnCliOverride: async function* (options) {
          captured = options;
          yield {
            type: 'step_start',
            sessionID: 'session-read-only',
            part: { type: 'step-start', id: 'part-1', sessionID: 'session-read-only', messageID: 'message-1' },
          };
          yield {
            type: 'step_finish',
            sessionID: 'session-read-only',
            part: { type: 'step-finish', reason: 'stop', tokens: { total: 1 } },
          };
        },
      }),
    );

    assert.equal(service.supportsToolExecutionPolicy(POLICY), true);
    const args = captured.args;
    assert.ok(args.includes('--pure'));
    assert.equal(args[args.indexOf('--agent') + 1], 'cat-cafe-read-only');
    assert.equal(args.includes('unsafe'), false);
    assert.equal(args.includes('--auto'), false);
    const inline = JSON.parse(captured.env.OPENCODE_CONFIG_CONTENT);
    assert.equal(inline.permission['*'], 'deny');
    assert.equal(inline.permission.read, 'allow');
    assert.equal(inline.permission.edit, 'deny');
    assert.deepEqual(inline.agent['cat-cafe-read-only'].permission, inline.permission);
    assert.equal(captured.env.CAT_CAFE_READONLY, 'true');
  });
});
