import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SearchGroupAction } from '../SearchGroupFeedback';
import { useAttentionClusters } from '../use-attention-clusters';

const { mockApiFetch } = vi.hoisted(() => ({ mockApiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: mockApiFetch }));
const jsonOk = (value: unknown) => Promise.resolve(new Response(JSON.stringify(value)));
const textFail = (status: number) => Promise.resolve(new Response('failed', { status }));

const snapshot = { aliases: {}, open: {}, groups: [{ id: 'attention_a', threadIds: ['a', 'b'] }] };
const timeout = () => Object.assign(new Error('request timed out'), { name: 'TimeoutError' });

describe('Group preference read recovery', () => {
  let root: Root;
  let container: HTMLDivElement;
  let current: ReturnType<typeof useAttentionClusters>;
  const open = vi.fn();

  function Probe() {
    current = useAttentionClusters([], 'default', '');
    return (
      <SearchGroupAction
        count={3}
        loadState={current.groupLoadState}
        errorMessage={current.groupLoadError}
        onOpen={open}
        onRetry={() => void current.reloadGroups()}
      />
    );
  }

  beforeEach(() => {
    vi.stubGlobal('React', React);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mockApiFetch.mockReset();
    window.localStorage.clear();
    vi.useFakeTimers();
    open.mockClear();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  const render = () => act(async () => root.render(<Probe />));
  const advance = (ms: number) => act(async () => vi.advanceTimersByTimeAsync(ms));

  it('automatically recovers an initial timeout without inventing empty membership or requiring a click', async () => {
    mockApiFetch.mockRejectedValueOnce(timeout()).mockImplementation(() => jsonOk(snapshot));
    await render();
    expect(container.textContent).toContain('正在读取 Group');
    expect(container.querySelector('button')?.disabled).toBe(true);
    await act(async () => container.querySelector('button')?.click());
    expect(open).not.toHaveBeenCalled();
    await advance(1_000);
    expect(mockApiFetch).toHaveBeenCalledTimes(2);
    expect(current.groupLoadState).toBe('ready');
    expect(current.savedGroups).toEqual(snapshot.groups);
    expect(container.textContent).toBe('整理全部 3 条');
  });

  it('bounds automatic retries and explains a persistent timeout', async () => {
    mockApiFetch.mockRejectedValue(timeout());
    await render();
    await advance(60_000);
    expect(mockApiFetch).toHaveBeenCalledTimes(2);
    expect(current.groupLoadState).toBe('error');
    expect(container.textContent).toBe('读取 Group 超时 · 重试');
    expect(current.savedGroups).toEqual([]);
  });

  it('retries a transport/server failure but does not automatically retry authorization or malformed JSON', async () => {
    mockApiFetch.mockImplementationOnce(() => textFail(503)).mockImplementation(() => jsonOk(snapshot));
    await render();
    await advance(1_000);
    expect(current.groupLoadState).toBe('ready');
    mockApiFetch.mockImplementation(() => textFail(403));
    await act(async () => {
      await current.reloadGroups();
    });
    const forbiddenCount = mockApiFetch.mock.calls.length;
    await act(async () => {
      window.dispatchEvent(new Event('online'));
      window.dispatchEvent(new Event('focus'));
    });
    await advance(60_000);
    expect(mockApiFetch).toHaveBeenCalledTimes(forbiddenCount);
    expect(current.groupLoadState).toBe('error');
    expect(current.savedGroups).toEqual(snapshot.groups);
    mockApiFetch.mockResolvedValue({ ok: true, json: () => Promise.reject(new SyntaxError('invalid JSON')) });
    await act(async () => {
      await current.reloadGroups();
    });
    const malformedCount = mockApiFetch.mock.calls.length;
    await advance(60_000);
    expect(mockApiFetch).toHaveBeenCalledTimes(malformedCount);
  });

  it('joins recovery events to one read and restores on reconnect after automatic retries are exhausted', async () => {
    mockApiFetch.mockRejectedValue(new TypeError('Failed to fetch'));
    await render();
    await advance(60_000);
    mockApiFetch.mockClear();
    let finish!: (response: Response) => void;
    mockApiFetch.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    await act(async () => {
      window.dispatchEvent(new Event('online'));
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('online'));
    });
    expect(mockApiFetch).toHaveBeenCalledTimes(1);
    await act(async () => finish(await jsonOk(snapshot)));
    expect(current.savedGroups).toEqual(snapshot.groups);
    expect(current.groupLoadState).toBe('ready');
  });

  it('cancels scheduled recovery when the Sidebar unmounts', async () => {
    mockApiFetch.mockRejectedValue(timeout());
    await render();
    act(() => root.unmount());
    root = createRoot(container);
    await advance(60_000);
    expect(mockApiFetch).toHaveBeenCalledTimes(1);
  });

  it('recovers the mounted lifecycle under React StrictMode without duplicate reads', async () => {
    mockApiFetch.mockImplementation(() => jsonOk(snapshot));
    await act(async () =>
      root.render(
        <React.StrictMode>
          <Probe />
        </React.StrictMode>,
      ),
    );
    expect(mockApiFetch).toHaveBeenCalledTimes(1);
    expect(current.groupLoadState).toBe('ready');
    expect(current.savedGroups).toEqual(snapshot.groups);
  });

  it('keeps read and mutation order so an older read cannot overwrite the confirmed Group', async () => {
    let finishRead!: (response: Response) => void;
    mockApiFetch.mockImplementation((_, init?: RequestInit) =>
      init?.method === 'PUT'
        ? jsonOk({ ...snapshot, open: { 'group:attention_a': true } })
        : new Promise<Response>((resolve) => {
            finishRead = resolve;
          }),
    );
    await render();
    await act(async () => {
      void current.openGroup('attention_a');
    });
    expect(mockApiFetch.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0);
    await act(async () => finishRead(await jsonOk(snapshot)));
    expect(mockApiFetch.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);
    expect(JSON.parse(window.localStorage.getItem('cat-cafe:f277:cluster-open:v1') ?? '{}')).toEqual({
      'group:attention_a': true,
    });
  });
});
