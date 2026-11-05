import type { ContentModificationDetailView } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useModificationProgress } from '../useModificationProgress';

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => mocks.fetch(...args) }));

type Execution = NonNullable<ContentModificationDetailView['execution']>['state'];

function detail(
  patch: {
    revision?: number;
    execution?: Execution;
    stage?: ContentModificationDetailView['stage'];
    cancelled?: boolean;
    candidates?: number;
  } = {},
): ContentModificationDetailView {
  return {
    stage: patch.stage ?? 'queued',
    candidates: Array.from({ length: patch.candidates ?? 0 }, (_, index) => ({
      kind: 'media' as const,
      candidateRef: `candidate-${index}`,
      asset: {} as never,
      authorCatId: 'codex',
      responses: [],
    })),
    acceptances: [],
    execution: patch.execution
      ? { state: patch.execution, messageId: 'carrier', targetCatId: 'codex', observedAt: 1, evidenceRef: 'evidence' }
      : undefined,
    record: {
      requestId: 'request-1',
      ownerUserId: 'operator',
      revision: patch.revision ?? 1,
      createdAt: 1,
      updatedAt: 1,
      progress: {},
      payload: { threadId: 'execution-thread' },
      control: patch.cancelled
        ? {
            state: 'cancelled' as const,
            actorId: 'operator',
            cancelledAt: 1,
            receiptRef: 'receipt',
            taskResolution: 'preserved' as const,
          }
        : undefined,
    },
  } as unknown as ContentModificationDetailView;
}

const ok = (view: ContentModificationDetailView) =>
  new Response(JSON.stringify(view), { status: 200, headers: { 'content-type': 'application/json' } });
const failure = (status: number, error: string) =>
  new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json' } });

type Latest = ReturnType<typeof useModificationProgress>;
let latest: Latest;
let root: Root;
let host: HTMLElement;

function Probe(props: { requestId?: string }) {
  latest = useModificationProgress({
    requestId: props.requestId,
    targetName: '烁烁',
    contentTitle: '窄屏设计稿',
    placeCount: 2,
  });
  return null;
}

async function mount(requestId: string | null = 'request-1') {
  await act(async () => {
    root.render(<Probe requestId={requestId ?? undefined} />);
  });
}
const tick = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const getCalls = () => mocks.fetch.mock.calls.filter(([, init]) => !(init as RequestInit | undefined)?.method);
const postCalls = () =>
  mocks.fetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST');

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  mocks.fetch.mockReset();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe('useModificationProgress', () => {
  it('reads on mount, polls while the request is moving, and stops once it no longer is', async () => {
    mocks.fetch.mockImplementation(async () => ok(detail({ execution: 'running' })));
    await mount();
    expect(latest.copy?.key).toBe('working');
    expect(latest.copy?.title).toBe('烁烁修改中 · 窄屏设计稿 2\u00A0处');
    expect(getCalls()).toHaveLength(1);
    expect(String(getCalls()[0][0])).toBe('/api/content-modifications/request-1');

    await tick(4000);
    expect(getCalls()).toHaveLength(2);

    mocks.fetch.mockImplementation(async () => ok(detail({ execution: 'finished' })));
    await tick(4000);
    expect(latest.copy?.key).toBe('finished_without_version');
    const settled = getCalls().length;
    await tick(40_000);
    expect(getCalls()).toHaveLength(settled);
  });

  it('reads a request that is already finished exactly once instead of polling every historic message', async () => {
    mocks.fetch.mockImplementation(async () => ok(detail({ execution: 'finished', candidates: 1 })));
    await mount();
    expect(latest.copy).toBeNull();
    await tick(60_000);
    expect(getCalls()).toHaveLength(1);
  });

  it('re-reads a quiet request at once when the work projection announces a change', async () => {
    mocks.fetch.mockImplementation(async () => ok(detail({ execution: 'finished' })));
    await mount();
    expect(getCalls()).toHaveLength(1);
    mocks.fetch.mockImplementation(async () => ok(detail({ execution: 'finished', candidates: 1 })));
    await act(async () => {
      window.dispatchEvent(new Event('cat-cafe:entrusted-work-projection-invalidated'));
    });
    expect(getCalls()).toHaveLength(2);
    expect(latest.copy).toBeNull();
  });

  it('re-reads a quiet request when the window regains focus, but not within seconds of the last read', async () => {
    // A conversation holds many historic requests; one focus change must not make all of them read again.
    mocks.fetch.mockImplementation(async () => ok(detail({ execution: 'finished' })));
    await mount();
    expect(getCalls()).toHaveLength(1);
    await tick(2_000);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(getCalls()).toHaveLength(1);
    await tick(20_000);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(getCalls()).toHaveLength(2);
  });

  it('hides the line when the viewer cannot read the request instead of announcing an error', async () => {
    for (const status of [401, 403, 404, 410]) {
      mocks.fetch.mockReset();
      mocks.fetch.mockImplementation(async () => failure(status, 'access_denied'));
      await act(async () => root.unmount());
      root = createRoot(host);
      await mount();
      expect(latest.copy).toBeNull();
      await tick(20_000);
      expect(getCalls()).toHaveLength(1);
    }
  });

  it('says the status is unknown when the read fails, and recovers on reload', async () => {
    mocks.fetch.mockImplementation(async () => {
      throw new Error('network down');
    });
    await mount();
    expect(latest.copy).toMatchObject({ key: 'unavailable', title: '无法获取状态' });
    mocks.fetch.mockImplementation(async () => ok(detail({ execution: 'running' })));
    await act(async () => {
      await latest.reload();
    });
    expect(latest.copy?.key).toBe('working');
  });

  it('does not keep presenting a running state after a later read fails', async () => {
    mocks.fetch.mockImplementation(async () => ok(detail({ execution: 'running' })));
    await mount();
    expect(latest.copy?.key).toBe('working');
    mocks.fetch.mockImplementation(async () => {
      throw new Error('network down');
    });
    await tick(4000);
    expect(latest.copy?.key).toBe('unavailable');
  });

  it('ignores a read that is older than the one it already has', async () => {
    mocks.fetch.mockImplementation(async () => ok(detail({ revision: 5, execution: 'running', cancelled: true })));
    await mount();
    expect(latest.copy?.key).toBe('cancelled_still_running');
    mocks.fetch.mockImplementation(async () => ok(detail({ revision: 4, execution: 'running' })));
    await tick(4000);
    expect(latest.copy?.key).toBe('cancelled_still_running');
  });

  it('cancels once, takes the new state from the server and announces the change', async () => {
    const announced = vi.fn();
    window.addEventListener('cat-cafe:entrusted-work-projection-invalidated', announced);
    let cancelled = false;
    mocks.fetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        cancelled = true;
        return ok(detail({ revision: 2, execution: 'running', cancelled: true }));
      }
      return ok(detail({ revision: cancelled ? 2 : 1, execution: 'running', cancelled }));
    });
    await mount();
    await act(async () => {
      await latest.cancel();
    });
    expect(postCalls()).toHaveLength(1);
    expect(String(postCalls()[0][0])).toBe('/api/content-modifications/request-1/cancel');
    expect(JSON.parse(String((postCalls()[0][1] as RequestInit).body))).toEqual({});
    expect(latest.copy?.key).toBe('cancelled_still_running');
    expect(latest.cancelError).toBeNull();
    expect(announced).toHaveBeenCalledTimes(1);
    window.removeEventListener('cat-cafe:entrusted-work-projection-invalidated', announced);
  });

  it('keeps the request intact when the cancel answer is lost and repeats the same cancel on retry', async () => {
    let attempts = 0;
    mocks.fetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        attempts += 1;
        if (attempts === 1) throw new Error('lost response');
        return ok(detail({ revision: 2, execution: 'running', cancelled: true }));
      }
      return ok(detail({ execution: 'running' }));
    });
    await mount();
    await act(async () => {
      await latest.cancel();
    });
    expect(latest.cancelError).toBe('取消结果尚未确认。请求和候选已保留；重试会核对同一次取消。');
    expect(latest.copy?.key).toBe('working');
    await act(async () => {
      await latest.cancel();
    });
    expect(postCalls()).toHaveLength(2);
    expect(String(postCalls()[1][0])).toBe(String(postCalls()[0][0]));
    expect(latest.cancelError).toBeNull();
  });

  it('drops the unconfirmed-cancel notice once a later read shows the owner cancelled the request', async () => {
    // The server applied the cancel but the answer never arrived; the next read carries the real receipt.
    let serverCancelled = false;
    mocks.fetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        serverCancelled = true;
        throw new Error('lost response');
      }
      return ok(detail({ revision: serverCancelled ? 2 : 1, execution: 'running', cancelled: serverCancelled }));
    });
    await mount();
    await act(async () => {
      await latest.cancel();
    });
    expect(latest.cancelError).not.toBeNull();
    await tick(4000);
    expect(latest.copy?.key).toBe('cancelled_still_running');
    expect(latest.cancelError).toBeNull();
  });

  it('clears the notice on a reload that reads the cancellation too', async () => {
    let serverCancelled = false;
    mocks.fetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        serverCancelled = true;
        throw new Error('lost response');
      }
      return ok(detail({ revision: serverCancelled ? 2 : 1, execution: 'finished', cancelled: serverCancelled }));
    });
    await mount();
    await act(async () => {
      await latest.cancel();
    });
    expect(latest.cancelError).not.toBeNull();
    await act(async () => {
      await latest.reload();
    });
    expect(latest.copy?.key).toBe('cancelled');
    expect(latest.cancelError).toBeNull();
  });

  it('keeps the notice while reads still show no cancellation', async () => {
    mocks.fetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') throw new Error('lost response');
      return ok(detail({ execution: 'running' }));
    });
    await mount();
    await act(async () => {
      await latest.cancel();
    });
    await tick(4000);
    expect(latest.copy?.key).toBe('working');
    expect(latest.cancelError).toBe('取消结果尚未确认。请求和候选已保留；重试会核对同一次取消。');
  });

  describe('when the cancel answer is lost only after a read already carried the owner cancellation', () => {
    const NOTICE = '取消结果尚未确认。请求和候选已保留；重试会核对同一次取消。';

    /** The cancel POST is applied by the server but its answer stays pending while the 4s poll reads the receipt. */
    async function cancelThenReadThenLoseTheAnswer(afterCancel: Execution) {
      let serverCancelled = false;
      let loseAnswer: () => void = () => undefined;
      mocks.fetch.mockImplementation(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          serverCancelled = true;
          await new Promise<never>((_resolve, reject) => {
            loseAnswer = () => reject(new Error('lost response'));
          });
        }
        return ok(
          detail({
            revision: serverCancelled ? 2 : 1,
            execution: serverCancelled ? afterCancel : 'running',
            cancelled: serverCancelled,
          }),
        );
      });
      await mount();
      let pending: Promise<void> = Promise.resolve();
      await act(async () => {
        pending = latest.cancel();
      });
      await tick(4000);
      const confirmed = latest.copy?.key;
      await act(async () => {
        loseAnswer();
        await pending;
      });
      return confirmed;
    }

    it('keeps the cancellation the owner confirmed and does not demote it to unknown (execution finished)', async () => {
      const confirmed = await cancelThenReadThenLoseTheAnswer('finished');
      expect(confirmed).toBe('cancelled');
      expect(latest.copy?.key).toBe('cancelled');
      expect(latest.cancelError).toBeNull();
      expect(latest.busy).toBe(false);
      // The request is terminal now, so nothing re-reads it and the late failure can never be corrected later.
      const reads = getCalls().length;
      await tick(40_000);
      expect(getCalls()).toHaveLength(reads);
      expect(latest.cancelError).toBeNull();
    });

    it('keeps the cancellation the owner confirmed while the run is still going', async () => {
      const confirmed = await cancelThenReadThenLoseTheAnswer('running');
      expect(confirmed).toBe('cancelled_still_running');
      expect(latest.copy?.key).toBe('cancelled_still_running');
      expect(latest.cancelError).toBeNull();
      await tick(40_000);
      expect(latest.cancelError).toBeNull();
    });

    it('still reports the lost answer while no read has shown an owner cancellation', async () => {
      let loseAnswer: () => void = () => undefined;
      mocks.fetch.mockImplementation(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          await new Promise<never>((_resolve, reject) => {
            loseAnswer = () => reject(new Error('lost response'));
          });
        }
        return ok(detail({ execution: 'running' }));
      });
      await mount();
      let pending: Promise<void> = Promise.resolve();
      await act(async () => {
        pending = latest.cancel();
      });
      await tick(4000);
      await act(async () => {
        loseAnswer();
        await pending;
      });
      expect(latest.copy?.key).toBe('working');
      expect(latest.cancelError).toBe(NOTICE);
    });
  });

  it('ignores a second cancel while one is already in flight', async () => {
    let release: (() => void) | undefined;
    mocks.fetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return ok(detail({ revision: 2, execution: 'running', cancelled: true }));
      }
      return ok(detail({ execution: 'running' }));
    });
    await mount();
    await act(async () => {
      void latest.cancel();
      void latest.cancel();
    });
    expect(latest.busy).toBe(true);
    expect(postCalls()).toHaveLength(1);
    await act(async () => {
      release?.();
    });
    expect(latest.busy).toBe(false);
  });

  it('exposes the execution conversation so a failed run can be opened', async () => {
    mocks.fetch.mockImplementation(async () => ok(detail({ execution: 'failed' })));
    await mount();
    expect(latest.copy?.action?.kind).toBe('open-execution');
    expect(latest.executionThreadId).toBe('execution-thread');
  });

  it('does nothing without a request id', async () => {
    await mount(null);
    expect(latest.copy).toBeNull();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
