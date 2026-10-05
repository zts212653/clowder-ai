import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { artifactFileLocationKey } from '../artifact-file-source';
import { LegacyArtifactFileResolver } from '../LegacyArtifactFileResolver';

const fetch = vi.hoisted(() => vi.fn());
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => fetch(...args) }));

it.each([
  false,
  true,
])('one explicit location choice completes the file entrance (prior unrelated connection=%s)', async (priorConnection) => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  const root = createRoot(container);
  const source = { threadId: 'original', artifactId: 'this-artifact', path: 'notes.txt', title: 'notes.txt' };
  const resolved = vi.fn();
  let connected = priorConnection;
  const posts: unknown[] = [];
  localStorage.clear();
  const oldOperation = {
    operationId: 'another-artifact-operation',
    root: '/A',
    expectedEpoch: 0,
    expectedUserId: 'operator',
  };
  if (priorConnection)
    localStorage.setItem(
      `cat-cafe:workspace-root-connection:${JSON.stringify(['operator', '/A'])}`,
      JSON.stringify(oldOperation),
    );
  fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith('file-locations'))
      return {
        ok: true,
        json: async () => ({
          ownerUserId: 'operator',
          inventory: 'available',
          locations: [
            { root: '/A', label: 'A', branch: 'main', status: 'available', connection: 'required', expectedEpoch: 0 },
          ],
        }),
      };
    if (url.includes('root-connections')) {
      const operation = init?.method === 'POST' ? JSON.parse(String(init.body)) : oldOperation;
      if (init?.method === 'POST') {
        posts.push(operation);
        connected = true;
      }
      return {
        ok: true,
        json: async () => ({
          receiptRef: 'root-receipt',
          connected,
          root: '/A',
          ownerUserId: 'operator',
          operationId: operation.operationId,
          currentEpoch: 1,
        }),
      };
    }
    if (url.endsWith('resolve-file-source'))
      return {
        ok: true,
        json: async () =>
          connected
            ? {
                kind: 'file',
                worktreeId: `f063_root_v1_${'a'.repeat(64)}`,
                path: 'notes.txt',
                absolutePath: '/A/notes.txt',
              }
            : {
                kind: 'connection-required',
                connectionProof: 'verified-A',
                ownerUserId: 'operator',
                root: '/A',
                name: 'A',
                path: 'notes.txt',
                absolutePath: '/A/notes.txt',
                expectedEpoch: 0,
              },
      };
    throw new Error(`Unexpected ${url}`);
  });
  try {
    await act(async () =>
      root.render(<LegacyArtifactFileResolver source={source} onResolved={resolved} onBack={() => undefined} />),
    );
    expect(resolved).not.toHaveBeenCalled();
    expect(
      fetch.mock.calls.some(([url]) => url.endsWith('resolve-file-source')),
      'a root grant for another artifact cannot select this file',
    ).toBe(false);
    expect(container.textContent).toContain('共享目录列表');
    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((button) => /^(连接 A 并继续|在 A 继续)$/.test(button.textContent ?? ''))!
        .click(),
    );
    expect(resolved).toHaveBeenCalledOnce();
    expect(posts).toHaveLength(priorConnection ? 0 : 1);
    expect(JSON.parse(localStorage.getItem(artifactFileLocationKey('operator', source))!)).toEqual({
      absolutePath: '/A/notes.txt',
      label: 'A',
    });
  } finally {
    act(() => root.unmount());
    localStorage.clear();
    fetch.mockReset();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  }
});
