import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CodexAppServerClient,
  type CodexAppServerRunInput,
} from '../src/domains/cats/services/agents/providers/CodexAppServerClient.js';
import { wireFixture } from './helpers/f317-live-wire-fixture.mjs';

async function runScope(input: {
  cwd?: string;
  resume?: boolean;
  missingStoredCwd?: boolean;
  foreignStoredId?: boolean;
}) {
  const f = wireFixture();
  const originalWrite = f.wire.write;
  const storedThread = {
    id: input.foreignStoredId ? 'foreign' : 'native',
    ...(input.missingStoredCwd ? {} : { cwd: '/stored/runtime/packages/api' }),
  };
  f.wire.write = async (message) => {
    if (message.method === 'config/read') {
      f.writes.push(message);
      const servers =
        message.params.cwd === '/stored/runtime/packages/api'
          ? {
              'cat-cafe': { enabled: true },
              'unapproved-project': { enabled: true },
              'unapproved-global': { enabled: true },
            }
          : { 'unapproved-global': { enabled: true } };
      f.push({ id: message.id, result: { config: { mcp_servers: servers } } });
    } else if (message.method === 'thread/read') {
      f.writes.push(message);
      f.push({
        id: message.id,
        result: {
          thread: storedThread,
        },
      });
    } else if (message.method === 'thread/resume') {
      f.writes.push(message);
      f.push({ id: message.id, result: { thread: { id: 'native' } } });
    } else await originalWrite(message);
  };
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const client = new CodexAppServerClient({ wire: f.wire });
  const request: CodexAppServerRunInput = {
    live: {
      finished,
      observe: async () => {},
      ready: async () => {
        finish();
      },
    },
    prompt: { kind: 'frozen', prompt: 'synthetic scope check' },
    thread: input.resume ? { kind: 'resume', threadId: 'native' } : { kind: 'start' },
    ...(input.cwd ? { cwd: input.cwd } : {}),
    sandbox: 'read-only',
    approvalPolicy: 'never',
    config: { mcp_servers: { 'cat-cafe-collab': { enabled: true }, 'cat-cafe-memory': { enabled: true } } },
  };
  let error: unknown;
  try {
    for await (const _event of client.run(request)) {
      /* Drain the real adapter. */
    }
  } catch (caught) {
    error = caught;
  }
  return { f, error };
}

test('Live reads the resumed native cwd before disabling ambient project MCP servers', { timeout: 5000 }, async () => {
  const { f, error } = await runScope({ resume: true });
  assert.equal(error, undefined);
  const scoped = f.writes.find((m) => m.method === 'config/read' && m.params.cwd === '/stored/runtime/packages/api');
  assert.ok(scoped, 'global-only config/read omits the legacy cat-cafe server in the native project');
  const resumed = f.writes.find((m) => m.method === 'thread/resume');
  assert.equal(resumed.params.cwd, '/stored/runtime/packages/api');
  assert.equal(resumed.params.config.mcp_servers['cat-cafe'].enabled, false);
  assert.equal(resumed.params.config.mcp_servers['unapproved-project'].enabled, false);
  assert.equal(resumed.params.config.mcp_servers['unapproved-global'].enabled, false);
  assert.equal(resumed.params.config.mcp_servers['cat-cafe-collab'].enabled, true);
  assert.equal(resumed.params.config.mcp_servers['cat-cafe-memory'].enabled, true);
  assert.equal(resumed.params.config['features.shell_tool'], false);
  assert.equal(resumed.params.config['apps._default.enabled'], false);
  assert.equal(resumed.params.approvalPolicy, 'never');
  assert.equal(resumed.params.sandbox, 'read-only');
});

test('an explicit Live cwd is the same scope used for configuration and native start', { timeout: 5000 }, async () => {
  const { f, error } = await runScope({ cwd: '/stored/runtime/packages/api' });
  assert.equal(error, undefined);
  assert.equal(
    f.writes.some((m) => m.method === 'thread/read'),
    false,
  );
  assert.ok(f.writes.some((m) => m.method === 'config/read' && m.params.cwd === '/stored/runtime/packages/api'));
  assert.equal(f.writes.find((m) => m.method === 'thread/start').params.cwd, '/stored/runtime/packages/api');
});

test(
  'an unresolved resumed cwd fails before admission instead of guessing a global tool surface',
  { timeout: 5000 },
  async () => {
    const { f, error } = await runScope({ resume: true, missingStoredCwd: true });
    assert.ok(error instanceof Error);
    assert.match(error.message, /Live native cwd unavailable/);
    assert.equal(
      f.writes.some((m) => ['thread/resume', 'turn/start'].includes(m.method)),
      false,
    );
  },
);

test('a foreign native metadata id cannot supply the Live configuration scope', { timeout: 5000 }, async () => {
  const { f, error } = await runScope({ resume: true, foreignStoredId: true });
  assert.ok(error instanceof Error);
  assert.match(error.message, /Live native cwd unavailable/);
  assert.equal(
    f.writes.some((m) => ['config/read', 'thread/resume', 'turn/start'].includes(m.method)),
    false,
  );
});

test('a fresh Live thread uses the actual process cwd for both config and start', { timeout: 5000 }, async () => {
  const { f, error } = await runScope({});
  assert.equal(error, undefined);
  assert.equal(f.writes.find((m) => m.method === 'config/read').params.cwd, process.cwd());
  assert.equal(f.writes.find((m) => m.method === 'thread/start').params.cwd, process.cwd());
});
