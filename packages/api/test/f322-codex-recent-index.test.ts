import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listCodexImportSessions } from '../src/domains/cats/services/agents/providers/CodexLocalSessionSource.js';

const row = (n: number, source: string, originator: string | null, updatedAt: number) => ({
  id: `019aaaaa-1111-7111-8111-${String(n).padStart(12, '0')}`,
  cwd: '/original',
  source,
  originator,
  updatedAt,
  preview: originator === 'cat-cafe' || source === 'exec' ? '你是咱们的图书管理员' : `User conversation ${n}`,
  turns: [],
});

test('CLI conversations remain visible when newer exec and cafe Desktop rows fill the mixed recent window', async () => {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const dataset = [
    ...Array.from({ length: 60 }, (_, n) => row(n + 1, 'exec', 'codex_exec', 2000 - n)),
    ...Array.from({ length: 60 }, (_, n) => row(n + 101, 'vscode', 'cat-cafe', 1000 - n)),
    ...Array.from({ length: 12 }, (_, n) => row(n + 201, 'cli', n % 2 ? null : 'codex-tui', 100 - n)),
    ...Array.from({ length: 8 }, (_, n) => row(n + 301, 'vscode', 'Codex Desktop', 200 - n)),
  ].sort((a, b) => b.updatedAt - a.updatedAt);
  const result = await listCodexImportSessions(
    {
      request: async (method, params) => {
        calls.push({ method, params });
        const kinds = params.sourceKinds as string[];
        const filtered = dataset.filter((r) => kinds.includes(r.source));
        const start = Number(params.cursor ?? 0);
        const pageSize = params.limit as number;
        return {
          data: filtered.slice(start, start + pageSize),
          nextCursor: start + pageSize < filtered.length ? String(start + pageSize) : null,
        };
      },
    },
    20,
  );
  assert.equal(result.sessions.length, 20);
  assert.ok(result.sessions.every((s) => s.firstPrompt.startsWith('User conversation')));
  assert.equal(
    result.sessions.filter((s) => s.sessionId.endsWith('000000000201') || s.sessionId.endsWith('000000000202')).length,
    2,
  );
  assert.equal(result.sessions[0].firstPrompt, 'User conversation 301');
  assert.equal(result.sessions[0].lastActivityAt, 200000);
  assert.ok(calls.every((c) => c.method === 'thread/list' && c.params.useStateDbOnly === true));
  assert.ok(calls.every((c) => !(c.params.sourceKinds as string[]).includes('exec')));
  assert.equal(calls.filter((c) => (c.params.sourceKinds as string[]).includes('cli')).length, 1);
  assert.equal(calls.filter((c) => (c.params.sourceKinds as string[]).includes('vscode')).length, 2);
  assert.equal(result.sessions[0].turnCount, null);
  assert.equal(result.limited, false);
});

test('Desktop flood cannot consume the independent CLI page; Desktop lookup stops at four pages', async () => {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const result = await listCodexImportSessions(
    {
      request: async (method, params) => {
        calls.push({ method, params });
        if ((params.sourceKinds as string[]).join() === 'cli')
          return { data: [row(1, 'cli', null, 1)], nextCursor: null };
        return {
          data: Array.from({ length: 50 }, (_, n) => row(n + 101, 'vscode', 'cat-cafe', 100)),
          nextCursor: String(calls.length),
        };
      },
    },
    20,
  );
  assert.equal(calls.length, 5);
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].firstPrompt, 'User conversation 1');
  assert.equal(result.limited, true);
});

test('separate native pages deduplicate IDs and sort their combined visible limit by activity', async () => {
  const result = await listCodexImportSessions(
    {
      request: async (_method, params) =>
        (params.sourceKinds as string[]).join() === 'cli'
          ? { data: [row(1, 'cli', 'codex-tui', 10), row(2, 'cli', null, 9)], nextCursor: 'more-cli' }
          : { data: [row(1, 'vscode', 'Codex Desktop', 11), row(3, 'vscode', 'Codex Desktop', 12)], nextCursor: null },
    },
    2,
  );
  assert.deepEqual(
    result.sessions.map((s) => s.firstPrompt),
    ['User conversation 3', 'User conversation 1'],
  );
  assert.equal(result.sessions[1].lastActivityAt, 11000);
  assert.equal(result.limited, true);
});

test('Cafe first-input envelopes are excluded even when Desktop is the recorded originator', async () => {
  const cafe = { ...row(1, 'vscode', 'Codex Desktop', 100), preview: '<runtime-routing-context> clipped' };
  const external = { ...row(2, 'vscode', 'Codex Desktop', 90), preview: 'Explain the runtime-routing-context tag' };
  const result = await listCodexImportSessions(
    {
      request: async (_method, params) => ({
        data: (params.sourceKinds as string[]).includes('cli') ? [] : [cafe, external],
        nextCursor: null,
      }),
    },
    1,
  );
  assert.deepEqual(
    result.sessions.map((s) => s.sessionId),
    [external.id],
  );
  assert.equal(result.sessions[0].firstPrompt, external.preview);
});
