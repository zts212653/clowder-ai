import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectCodexImportSession } from '../src/domains/cats/services/agents/providers/CodexLocalSessionSource.js';

test('import requires the exact native resume and never requests history or starts a thread', async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const info = await inspectCodexImportSession(
    {
      request: async (method, params) => {
        calls.push({ method, params });
        return { thread: { id: 's', cwd: '/project', preview: 'fix session import', updatedAt: 123 } };
      },
    },
    's',
  );
  assert.equal(info.projectPath, '/project');
  assert.deepEqual(
    calls.map((c) => c.method),
    ['thread/read', 'thread/resume'],
  );
  assert.equal(calls[0].params.includeTurns, false);
  assert.equal(calls[1].params.excludeTurns, true);
});

test('active writer returns a typed failure without starting a replacement', async () => {
  const calls: string[] = [];
  await assert.rejects(
    inspectCodexImportSession(
      {
        request: async (method) => {
          calls.push(method);
          if (method === 'thread/resume') throw new Error('thread s already has an active writer');
          return { thread: { id: 's', cwd: '/project', preview: 'first', updatedAt: 123 } };
        },
      },
      's',
    ),
    (error) => (error as { code?: string }).code === 'SESSION_ACTIVE_WRITER',
  );
  assert.equal(calls.includes('thread/start'), false);
});

test('not found and wrong resume ID fail closed', async () => {
  for (const mode of ['missing', 'mismatch']) {
    await assert.rejects(
      inspectCodexImportSession(
        {
          request: async (method) => {
            if (method === 'thread/resume') {
              if (mode === 'missing') throw new Error('no rollout found for thread id s');
              return { thread: { id: 'different' } };
            }
            return { thread: { id: 's', cwd: '/project', preview: 'first', updatedAt: 123 } };
          },
        },
        's',
      ),
    );
  }
});
