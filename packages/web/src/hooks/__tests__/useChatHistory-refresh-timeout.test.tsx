import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { beginBridge, flush, Host, release, root } from './reading-diagnostics-fixture';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
const { diagnostics } = vi.hoisted(() => ({ diagnostics: [] as Array<Record<string, unknown>> }));
vi.mock('@/utils/connection-diagnostics', async (original) => {
  const actual = await original<typeof import('@/utils/connection-diagnostics')>();
  return {
    ...actual,
    recordConnectionDiagnostic: (input: Parameters<typeof actual.recordConnectionDiagnostic>[0]) => {
      diagnostics.push(input);
      actual.recordConnectionDiagnostic(input);
    },
  };
});
vi.mock('@/utils/offline-store', () => ({
  loadThreadMessages: vi.fn().mockResolvedValue(null),
  saveThreadMessages: vi.fn().mockResolvedValue(undefined),
  loadThreadActiveState: vi.fn().mockResolvedValue(null),
  saveThreadActiveState: vi.fn().mockResolvedValue(undefined),
  loadThreadWorkspaceState: vi.fn().mockResolvedValue(null),
}));

const messages = [
  { id: 'reading', timestamp: 100, type: 'assistant', catId: 'opus', content: 'original reading' },
  { id: 'latest', timestamp: 200, type: 'assistant', catId: 'opus', content: 'fresh latest' },
];
const response = () => Response.json({ messages, hasMore: false });

async function pendingRead() {
  const pending: Array<(value: Response) => void> = [];
  const failures: Array<(reason: Error) => void> = [];
  const signals: Array<AbortSignal | null | undefined> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/session') return Response.json({ csrfToken: 'isolated-fixture' });
      if (path === '/api/diagnostics/connection') return new Response(null, { status: 204 });
      if (path !== '/api/messages') throw new Error('Unexpected test transport');
      signals.push(init?.signal);
      // Deliberately ignore abort: the real bounded API transport must fence a late response.
      return new Promise<Response>((resolve, reject) => {
        pending.push(resolve);
        failures.push(reject);
      });
    }),
  );
  const api = await vi.importActual<typeof import('@/utils/api-client')>('@/utils/api-client');
  const state = await beginBridge(api.apiFetch);
  await act(async () => {
    release();
    await Promise.resolve();
  });
  await flush();
  expect(pending).toHaveLength(1);
  return {
    ...state,
    pending,
    signals,
    failures,
    readingDiagnostics: () => diagnostics.filter((r) => r.kind === 'reading_restore'),
  };
}

async function timedOutRead() {
  const state = await pendingRead();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_014);
  });
  return state;
}

beforeEach(() => {
  diagnostics.length = 0;
  vi.resetModules();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('Settings refresh recovers one timed-out read inside its original owner', () => {
  it('keeps returning after the first real 30s timeout, then restores fresh text and exact anchor', async () => {
    const state = await timedOutRead();
    expect(state.signals[0]?.aborted).toBe(true);
    expect(state.pending).toHaveLength(2);
    expect(state.bridge.getSnapshot()).toMatchObject({
      returning: true,
      notice: null,
      source: { id: state.source.id },
    });
    await act(async () => {
      state.pending[1]?.(response());
      await vi.advanceTimersByTimeAsync(1);
    });
    await flush();
    await vi.waitFor(async () => {
      await flush();
      expect(state.bridge.getSnapshot().returning).toBe(false);
    });
    expect(state.top()).toBe(400);
    expect(state.bridge.getSnapshot()).toMatchObject({ returning: false, notice: null, source: null });
    expect(useChatStore.getState().messages.at(-1)?.content).toBe('fresh latest');
    await act(async () => {
      state.pending[0]?.(
        Response.json({ messages: [{ ...messages[0], content: 'late obsolete body' }], hasMore: false }),
      );
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(useChatStore.getState().messages.at(-1)?.content).toBe('fresh latest');
    const records = state.readingDiagnostics();
    expect(records.map((r) => r.phase)).toEqual(['start', 'complete']);
    expect(records.at(-1)).toMatchObject({ status: 'settled', exact: true });
    expect(new Set(records.map((r) => r.operationId)).size).toBe(1);
    state.checkDrafts();
  });

  it('stops after one additional timeout and preserves the source for an explicit retry', async () => {
    const state = await timedOutRead();
    expect(state.pending).toHaveLength(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_014);
    });
    expect(state.bridge.getSnapshot()).toMatchObject({
      returning: false,
      notice: 'unavailable',
      source: { id: state.source.id },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000);
    });
    expect(state.pending).toHaveLength(2);
    expect(state.readingDiagnostics().at(-1)).toMatchObject({ status: 'unavailable', readerMounted: true });
    state.checkDrafts();
  });

  it.each([
    'wheel',
    'unmount',
    'thread',
  ] as const)('retires %s immediately during the retry and ignores its late success', async (kind) => {
    const state = await timedOutRead();
    expect(state.pending).toHaveLength(2);
    await act(async () => {
      if (kind === 'wheel') state.el.dispatchEvent(new WheelEvent('wheel', { deltaY: -1 }));
      else if (kind === 'unmount') root.render(<Host visible={false} register={state.register} />);
      else {
        useChatStore.getState().setCurrentThread('other');
        root.render(<Host threadId="other" register={state.register} />);
      }
    });
    expect(state.bridge.getSnapshot().returning).toBe(false);
    expect(state.bridge.getSnapshot().source?.id).toBe(state.source.id);
    await act(async () => {
      state.pending[0]?.(response());
      state.pending[1]?.(response());
    });
    await flush();
    expect(state.bridge.getSnapshot().source?.id).toBe(state.source.id);
    state.checkDrafts();
  });

  it('does not start a retry after user input retired the first pending read', async () => {
    const state = await pendingRead();
    await act(async () => state.el.dispatchEvent(new WheelEvent('wheel', { deltaY: -1 })));
    expect(state.bridge.getSnapshot()).toMatchObject({ returning: false, notice: 'interrupted' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_100);
    });
    expect(state.pending).toHaveLength(1);
    expect(state.bridge.getSnapshot().source?.id).toBe(state.source.id);
  });

  it('does not retry permission failures or treat the cached page as a refreshed result', async () => {
    const state = await pendingRead();
    await act(async () => state.pending[0]?.(new Response(null, { status: 403 })));
    await flush();
    expect(state.bridge.getSnapshot()).toMatchObject({
      returning: false,
      notice: 'unavailable',
      source: { id: state.source.id },
    });
    expect(state.pending).toHaveLength(1);
    state.checkDrafts();
  });

  it('does not treat an arbitrary network or parser failure as a transport timeout', async () => {
    const state = await pendingRead();
    await act(async () => state.failures[0]?.(new TypeError('isolated transport error')));
    expect(state.bridge.getSnapshot()).toMatchObject({ returning: false, notice: 'unavailable' });
    expect(state.pending).toHaveLength(1);
    expect(state.bridge.getSnapshot().source?.id).toBe(state.source.id);
  });
});
