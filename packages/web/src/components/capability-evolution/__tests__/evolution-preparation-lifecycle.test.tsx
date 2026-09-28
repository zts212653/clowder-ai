import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EvolutionMomentContext } from '../journey/EvolutionMomentContext';
import { ownerRef, programFixture } from './evolution-fixtures';

const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: api.fetch }));
const projection = programFixture('constituting');
function publication(
  target = projection,
  title = '已发布的 A',
  updatedAt = '2026-09-07T00:00:00.000Z',
  readAt = '2026-09-07T00:01:00.000Z',
) {
  return {
    schemaVersion: 1,
    status: 'resolved',
    programRef: { ownerFeatureId: 'F311', ownerStateRef: target.program.programId },
    objectRef: target.program.objectRef,
    sourceRef: ownerRef('catalog'),
    readAt,
    updatedAt,
    groups: [
      {
        groupRef: ownerRef('group'),
        title: '材料',
        items: [{ materialRef: ownerRef('item'), title, summary: title, status: 'available', resources: [] }],
      },
    ],
    blockers: [],
  };
}
function deferred() {
  let resolve: (response: Response) => void = () => {
    throw new Error('deferred not initialized');
  };
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('preparation reads remain inside their mounted owner scope', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    api.fetch.mockReset();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  async function render(target = projection) {
    await act(async () => root.render(<EvolutionMomentContext projection={target} moment={1} />));
  }
  async function focus() {
    await act(async () => window.dispatchEvent(new Event('focus')));
  }

  it.each([
    'workspace',
    'program',
    'object',
  ] as const)('clears old %s content at the transition and ignores its late response', async (identity) => {
    const old = deferred();
    const next = deferred();
    api.fetch
      .mockResolvedValueOnce(Response.json(publication()))
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(next.promise);
    await render();
    expect(host.textContent).toContain('已发布的 A');
    await focus();
    const other = structuredClone(projection);
    if (identity === 'workspace') other.program.workspaceId = 'user:other';
    if (identity === 'program') other.program.programId = 'evolution-program:11111111111111111111111111111111';
    if (identity === 'object') other.program.objectRef = ownerRef('other-object');
    await render(other);
    expect(host.textContent).not.toContain('已发布的 A');
    await act(async () => next.resolve(Response.json(publication(other, '已发布的 B'))));
    await act(async () => old.resolve(Response.json(publication(projection, '迟到的 A'))));
    expect(host.textContent).toContain('已发布的 B');
    expect(host.textContent).not.toContain('迟到的 A');
    expect(api.fetch.mock.calls[1]?.[1]?.signal.aborted).toBe(true);
  });

  it('unmount and same-key remount do not resurrect an old publication', async () => {
    const old = deferred();
    api.fetch
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(Response.json(publication(projection, '重新读取的材料')));
    await render();
    await act(async () => root.render(null));
    await render();
    await act(async () => old.resolve(Response.json(publication(projection, '卸载前的材料'))));
    expect(host.textContent).toContain('重新读取的材料');
    expect(host.textContent).not.toContain('卸载前的材料');
  });

  it.each([401, 403, 404])('clears publication after HTTP %s and permits a fresh authorized read', async (status) => {
    api.fetch
      .mockResolvedValueOnce(Response.json(publication()))
      .mockResolvedValueOnce(Response.json({ error: 'not_available' }, { status }))
      .mockResolvedValueOnce(Response.json(publication(projection, '恢复后的材料')));
    await render();
    await focus();
    expect(host.textContent).not.toContain('已发布的 A');
    expect(host.textContent).toContain('准备材料暂时无法读取');
    await focus();
    expect(host.textContent).toContain('恢复后的材料');
  });

  it('deduplicates same-scope refresh and compares owner update timestamps rather than request times', async () => {
    const pending = deferred();
    api.fetch
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(
        Response.json(publication(projection, '较旧的材料', '2026-09-07T00:59:00.000Z', '2026-09-07T03:00:00.000Z')),
      );
    await render();
    await focus();
    await focus();
    expect(api.fetch).toHaveBeenCalledTimes(1);
    await act(async () =>
      pending.resolve(
        Response.json(
          publication(projection, '较新的材料', '2026-09-06T18:00:00.000-07:00', '2026-09-07T02:00:00.000Z'),
        ),
      ),
    );
    await focus();
    expect(host.textContent).toContain('较新的材料');
    expect(host.textContent).not.toContain('较旧的材料');
  });

  it('times out a stuck read and prevents the timed-out success from replacing a new attempt', async () => {
    vi.useFakeTimers();
    const old = deferred();
    api.fetch
      .mockReturnValueOnce(old.promise)
      .mockResolvedValue(Response.json(publication(projection, '新尝试的材料')));
    await render();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_001);
    });
    expect(host.textContent).toContain('准备材料暂时无法读取');
    await focus();
    await act(async () => old.resolve(Response.json(publication(projection, '超时的材料'))));
    expect(host.textContent).toContain('新尝试的材料');
    expect(host.textContent).not.toContain('超时的材料');
  });
});
