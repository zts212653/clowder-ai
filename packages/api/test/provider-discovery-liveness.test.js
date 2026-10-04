import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { discoverAntigravityLS } from '../dist/domains/cats/services/agents/providers/antigravity/antigravity-ls-discovery.js';
import { createMemoizedHostVersionProbe } from '../dist/domains/cats/services/agents/providers/mcp-schema-delivery-capability.js';

test('R10: concurrent cold host versions await one asynchronous probe', async () => {
  let calls = 0;
  const probe = createMemoizedHostVersionProbe(async () => {
    calls++;
    await delay(30);
    return 'codex-cli 0.149.1';
  });
  const results = await Promise.all([probe('codex'), probe('codex')]);
  assert.deepEqual(results, ['0.149.1', '0.149.1']);
  assert.equal(calls, 1);
});
test('R10: AGY discovery awaits process and port lookups without changing TLS fallback', async () => {
  const keys = ['ANTIGRAVITY_PORT', 'ANTIGRAVITY_CSRF_TOKEN', 'ANTIGRAVITY_TLS'];
  const previous = keys.map((key) => process.env[key]);
  for (const key of keys) delete process.env[key];
  const attempts = [];
  try {
    const result = await discoverAntigravityLS({
      listProcesses: async () => {
        await delay(20);
        return [{ pid: '123', cmd: 'language_server --csrf_token secret --extension_server_port 8001' }];
      },
      listListenPorts: async () => {
        await delay(20);
        return [8001, 8002];
      },
      probe: async (connection) => {
        attempts.push(connection.useTls);
        if (connection.useTls) throw new Error('plain only');
      },
    });
    assert.deepEqual(result, { port: 8002, csrfToken: 'secret', useTls: false });
    assert.deepEqual(attempts, [true, false]);
  } finally {
    for (const [index, key] of keys.entries()) {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    }
  }
});
test(
  'R10: AGY finds its process after more than one MiB of unrelated process arguments',
  { skip: process.platform === 'win32' },
  async () => {
    const { mkdtemp, writeFile, chmod, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { listProcessesViaPs } = await import(
      '../dist/domains/cats/services/agents/providers/antigravity/antigravity-ls-discovery.js'
    );
    const root = await mkdtemp(join(tmpdir(), 'agy-process-output-'));
    const previousPath = process.env.PATH;
    try {
      const script = join(root, 'ps');
      await writeFile(
        script,
        `#!${process.execPath}\nprocess.stdout.write(('777 unrelated-process '+ 'x'.repeat(1000) +'\\n').repeat(2200)); process.stdout.write('123 language_server --csrf_token fixture-token\\n');\n`,
      );
      await chmod(script, 0o755);
      process.env.PATH = `${root}:${previousPath}`;
      assert.deepEqual(await listProcessesViaPs(), [{ pid: '123', cmd: 'language_server --csrf_token fixture-token' }]);
    } finally {
      process.env.PATH = previousPath;
      await rm(root, { recursive: true, force: true });
    }
  },
);
