import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { readSettingsReadingSession } from '@/components/shell/settings-reading-session';
import { useChatStore } from '@/stores/chatStore';
import { beginBridge, flush, Host, hook, mounts, open, release, root, unmounts } from './reading-diagnostics-fixture';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/offline-store', () => ({
  loadThreadMessages: vi.fn().mockResolvedValue(null),
  saveThreadMessages: vi.fn().mockResolvedValue(undefined),
  loadThreadActiveState: vi.fn().mockResolvedValue(null),
  saveThreadActiveState: vi.fn().mockResolvedValue(undefined),
  loadThreadWorkspaceState: vi.fn().mockResolvedValue(null),
}));

describe('real history owner cancellation discriminator', () => {
  it.each([false, true])('finishes refresh while same reader stays mounted; cold=%s', async (cold) => {
    const state = await open(cold);
    await act(async () => root.render(<Host tick={1} />));
    expect(mounts).toBe(1);
    expect(unmounts).toBe(0);
    expect(state.result()).toBe('pending');
    await act(async () => {
      release();
      await Promise.resolve();
    });
    await flush();

    expect(await state.receipt).toMatchObject({ status: 'settled', exact: true });
    expect(state.top()).toBe(400);
    const records = JSON.parse(localStorage.getItem('cat-cafe:connection-diagnostics:v1') ?? '[]');
    expect(records.filter((r: { kind: string }) => r.kind === 'reading_restore')).toEqual([]);
  });
  it('user wheel cancels a pending refresh without unmounting reader', async () => {
    const state = await open(false);
    act(() => state.el.dispatchEvent(new WheelEvent('wheel', { deltaY: -1 })));
    expect(await state.receipt).toEqual({ status: 'interrupted' });
    expect(unmounts).toBe(0);
  });
  it('real unmount cancels a pending refresh', async () => {
    const state = await open(false);
    await act(async () => root.render(<Host visible={false} />));
    expect(await state.receipt).toEqual({ status: 'interrupted' });
    expect(unmounts).toBe(1);
  });

  it('bootstrap dependency cleanup still interrupts a same-mounted history hook', async () => {
    const state = await open(false);
    const original = useChatStore.getState().replaceThreadMessages;
    try {
      await act(async () => useChatStore.setState({ replaceThreadMessages: (...args) => original(...args) }));
      expect(await state.receipt).toEqual({ status: 'interrupted' });
      expect(mounts).toBe(1);
      expect(unmounts).toBe(0);
    } finally {
      await act(async () => useChatStore.setState({ replaceThreadMessages: original }));
    }
  });
  it('real bridge plus original port finishes and consumes only after exact geometry success', async () => {
    const state = await beginBridge();
    await act(async () => {
      release();
      await Promise.resolve();
    });
    await flush();
    expect(state.bridge.getSnapshot()).toMatchObject({ source: null, returning: false, notice: null });
    expect(state.top()).toBe(400);
    expect(readSettingsReadingSession('boot76-probe')).toBeNull();
    state.checkDrafts();
    const records = state.readingDiagnostics();
    expect(records.map((r: { phase: string }) => r.phase)).toEqual(['start', 'complete']);
    expect(records.at(-1)).toMatchObject({ status: 'settled', exact: true, readerMounted: true });
    expect(new Set(records.map((r: { operationId: string }) => r.operationId)).size).toBe(1);
    expect(new Set(records.map((r: { readerId: string }) => r.readerId)).size).toBe(1);
    expect(mounts).toBe(1);
    expect(unmounts).toBe(0);
  });
  it.each([
    {
      kind: 'user',
      cancelSource: 'native_input',
      mounted: true,
      bridgeCause: 'restore',
      hasReader: true,
      inputKind: 'wheel',
      inputTrusted: false,
      invoke: async (state: Awaited<ReturnType<typeof beginBridge>>) => {
        act(() => state.el.dispatchEvent(new WheelEvent('wheel', { deltaY: -1 })));
      },
    },
    {
      kind: 'unmount',
      cancelSource: 'bootstrap_cleanup',
      mounted: false,
      bridgeCause: 'reader_unregistered',
      hasReader: false,
      inputKind: undefined,
      inputTrusted: undefined,
      invoke: async (state: Awaited<ReturnType<typeof beginBridge>>) => {
        await act(async () => root.render(<Host visible={false} register={state.register} />));
      },
    },
    {
      kind: 'dependency',
      cancelSource: 'bootstrap_cleanup',
      mounted: true,
      bridgeCause: 'reader_unregistered',
      hasReader: false,
      inputKind: undefined,
      inputTrusted: undefined,
      invoke: async () => {
        const original = useChatStore.getState().replaceThreadMessages;
        await act(async () => useChatStore.setState({ replaceThreadMessages: (...args) => original(...args) }));
      },
    },
    {
      kind: 'bootstrap-only',
      cancelSource: 'bootstrap_cleanup',
      mounted: true,
      bridgeCause: 'restore',
      hasReader: true,
      inputKind: undefined,
      inputTrusted: undefined,
      invoke: async () => {
        const original = useChatStore.getState().setCatInvocation;
        await act(async () => useChatStore.setState({ setCatInvocation: (...args) => original(...args) }));
      },
    },
  ])('real bridge distinguishes $kind cancellation while preserving retry source', async (scenario) => {
    const state = await beginBridge();
    const original = useChatStore.getState().replaceThreadMessages;
    const originalInvocation = useChatStore.getState().setCatInvocation;
    try {
      await scenario.invoke(state);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      const diagnostic = state.diagnostics().findLast((r: { phase: string }) => r.phase === 'cancel');
      expect(state.bridge.getSnapshot()).toMatchObject({
        returning: false,
        notice: 'interrupted',
        source: { id: state.source.id },
      });
      expect(readSettingsReadingSession('boot76-probe')?.id).toBe(state.source.id);
      const records = state.readingDiagnostics();
      const canceled = records.find((r: { phase: string }) => r.phase === 'cancel');
      expect(canceled).toMatchObject({ cancelSource: scenario.cancelSource, readerMounted: scenario.mounted });
      expect(canceled.operationId).toBe(records[0].operationId);
      expect(canceled.readerId).toBe(records[0].readerId);
      expect(canceled.inputKind).toBe(scenario.inputKind);
      expect(canceled.inputTrusted).toBe(scenario.inputTrusted);
      expect(diagnostic.operationId).toBe(canceled.operationId);
      expect(diagnostic).toMatchObject({ cause: scenario.bridgeCause, hasReader: scenario.hasReader, admitted: true });
      expect(JSON.stringify(records)).not.toMatch(
        /original reading|Original source|unsent original draft|different thread draft|boot76-probe|readingRef|threadId/,
      );
      await act(async () => {
        release();
        await Promise.resolve();
      });
      await flush();
      expect(state.bridge.getSnapshot().source?.id).toBe(state.source.id);
      state.checkDrafts();
      expect(unmounts).toBe(scenario.mounted ? 0 : 1);
    } finally {
      await act(async () =>
        useChatStore.setState({ replaceThreadMessages: original, setCatInvocation: originalInvocation }),
      );
    }
  });
  it('keeps old-owner completion separate from a new explicit retry and exact source consumption', async () => {
    const state = await beginBridge();
    const firstStart = state.readingDiagnostics().find((record: { phase: string }) => record.phase === 'start');
    expect(firstStart).toBeDefined();
    await act(async () => root.render(<Host visible={false} register={state.register} />));
    expect(state.bridge.getSnapshot().source?.id).toBe(state.source.id);
    await state.bridge.returnToSource(state.source.id);
    await act(async () => root.render(<Host register={state.register} />));
    const el = hook.scrollContainerRef.current;
    if (!el) throw new Error('Missing replacement viewport');
    let top = 0;
    Object.defineProperties(el, {
      scrollTop: {
        configurable: true,
        get: () => top,
        set: (value: number) => {
          top = value;
        },
      },
      scrollHeight: { configurable: true, value: 1600 },
      clientHeight: { configurable: true, value: 600 },
    });
    el.getBoundingClientRect = () => ({ top: 100, bottom: 700 }) as DOMRect;
    const boundary = document.createElement('div');
    boundary.dataset.messageViewportId = 'reading';
    boundary.getBoundingClientRect = () => ({ top: 480 - top, bottom: 680 - top }) as DOMRect;
    const body = document.createElement('div');
    body.dataset.messageId = 'reading';
    boundary.append(body);
    el.append(boundary);
    const secondStart = state.readingDiagnostics().findLast((record: { phase: string }) => record.phase === 'start');
    expect(secondStart.readerId).not.toBe(firstStart.readerId);
    expect(secondStart.operationId).not.toBe(firstStart.operationId);
    expect(state.bridge.getSnapshot().returning).toBe(true);
    await act(async () => {
      release();
      await Promise.resolve();
    });
    await flush();
    const completed = state.readingDiagnostics().filter((record: { phase: string }) => record.phase === 'complete');
    expect(completed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          readerId: firstStart.readerId,
          operationId: firstStart.operationId,
          status: 'interrupted',
          readerMounted: false,
          refreshPending: false,
          restorePending: false,
        }),
        expect.objectContaining({
          readerId: secondStart.readerId,
          operationId: secondStart.operationId,
          status: 'settled',
          exact: true,
          readerMounted: true,
        }),
      ]),
    );
    expect(state.bridge.getSnapshot().source).toBeNull();
    expect(top).toBe(400);
    state.checkDrafts();
  });
  it('does not call the departing reader mounted after the same hook commits a different thread', async () => {
    const state = await beginBridge();
    const started = state.readingDiagnostics().find((record: { phase: string }) => record.phase === 'start');
    await act(async () => {
      useChatStore.getState().setCurrentThread('other');
      root.render(<Host register={state.register} threadId="other" />);
    });
    const finished = state.readingDiagnostics().findLast((record: { phase: string }) => record.phase === 'complete');
    expect(finished).toMatchObject({
      readerId: started.readerId,
      operationId: started.operationId,
      status: 'interrupted',
      readerMounted: false,
    });
    expect(state.bridge.getSnapshot().source?.id).toBe(state.source.id);
    await act(async () => {
      release();
      await Promise.resolve();
    });
    await flush();
    expect(state.bridge.getSnapshot().source?.id).toBe(state.source.id);
    state.checkDrafts();
  });
});
