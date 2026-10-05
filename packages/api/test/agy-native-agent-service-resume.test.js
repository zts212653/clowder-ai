import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

const { AgyNativeAgentService } = await import(
  '../dist/domains/cats/services/agents/providers/agy-native/AgyNativeAgentService.js'
);

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'f325-agy-resume-'));
  const workspace = join(base, 'workspace');
  mkdirSync(workspace);
  let nativeBody = '# Identity\nL0-v1\n';
  const service = new AgyNativeAgentService({
    catId: 'gemini38',
    profile: {
      enabled: true,
      profileId: 'gemini38',
      homeRoot: join(base, 'profiles'),
      model: 'gemini-3.8-flash-high',
      trustedWorkspaces: [workspace],
    },
    command: '/usr/bin/true',
    l0CompilerFn: async () => nativeBody,
  });
  return {
    base,
    workspace,
    service,
    setNativeBody: (body) => {
      nativeBody = body;
    },
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

async function collect(iterable) {
  const result = [];
  for await (const event of iterable) result.push(event);
  return result;
}

function fakeSpawn(launches, conversationId, model = 'gemini-3.8-flash-high') {
  return async function* (options) {
    launches.push(options);
    const agent = options.args[options.args.indexOf('--agent') + 1];
    const cwd = options.cwd;
    yield {
      event: 'init',
      conversation_id: conversationId,
      init: { agent, cwd, model, permission_mode: 'request-review', tools: [] },
    };
    yield {
      event: 'result',
      result: { conversation_id: conversationId, status: 'SUCCESS', response: 'OK\n', num_turns: 1 },
    };
  };
}

describe('F325 native AGY session binding', () => {
  test('resumes only when workspace and L0 fingerprint are unchanged', async () => {
    const f = fixture();
    try {
      const launches = [];
      const first = await collect(
        f.service.invoke('one', {
          workingDirectory: f.workspace,
          systemPrompt: '# Identity\nL0-v1\n',
          spawnCliOverride: fakeSpawn(launches, 'session-one'),
        }),
      );
      assert.equal(first.at(-1).errorCode, undefined);
      const second = await collect(
        f.service.invoke('two', {
          workingDirectory: f.workspace,
          sessionId: 'session-one',
          spawnCliOverride: fakeSpawn(launches, 'session-one'),
        }),
      );
      assert.equal(second.at(-1).errorCode, undefined);
      assert.deepEqual(launches[1].args.slice(-2), ['--conversation', 'session-one']);
      assert.equal(
        launches[1].args[launches[1].args.indexOf('--agent') + 1],
        launches[0].args[launches[0].args.indexOf('--agent') + 1],
      );

      f.setNativeBody('# Identity\nL0-v2\n');
      const third = await collect(
        f.service.invoke('three', {
          workingDirectory: f.workspace,
          sessionId: 'session-one',
          systemPrompt: '# Identity\nL0-v2\n',
          spawnCliOverride: fakeSpawn(launches, 'session-three'),
        }),
      );
      assert.equal(third.at(-1).errorCode, undefined);
      assert.ok(!launches[2].args.includes('--conversation'));
      assert.notEqual(
        launches[2].args[launches[2].args.indexOf('--agent') + 1],
        launches[0].args[launches[0].args.indexOf('--agent') + 1],
      );
    } finally {
      f.cleanup();
    }
  });

  test('rejects an init that silently selects another model', async () => {
    const f = fixture();
    try {
      const events = await collect(
        f.service.invoke('hello', {
          workingDirectory: f.workspace,
          systemPrompt: '# Identity\nL0-v1\n',
          spawnCliOverride: fakeSpawn([], 'wrong-model-session', 'another-model'),
        }),
      );
      assert.deepEqual(
        events.map((event) => event.type),
        ['error', 'done'],
      );
      assert.equal(events[0].errorCode, 'AGY_NATIVE_PREFLIGHT');
      assert.match(events[0].error, /model/i);
    } finally {
      f.cleanup();
    }
  });
});
