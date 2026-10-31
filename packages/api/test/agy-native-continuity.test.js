import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const { AgyNativeAgentService } = await import(
  '../dist/domains/cats/services/agents/providers/agy-native/AgyNativeAgentService.js'
);
const { SessionChainStore } = await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'f325-continuity-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const profile = {
    enabled: true,
    profileId: 'gemini38',
    homeRoot: join(root, 'profiles'),
    model: 'gemini-3.8-flash-high',
    trustedWorkspaces: [workspace],
  };
  const service = (body = '# Identity\nYou are the continuity test cat.') =>
    new AgyNativeAgentService({
      catId: 'gemini38',
      profile,
      command: '/usr/bin/true',
      l0CompilerFn: async () => body,
    });
  const launches = [];
  const spawn = async function* (launch) {
    launches.push(launch);
    const resumed = launch.args.indexOf('--conversation');
    const id = resumed >= 0 ? launch.args[resumed + 1] : `native-${launches.length}`;
    yield {
      event: 'init',
      conversation_id: id,
      init: {
        cwd: launch.cwd,
        agent: launch.args[launch.args.indexOf('--agent') + 1],
        model: profile.model,
        permission_mode: 'request-review',
        tools: [],
      },
    };
    yield {
      event: 'result',
      result: {
        conversation_id: id,
        status: 'SUCCESS',
        response: 'Complete.',
        denied_actions: [],
        num_turns: 1,
      },
    };
  };
  const invoke = async (instance, patch = {}) => {
    const messages = [];
    for await (const message of instance.invoke('Continue the work.', {
      workingDirectory: workspace,
      spawnCliOverride: spawn,
      ...patch,
    }))
      messages.push(message);
    return messages;
  };
  return {
    root,
    workspace,
    profile,
    service,
    launches,
    spawn,
    invoke,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('Native continuity survives service reconstruction using the canonical session record', async () => {
  const f = fixture();
  try {
    const first = await f.invoke(f.service());
    const init = first.find((message) => message.type === 'session_init');
    assert.ok(init.nativeSessionBinding, 'verified init must expose a durable native binding');
    assert.equal(init.nativeSessionBinding.cliSessionId, init.sessionId);
    assert.equal(init.nativeSessionBinding.body, undefined, 'do not persist the full private L0');
    const store = new SessionChainStore();
    const record = await store.create({ catId: 'gemini38', threadId: 'continuity', userId: 'owner' });
    await store.update(record.id, { nativeSessionBinding: init.nativeSessionBinding });
    const restored = JSON.parse(JSON.stringify(await store.get(record.id)));
    const second = await f.invoke(f.service(), {
      sessionId: init.sessionId,
      nativeSessionBinding: restored.nativeSessionBinding,
      requireExactResume: true,
    });
    assert.equal(second.at(-1).errorCode, undefined, JSON.stringify(second));
    assert.equal(second[0].sessionId, init.sessionId);
    assert.ok(f.launches[1].args.includes('--conversation'));
  } finally {
    f.cleanup();
  }
});

test('Native exact resume refuses missing or changed binding before spawning', async () => {
  const f = fixture();
  try {
    const first = await f.invoke(f.service());
    const init = first.find((message) => message.type === 'session_init');
    for (const patch of [
      {},
      { nativeSessionBinding: { ...init.nativeSessionBinding, l0Hash: 'changed' } },
      { nativeSessionBinding: { ...init.nativeSessionBinding, profileHome: '/another/profile' } },
      { nativeSessionBinding: { ...init.nativeSessionBinding, cliSessionId: 'another-session' } },
    ]) {
      const result = await f.invoke(f.service(), { sessionId: init.sessionId, requireExactResume: true, ...patch });
      assert.equal(result.at(-1).errorCode, 'AGY_NATIVE_RESUME_MISMATCH', JSON.stringify(result));
    }
    assert.equal(f.launches.length, 1, 'no replacement may silently launch');
  } finally {
    f.cleanup();
  }
});

test('Native refuses a provider that substitutes a fresh conversation during exact resume', async () => {
  const f = fixture();
  try {
    const first = await f.invoke(f.service());
    const init = first.find((message) => message.type === 'session_init');
    const result = await f.invoke(f.service(), {
      sessionId: init.sessionId,
      nativeSessionBinding: init.nativeSessionBinding,
      requireExactResume: true,
      spawnCliOverride: async function* (launch) {
        for await (const frame of f.spawn(launch)) {
          if (frame.event === 'init') frame.conversation_id = 'unexpected-replacement';
          yield frame;
        }
      },
    });
    assert.equal(result.at(-1).errorCode, 'AGY_NATIVE_RESUME_MISMATCH');
    assert.equal(
      result.some((message) => message.type === 'session_init'),
      false,
    );
  } finally {
    f.cleanup();
  }
});

test('two service instances cannot rewrite an active profile while its provider is running', async () => {
  const f = fixture();
  let release;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  const first = f.service().invoke('Keep working.', {
    workingDirectory: f.workspace,
    spawnCliOverride: async function* (launch) {
      for await (const frame of f.spawn(launch)) {
        yield frame;
        if (frame.event === 'init') await barrier;
      }
    },
  });
  let second;
  const cancel = new AbortController();
  try {
    assert.equal((await first.next()).value.type, 'session_init');
    second = f.invoke(f.service(), { toolExecutionPolicy: { mode: 'read_only' }, signal: cancel.signal });
    await new Promise(setImmediate);
    assert.equal(f.launches.length, 1);
    cancel.abort();
    const events = await second;
    assert.equal(
      events.at(-1).errorCode,
      'AGY_CANCELLED',
      'queued cancellation must complete while the holder remains active',
    );
  } finally {
    release();
    for await (const _message of first) {
      /* finish the owned provider */
    }
    await second;
    f.cleanup();
  }
});

test('Native delivers uploaded image and file references with actual read access instead of dropping attachments', async () => {
  const f = fixture();
  const uploadDir = join(f.root, 'uploads');
  mkdirSync(uploadDir);
  writeFileSync(join(uploadDir, 'sample.png'), 'fixture');
  writeFileSync(join(uploadDir, 'notes.txt'), 'user notes');
  try {
    const result = await f.invoke(f.service(), {
      uploadDir,
      contentBlocks: [
        { type: 'image', url: '/uploads/sample.png' },
        { type: 'file', url: '/uploads/notes.txt', fileName: 'Notes', mimeType: 'text/plain', fileSize: 10 },
      ],
    });
    assert.equal(result.at(-1).errorCode, undefined, JSON.stringify(result));
    const launch = f.launches[0];
    const input = JSON.parse(launch.stdinInput);
    assert.ok(input.message.content[0].text.includes(join(uploadDir, 'sample.png')));
    assert.ok(input.message.content[0].text.includes(join(uploadDir, 'notes.txt')));
    assert.ok(
      launch.args.includes(realpathSync(uploadDir)),
      'the uploaded bytes must be accessible to the native file tool',
    );
    assert.ok(
      input.message.content.every((block) => block.type === 'text'),
      'headless input accepts text blocks only',
    );
  } finally {
    f.cleanup();
  }
});
