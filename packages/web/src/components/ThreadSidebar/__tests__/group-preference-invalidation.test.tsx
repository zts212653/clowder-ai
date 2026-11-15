import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAttentionClusters } from '../use-attention-clusters';

const { mockApiFetch } = vi.hoisted(() => ({ mockApiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: mockApiFetch }));
const initial = {
  aliases: { 'group:attention_a': 'Existing Group' },
  open: { 'group:attention_a': false },
  collapsedPeek: { 'group:attention_a': false },
  memberSort: { 'group:attention_a': 'manual' },
  groups: [{ id: 'attention_a', threadIds: ['a', 'b'] }],
};
const approved = { ...initial, groups: [{ id: 'attention_a', threadIds: ['a', 'b', 'new-thread'] }] };

describe('mounted Group preferences consume canonical invalidations', () => {
  let root: Root;
  let container: HTMLDivElement;
  let current: ReturnType<typeof useAttentionClusters>;
  function Probe() {
    current = useAttentionClusters([], 'default', '');
    return null;
  }
  const render = () => act(async () => root.render(<Probe />));
  const approve = () =>
    window.dispatchEvent(
      new CustomEvent('cat-cafe:proposal-updated', {
        detail: { proposalId: 'proposal-new-thread', status: 'approved', createdThreadId: 'new-thread' },
      }),
    );

  beforeEach(() => {
    vi.stubGlobal('React', React);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mockApiFetch.mockReset().mockImplementation(async () => Response.json(initial));
    window.localStorage.clear();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('reloads an approved thread into the existing Group without rewriting membership or fold/sort choices', async () => {
    await render();
    mockApiFetch.mockClear().mockImplementation(async () => Response.json(approved));
    await act(async () => {
      for (const detail of [{ status: 'rejected' }, { status: 'approved', proposalId: 'unrelated-memory' }])
        window.dispatchEvent(new CustomEvent('cat-cafe:proposal-updated', { detail }));
    });
    expect(mockApiFetch).not.toHaveBeenCalled();
    await act(async () => approve());
    expect(current.savedGroups).toEqual(approved.groups);
    expect(current.memberSort).toEqual(initial.memberSort);
    expect(current.collapsedPeek).toEqual(initial.collapsedPeek);
    expect(JSON.parse(window.localStorage.getItem('cat-cafe:f277:cluster-open:v1') ?? '{}')).toEqual(initial.open);
    expect(mockApiFetch).toHaveBeenCalledTimes(1);
    expect(
      mockApiFetch.mock.calls.every(([path, init]) => path === '/api/config/thread-attention' && !init?.method),
    ).toBe(true);
  });

  it.each(['response', 'failure'])('does not swallow approval behind an older in-flight %s', async (outcome) => {
    let finish!: (response: Response) => void;
    mockApiFetch
      .mockImplementationOnce(() => new Promise<Response>((resolve) => (finish = resolve)))
      .mockImplementation(async () => Response.json(approved));
    await render();
    await act(async () => approve());
    expect(mockApiFetch).toHaveBeenCalledTimes(1);
    await act(async () => finish(outcome === 'response' ? Response.json(initial) : new Response('', { status: 403 })));
    expect(mockApiFetch).toHaveBeenCalledTimes(2);
    expect(current.savedGroups).toEqual(approved.groups);
    expect(current.groupLoadState).toBe('ready');
    expect(current.groupLoadError).toBeNull();
  });

  it.each(['focus', 'online', 'visibilitychange'])('retains %s while an older GET is in flight', async (event) => {
    await render();
    let finish!: (response: Response) => void;
    mockApiFetch
      .mockClear()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => (finish = resolve)))
      .mockImplementation(async () => Response.json(approved));
    await act(async () => window.dispatchEvent(new Event('cat-cafe:socket-reconnected')));
    expect(current.groupLoadState).toBe('loading');
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    await act(async () => (event === 'visibilitychange' ? document : window).dispatchEvent(new Event(event)));
    await act(async () => finish(Response.json(initial)));
    expect(mockApiFetch).toHaveBeenCalledTimes(2);
    expect(current.savedGroups).toEqual(approved.groups);
  });

  it('recovers missed changes on reconnect, focus, visibility and online after a successful read', async () => {
    await render();
    mockApiFetch.mockClear().mockImplementation(async () => Response.json(approved));
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    for (const event of ['cat-cafe:socket-reconnected', 'focus', 'visibilitychange', 'online']) {
      await act(async () => {
        (event === 'visibilitychange' ? document : window).dispatchEvent(new Event(event));
      });
      expect(current.savedGroups).toEqual(approved.groups);
    }
    expect(mockApiFetch).toHaveBeenCalledTimes(4);
    mockApiFetch.mockImplementation(async () => new Response('', { status: 403 }));
    await act(async () => approve());
    expect(current.groupLoadState).toBe('error');
    expect(current.savedGroups).toEqual(approved.groups);
  });

  it('queues invalidation behind a save and reads fresh membership without rolling back the saved fold', async () => {
    await render();
    let finishSave!: (response: Response) => void;
    mockApiFetch
      .mockClear()
      .mockImplementation((_, init?: RequestInit) =>
        init?.method === 'PUT'
          ? new Promise<Response>((resolve) => (finishSave = resolve))
          : Promise.resolve(Response.json({ ...approved, open: { 'group:attention_a': true } })),
      );
    await act(async () => {
      void current.openGroup('attention_a');
    });
    await act(async () => approve());
    expect(mockApiFetch).toHaveBeenCalledTimes(1);
    await act(async () => finishSave(Response.json({ ...initial, open: { 'group:attention_a': true } })));
    expect(mockApiFetch).toHaveBeenCalledTimes(2);
    expect(current.savedGroups).toEqual(approved.groups);
    expect(JSON.parse(window.localStorage.getItem('cat-cafe:f277:cluster-open:v1') ?? '{}')).toEqual({
      'group:attention_a': true,
    });
  });
});
