import type { InvocationTrajectorySummary } from '@cat-cafe/shared';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { useExecutionBindings } from '../useExecutionBindings';
import { fixtureData } from './chat-fixture';
import { act, cleanup, renderHook, waitFor } from './hook-host';
import { useOwnerProjection } from './owner-console';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn(), API_URL: 'https://api.test' }));
const summary = (): InvocationTrajectorySummary => ({
  invocationId: 'child-owner',
  sessionId: 'foreign-session',
  sessionSeq: 2,
  sessionStatus: 'active',
  threadId: 'foreign-thread',
  catId: 'codex',
  status: 'running',
  startedAt: 1,
  durationMs: 2,
  eventCount: 1,
  statusEventCount: 0,
  toolUseCount: 0,
  toolResultCount: 0,
  messageCount: 1,
  errorCount: 0,
  toolNames: [],
  keyMessages: ['Foreign owner run'],
});
const response = (value: unknown) => new Response(JSON.stringify(value));
let calls: string[], wrongList: boolean, wrongDetail: boolean;
beforeEach(() => {
  calls = [];
  wrongList = wrongDetail = false;
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    const p = String(path);
    calls.push(p);
    if (p.includes('/invocations/'))
      return response({
        invocationId: 'child-owner',
        summary: { ...summary(), ...(wrongDetail ? { threadId: 'unrelated' } : {}) },
        total: 1,
        events: [
          {
            v: 1,
            t: 1,
            threadId: 'foreign-thread',
            sessionId: 'foreign-session',
            catId: 'codex',
            invocationId: 'child-owner',
            eventNo: 1,
            event: { type: 'text', content: 'Foreign canonical output' },
          },
        ],
      });
    if (p.startsWith('/api/threads/foreign-thread/invocations?'))
      return response({
        invocations: [{ ...summary(), ...(wrongList ? { catId: 'unrelated' } : {}) }],
        total: 1,
      });
    if (p.endsWith('/sessions') || p.startsWith('/api/external-runtime-sessions')) return response({ sessions: [] });
    if (p.startsWith('/api/threads/pdl-test/invocations?')) return response({ invocations: [], total: 0 });
    throw new Error('Unexpected execution owner ' + p);
  });
});
afterEach(async () => {
  await cleanup();
  vi.resetAllMocks();
});
async function ready() {
  const data = fixtureData();
  data.executions = [
    {
      executionId: 'parent-control',
      turnInvocationId: 'child-owner',
      threadId: 'foreign-thread',
      threadTitle: 'Foreign owner',
      catId: 'codex',
      kind: 'live_invocation',
      startedAt: 1,
      cancelability: {
        state: 'cancelable',
        target: { kind: 'live_invocation', executionId: 'parent-control', catId: 'codex', threadId: 'foreign-thread' },
      },
    },
  ];
  const state = { tjMode: 'timeline' };
  const hook = renderHook(() =>
    useOwnerProjection('execution', useExecutionBindings(data, state, true), { data, ws: state }),
  );
  await waitFor(() => expect(hook.result.current.project('').load).toBe(''));
  return { ...hook, data };
}
it('opens the exact live child across threads and can refresh it after the live control disappears', async () => {
  const { result, data } = await ready();
  await act(() => result.current.action('execOpen', { v: 'child-owner' }));
  expect(result.current.project('')).toMatchObject({
    run: {
      id: 'child-owner',
      who: 'codex',
      title: 'Foreign owner run',
      rawRecords: expect.arrayContaining([
        expect.objectContaining({ event: { type: 'text', content: 'Foreign canonical output' } }),
      ]),
    },
  });
  expect(calls).toContain('/api/threads/foreign-thread/invocations?limit=500');
  expect(calls).toContain('/api/sessions/foreign-session/invocations/child-owner');
  expect(data.threadId).toBe('pdl-test');
  data.executions = [];
  await act(() => result.current.action('refresh', { k: 'exec' }));
  expect(calls.filter((p) => p === '/api/sessions/foreign-session/invocations/child-owner')).toHaveLength(2);
  expect(calls.some((p) => p.includes('/invocations/parent-control'))).toBe(false);
});
it.each([
  'list',
  'detail',
])('rejects a mismatched foreign %s owner without showing another invocation', async (where) => {
  const { result } = await ready();
  wrongList = where === 'list';
  wrongDetail = where === 'detail';
  await act(async () => {
    await expect(result.current.action('execOpen', { v: 'child-owner' })).rejects.toThrow('运行来源不一致');
  });
  expect(result.current.project('')).not.toHaveProperty('run');
});
