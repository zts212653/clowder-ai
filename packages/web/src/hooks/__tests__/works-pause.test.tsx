import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fetch = vi.hoisted(() => vi.fn());
vi.mock('@/utils/api-client', () => ({ apiFetch: fetch }));

import { useGlobalArtifacts } from '../useGlobalArtifacts';
import { GLOBAL_WORKS_SOURCE_REFRESH_COOLDOWN_MS } from '../usePagedGlobalWorks';
import { useThreadArtifacts } from '../useThreadArtifacts';

const artifact = (name: string) => ({ type: 'file', name, createdAt: 1, url: `/uploads/${name}`, catId: null });
const page = (name: string, nextCursor?: string) =>
  Response.json({
    artifacts: [artifact(name)],
    total: 1,
    view: 'works',
    complete: !nextCursor,
    nextCursor,
    workLineage: 'resolved',
  });
const invalidate = (threadId?: string) =>
  window.dispatchEvent(new CustomEvent('cat-cafe:entrusted-work-projection-invalidated', { detail: { threadId } }));

let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fetch.mockReset();
  root = createRoot(document.createElement('div'));
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('retains the shared thread snapshot, cancels only after the last active consumer, and drops late results', async () => {
  let panel: ReturnType<typeof useThreadArtifacts> | undefined;
  function Panel({ active }: { active: boolean }) {
    panel = useThreadArtifacts('bound-thread', 'works', active);
    return null;
  }
  function Sibling() {
    useThreadArtifacts('bound-thread', 'works');
    return null;
  }
  const render = (active: boolean, sibling = false) =>
    act(async () =>
      root.render(
        <>
          <Panel active={active} />
          {sibling && <Sibling />}
        </>,
      ),
    );

  await render(false);
  await act(async () => {
    invalidate('bound-thread');
  });
  expect(fetch).not.toHaveBeenCalled();

  fetch.mockResolvedValueOnce(page('retained'));
  await render(true, true);
  expect(fetch).toHaveBeenCalledTimes(1);
  let finish: (response: Response) => void = () => {};
  fetch.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  await act(async () => {
    invalidate('bound-thread');
  });
  const signal = fetch.mock.calls[1][1].signal as AbortSignal;
  await render(false, true);
  expect(signal.aborted).toBe(false);
  await act(async () => {
    finish(page('sibling'));
  });
  expect(panel?.artifacts[0]?.name).toBe('sibling');

  fetch.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  await act(async () => {
    invalidate('bound-thread');
  });
  const lastSignal = fetch.mock.calls[2][1].signal as AbortSignal;
  await render(false);
  expect(lastSignal.aborted).toBe(true);
  await act(async () => {
    invalidate('bound-thread');
    panel?.refetch();
  });
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(panel?.artifacts[0]?.name).toBe('sibling');

  fetch.mockResolvedValueOnce(page('resumed'));
  await render(true);
  await act(async () => {
    finish(page('late'));
  });
  expect(fetch).toHaveBeenCalledTimes(4);
  expect(panel?.artifacts[0]?.name).toBe('resumed');
});

it('retries a PR title canceled when the last visible thread owner hides', async () => {
  let result: ReturnType<typeof useThreadArtifacts> | undefined;
  function Panel({ active }: { active: boolean }) {
    result = useThreadArtifacts('pr-title-thread', 'works', active);
    return null;
  }
  const render = (active: boolean) => act(async () => root.render(<Panel active={active} />));
  const ref = 'fixture-org/fixture-repo#1864';
  const threadResponse = () =>
    Response.json({
      artifacts: [{ ...artifact(ref), type: 'pr', ref }],
      view: 'works',
      workLineage: 'resolved',
      total: 1,
      complete: true,
    });
  let finish: (response: Response) => void = () => {};
  fetch
    .mockResolvedValueOnce(threadResponse())
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValueOnce(threadResponse())
    .mockResolvedValueOnce(Response.json({ title: 'Restored title' }));
  await render(true);
  expect(fetch.mock.calls[1][0]).toContain('/github/pr-title');
  const signal = fetch.mock.calls[1][1].signal as AbortSignal;
  await render(false);
  expect(signal.aborted).toBe(true);
  await render(true);
  expect(fetch).toHaveBeenCalledTimes(4);
  expect(fetch.mock.calls[3][0]).toContain('/github/pr-title');
  await act(async () => {
    finish(Response.json({ title: 'Canceled title' }));
  });
  expect(result?.artifacts[0]?.name).toBe('Restored title');
});

it('pauses a global continuation, keeps partial results during resume, and isolates a new owner', async () => {
  let result: ReturnType<typeof useGlobalArtifacts> | undefined;
  function Panel({ paused, owner }: { paused: boolean; owner: string }) {
    result = useGlobalArtifacts(true, { view: 'works' }, owner, { paused });
    return null;
  }
  const render = (paused: boolean, owner = 'owner') =>
    act(async () => root.render(<Panel paused={paused} owner={owner} />));
  await render(true);
  expect(fetch).not.toHaveBeenCalled();
  let finish: (response: Response) => void = () => {};
  fetch.mockResolvedValueOnce(page('partial', 'next')).mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  await render(false);
  const signal = fetch.mock.calls[1][1].signal as AbortSignal;
  expect(result?.artifacts[0]?.name).toBe('partial');
  await render(true);
  expect(signal.aborted).toBe(true);
  await act(async () => {
    invalidate();
    result?.refetch();
    finish(page('late'));
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(result?.artifacts[0]?.name).toBe('partial');

  fetch.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  await render(false);
  expect(result?.artifacts[0]?.name).toBe('partial');
  await render(true, 'different-owner');
  await act(async () => {
    finish(page('late-old-owner'));
  });
  expect(result?.artifacts).toEqual([]);
  expect(fetch).toHaveBeenCalledTimes(3);
});

it('clears the global refresh timer when the retained owner hides', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  function Panel({ paused }: { paused: boolean }) {
    useGlobalArtifacts(true, { view: 'works' }, undefined, { paused });
    return null;
  }
  fetch.mockResolvedValueOnce(page('before')).mockResolvedValueOnce(page('after'));
  await act(async () => root.render(<Panel paused={false} />));
  await act(async () => {
    invalidate();
  });
  await act(async () => root.render(<Panel paused />));
  await act(async () => {
    invalidate();
    await vi.advanceTimersByTimeAsync(GLOBAL_WORKS_SOURCE_REFRESH_COOLDOWN_MS);
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  await act(async () => root.render(<Panel paused={false} />));
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('keeps classic global results when hiding during a reread', async () => {
  let result: ReturnType<typeof useGlobalArtifacts> | undefined;
  function Panel({ paused }: { paused: boolean }) {
    result = useGlobalArtifacts(true, undefined, undefined, { paused });
    return null;
  }
  const render = (paused: boolean) => act(async () => root.render(<Panel paused={paused} />));
  await render(true);
  expect(fetch).not.toHaveBeenCalled();
  fetch.mockResolvedValueOnce(Response.json({ artifacts: [artifact('classic')] }));
  await render(false);
  let finish: (response: Response) => void = () => {};
  fetch.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  await act(async () => {
    result?.refetch();
  });
  const signal = fetch.mock.calls[1][1].signal as AbortSignal;
  await render(true);
  expect(signal.aborted).toBe(true);
  await act(async () => {
    finish(Response.json({ artifacts: [artifact('late')] }));
    result?.refetch();
  });
  expect(result?.artifacts[0]?.name).toBe('classic');
  expect(fetch).toHaveBeenCalledTimes(2);
});
