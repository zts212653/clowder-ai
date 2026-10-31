import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ArtifactFileSourceResolver } from '../ArtifactFileSourceResolver';
import { WorkspaceRootConnectionPanel } from '../WorkspaceRootConnectionPanel';

const fetch = vi.hoisted(() => vi.fn());
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => fetch(...args) }));

it.each([
  false,
  true,
])('restores a removed connection without silently renewing file admission (absolute: %s)', async (absolute) => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  const container = document.createElement('div');
  const root = createRoot(container);
  const opened = vi.fn();
  const admission = absolute ? ('absolute-file-directory' as const) : undefined;
  const key = `cat-cafe:workspace-root-connection:${JSON.stringify(['operator', '/A', ...(admission ? [admission] : [])])}`;
  localStorage.setItem(
    key,
    JSON.stringify({
      operationId: 'old',
      root: '/A',
      expectedEpoch: 0,
      expectedUserId: 'operator',
      connectionProof: 'old-proof',
      ...(admission ? { admission } : {}),
    }),
  );
  const writes: Record<string, unknown>[] = [];
  fetch.mockImplementation(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      writes.push(body);
      return {
        ok: true,
        json: async () => ({
          receiptRef: 'new',
          connected: true,
          root: '/A',
          ownerUserId: 'operator',
          operationId: body.operationId,
          currentEpoch: 3,
        }),
      };
    }
    return {
      ok: true,
      json: async () => ({
        receiptRef: 'old',
        connected: false,
        root: '/A',
        ownerUserId: 'operator',
        operationId: 'old',
        currentEpoch: 2,
        ...(!absolute ? { connectionProof: 'renewed-proof' } : {}),
      }),
    };
  });
  try {
    await act(async () =>
      root.render(
        <WorkspaceRootConnectionPanel
          connection={{
            kind: 'connection-required',
            ownerUserId: 'operator',
            root: '/A',
            name: 'A',
            path: 'notes.txt',
            expectedEpoch: 0,
            connectionProof: 'old-proof',
            ...(admission ? { admission } : {}),
          }}
          onConnected={opened}
        />,
      ),
    );
    expect(writes).toHaveLength(0);
    const connect = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.startsWith('连接 A'),
    );
    if (absolute) {
      expect(connect).toBeUndefined();
      expect(container.textContent).toContain('返回原入口');
    } else {
      await act(async () => connect!.click());
      expect(writes[0]).toMatchObject({ root: '/A', expectedEpoch: 2, connectionProof: 'renewed-proof' });
      expect(writes[0].operationId).not.toBe('old');
      expect(opened).toHaveBeenCalledOnce();
    }
  } finally {
    act(() => root.unmount());
    localStorage.clear();
    fetch.mockReset();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  }
});

it('names incomplete directory inventory instead of offering a new connection or an opaque service error', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  const root = createRoot(container);
  const resolved = vi.fn();
  fetch.mockResolvedValue({
    ok: false,
    status: 409,
    json: async () => ({
      error: {
        code: 'directory_inventory_unavailable',
        locations: [{ root: '/old/gone', label: 'gone' }],
      },
    }),
  });
  try {
    await act(async () =>
      root.render(
        <ArtifactFileSourceResolver
          path="notes.txt"
          title="notes.txt"
          rootSelection={{ root: '/new', branch: 'new', expectedEpoch: 0 }}
          onBack={() => undefined}
          onResolved={resolved}
        />,
      ),
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('gone');
    expect(container.querySelector('[data-testid="workspace-root-connection"]')).toBeNull();
    expect(resolved).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    fetch.mockReset();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  }
});

it.each([
  false,
  true,
])('shows shared directory consent and retains an unknown operation (absolute entrance: %s)', async (absoluteEntrance) => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  const root = createRoot(container);
  const resolved = vi.fn();
  const requests: Record<string, unknown>[] = [];
  let connected = false;
  let first = true;
  localStorage.clear();
  if (!absoluteEntrance)
    localStorage.setItem(
      `cat-cafe:workspace-root-connection:${JSON.stringify(['operator', '/chosen/A'])}`,
      JSON.stringify({ operationId: 'old-unknown', root: '/chosen/A', expectedEpoch: 0, expectedUserId: 'operator' }),
    );
  if (absoluteEntrance)
    localStorage.setItem(
      `cat-cafe:workspace-root-connection:${JSON.stringify(['operator', '/chosen/A'])}`,
      JSON.stringify({ operationId: 'other-entry', root: '/chosen/A', expectedEpoch: 0, expectedUserId: 'operator' }),
    );
  fetch.mockImplementation(async (url: string, init: RequestInit) => {
    if (url.endsWith('resolve-file-source'))
      return {
        ok: true,
        json: async () =>
          connected
            ? { kind: 'file', worktreeId: `f063_root_v1_${'a'.repeat(64)}`, path: 'notes.txt' }
            : {
                kind: 'connection-required',
                ownerUserId: 'operator',
                root: '/chosen/A',
                name: 'A',
                path: 'notes.txt',
                expectedEpoch: 0,
                connectionProof: 'verified-A',
                ...(absoluteEntrance ? { admission: 'absolute-file-directory' } : {}),
              },
      };
    if (init?.method === 'POST') {
      const payload = JSON.parse(String(init.body));
      requests.push(payload);
      if (first) {
        first = false;
        throw new Error('response lost');
      }
      connected = true;
      return {
        ok: true,
        json: async () => ({
          receiptRef: 'receipt-A',
          root: '/chosen/A',
          ownerUserId: 'operator',
          operationId: payload.operationId,
          connected: true,
          currentEpoch: 1,
        }),
      };
    }
    return { ok: false, status: 404 };
  });
  try {
    await act(async () =>
      root.render(
        <ArtifactFileSourceResolver
          path={absoluteEntrance ? '/chosen/A/notes.txt' : 'notes.txt'}
          title="notes.txt"
          worktreeId={absoluteEntrance ? undefined : 'legacy-A'}
          rootSelection={absoluteEntrance ? undefined : { root: '/chosen/A', branch: 'feature-A', expectedEpoch: 0 }}
          onBack={() => undefined}
          onResolved={resolved}
        />,
      ),
    );
    expect(container.textContent).toContain('共享目录列表');
    expect(requests).toHaveLength(0);
    expect(resolved).not.toHaveBeenCalled();
    const submit = () =>
      [...container.querySelectorAll('button')].find((button) =>
        /连接.*继续|核对并重试连接/.test(button.textContent ?? ''),
      )!;
    await act(async () => submit().click());
    expect(requests).toHaveLength(1);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('核对');
    await act(async () => submit().click());
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual(requests[1]);
    expect(requests[1]).toMatchObject({ root: '/chosen/A', expectedEpoch: 0, expectedUserId: 'operator' });
    expect(requests[1].connectionProof).toBe('verified-A');
    if (!absoluteEntrance) expect(requests[1].operationId).toBe('old-unknown');
    if (absoluteEntrance) {
      expect(requests[1].admission).toBe('absolute-file-directory');
      expect(requests[1].operationId).not.toBe('other-entry');
      expect(
        fetch.mock.calls
          .filter(([url]) => url.endsWith('resolve-file-source'))
          .map(([, init]) => JSON.parse(init.body)),
      ).toEqual([{ path: '/chosen/A/notes.txt' }, { path: '/chosen/A/notes.txt' }]);
    }
    expect(resolved).toHaveBeenCalledOnce();
  } finally {
    act(() => root.unmount());
    localStorage.clear();
    fetch.mockReset();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  }
});
