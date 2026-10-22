import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import type { DriftType } from '../drift-types';
import { useDriftSync } from '../useDriftSync';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.resetAllMocks());

it.each<DriftType>([
  'mcp',
  'skill',
])('continues %s sync after scope failures and refreshes actual results', async (type) => {
  const paths = ['/projects/broken', '/projects/healthy', '/other/broken'];
  const resolved: Array<string | undefined> = [];
  let didSync = false;
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    const { projectPath } = JSON.parse(String(init?.body));
    if (url === '/api/drift/resolve') {
      resolved.push(projectPath);
      if (projectPath !== paths[1]) {
        return new Response(JSON.stringify({ error: `unwritable ${projectPath ?? 'global'}` }), { status: 500 });
      }
      didSync = true;
      return new Response('{}');
    }
    const issues =
      projectPath && !(projectPath === paths[1] && didSync)
        ? [{ id: 'missing', issueType: 'global-new', message: 'Pending sync' }]
        : [];
    return new Response(JSON.stringify({ result: { issues, driftHash: 'current' } }));
  });
  let current!: ReturnType<typeof useDriftSync>;
  function Host() {
    current = useDriftSync({ type, projectPaths: paths });
    return <div role="alert">{current.syncAllError}</div>;
  }
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Host />));
    expect(current.projectConsistency.syncedProjects).toBe(0);
    await act(async () => current.handleSyncAllScopes());
    expect(resolved).toEqual(type === 'skill' ? [undefined, ...paths] : paths);
    expect(current.projectConsistency.syncedProjects).toBe(1);
    expect(current.scopeDrift[paths[1]].issues).toEqual([]);
    expect(current.syncing).toBe(false);
    expect(container.textContent).toContain(`${paths[0]}: unwritable ${paths[0]}`);
    expect(container.textContent).toContain(`${paths[2]}: unwritable ${paths[2]}`);
    if (type === 'skill') expect(container.textContent).toContain('全局: unwritable global');
  } finally {
    await act(async () => root.unmount());
  }
});

it('keeps healthy project reports when the global status request fails', async () => {
  vi.mocked(apiFetch).mockImplementation(async (_url, init) => {
    const { projectPath } = JSON.parse(String(init?.body));
    if (!projectPath) return new Response('{}', { status: 503 });
    return new Response(JSON.stringify({ result: { issues: [], driftHash: 'healthy-project' } }));
  });
  let current!: ReturnType<typeof useDriftSync>;
  function Host() {
    current = useDriftSync({ type: 'mcp', projectPaths: ['/projects/healthy'] });
    return null;
  }
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(<Host />));
    expect(current.scopeDrift['/projects/healthy']?.driftHash).toBe('healthy-project');
    expect(current.scopeDrift.global.issues[0].message).toContain('全局');
    expect(current.scopeDrift.global.issues[0].message).toContain('503');
  } finally {
    await act(async () => root.unmount());
  }
});

it('shows Fastify registry details for check, single sync and all-project sync failures', async () => {
  const message = 'Cannot synchronize global capabilities at /host/.cat-cafe/capabilities.json: parse_error';
  const resolved: string[] = [];
  const failure = () =>
    new Response(JSON.stringify({ statusCode: 500, error: 'Internal Server Error', message }), { status: 500 });
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    const { projectPath } = JSON.parse(String(init?.body));
    if (url === '/api/drift/resolve') {
      resolved.push(projectPath);
      return projectPath === '/projects/broken' ? failure() : new Response('{}');
    }
    if (!projectPath) return failure();
    return new Response(JSON.stringify({ result: { issues: [], driftHash: 'healthy' } }));
  });
  let current!: ReturnType<typeof useDriftSync>;
  function Host() {
    current = useDriftSync({ type: 'mcp', projectPaths: ['/projects/broken', '/projects/healthy'] });
    return <div role="alert">{current.syncAllError}</div>;
  }
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Host />));
    expect(current.scopeDrift.global.issues[0].message).toContain(message);
    await act(async () => current.handleSyncScope('/projects/broken'));
    expect(container.textContent).toBe(message);
    resolved.length = 0;
    await act(async () => current.handleSyncAllScopes());
    expect(resolved).toEqual(['/projects/broken', '/projects/healthy']);
    expect(container.textContent).toBe(`/projects/broken: ${message}`);
    expect(current.scopeDrift['/projects/healthy'].driftHash).toBe('healthy');
  } finally {
    await act(async () => root.unmount());
  }
});
