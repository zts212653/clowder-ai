import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import WorkspaceHtmlPage from '@/app/workspace-html/page';
import { writeShellLanguage } from '@/components/shell/shell-language';
import { apiFetch } from '@/utils/api-client';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/SessionBootstrap', () => ({ SessionBootstrap: () => null }));
let container: HTMLDivElement;
let root: Root;
const render = () =>
  act(async () =>
    root.render(
      await WorkspaceHtmlPage({
        searchParams: Promise.resolve({ worktreeId: 'tree', path: 'docs/Test %20.htm' }),
      }),
    ),
  );
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  writeShellLanguage('en');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

test('renders an opaque sandbox with a revocable same-directory base', async () => {
  const assetPath = '/api/workspace/html-preview/grant/';
  const body = '<link rel="stylesheet" href="site.css"><img src="diagram.png"><script src="site.js"></script>';
  vi.mocked(apiFetch)
    .mockResolvedValueOnce(Response.json({ content: body }))
    .mockResolvedValueOnce(Response.json({ id: 'grant', assetPath }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  await render();
  const iframe = container.querySelector('iframe');
  expect(iframe?.getAttribute('sandbox')).toBe('allow-scripts');
  expect(iframe?.srcdoc).toContain("connect-src 'none'");
  expect(iframe?.srcdoc).toContain(new URL(assetPath, location.origin).href);
  expect(iframe?.srcdoc).toContain(body);
  expect(apiFetch).toHaveBeenCalledTimes(2);
  expect(vi.mocked(apiFetch).mock.calls[0][0]).toBe('/api/workspace/file?worktreeId=tree&path=docs%2FTest+%2520.htm');
  await act(async () => root.render(null));
  expect(apiFetch).toHaveBeenLastCalledWith('/api/workspace/html-preview/grant', { method: 'DELETE' });
});

test.each([
  [403, 'You do not have permission to read this file.'],
  [404, 'The file does not exist.'],
  [503, 'Preview unavailable.'],
])('reports source status %s inside the original surface without sending a native action', async (status, expected) => {
  vi.mocked(apiFetch).mockResolvedValueOnce(new Response(null, { status }));
  await render();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(expected);
  expect(container.querySelector('iframe')).toBeNull();
  expect(apiFetch).toHaveBeenCalledTimes(1);
});
