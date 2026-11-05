import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorkspaceHtmlPreview } from '../WorkspaceHtmlPreview';

const transport = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: transport.apiFetch }));
let host: HTMLDivElement;
let root: Root;
let closed = false;
let requests: ((response: Response) => void)[];
const props = { worktreeId: 'root-a', path: 'index.html', content: '<h1>Original</h1>' };
const grant = (id: string) => new Response(JSON.stringify({ id, assetPath: `/api/workspace/html-preview/${id}/` }));
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  requests = [];
  transport.apiFetch.mockReset().mockImplementation((_url: string, init: RequestInit) => {
    if (init.method === 'POST') return new Promise<Response>((resolve) => requests.push(resolve));
    if (init.method === 'DELETE') return Promise.resolve(new Response(null, { status: 204 }));
    throw new Error('Unexpected preview operation');
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  closed = false;
});
afterEach(() => {
  act(() => {
    if (!closed) root.unmount();
  });
  host.remove();
});

async function respond(index: number, response: Response) {
  const reply = requests[index];
  if (!reply) throw new Error('The preview request did not start');
  await act(async () => reply(response));
}

it('owns distinct StrictMode grants and revokes a late response instead of replacing the active page', async () => {
  await act(async () =>
    root.render(
      <StrictMode>
        <WorkspaceHtmlPreview {...props} />
      </StrictMode>,
    ),
  );
  expect(requests).toHaveLength(2);
  await respond(1, grant('live'));
  const frame = host.querySelector('iframe');
  expect(frame?.srcdoc).toContain(`${window.location.origin}/api/workspace/html-preview/live/`);
  await respond(0, grant('stale'));
  expect(host.querySelector('iframe')).toBe(frame);
  expect(transport.apiFetch).toHaveBeenCalledWith('/api/workspace/html-preview/stale', { method: 'DELETE' });
  expect(transport.apiFetch).not.toHaveBeenCalledWith('/api/workspace/html-preview/live', { method: 'DELETE' });
});

it('removes the previous owner page while another root with the same path/content is preparing', async () => {
  await act(async () => root.render(<WorkspaceHtmlPreview {...props} />));
  await respond(0, grant('old-root'));
  expect(host.querySelector('iframe')).not.toBeNull();
  await act(async () => root.render(<WorkspaceHtmlPreview {...props} worktreeId="root-b" />));
  expect(host.querySelector('iframe')).toBeNull();
  expect(transport.apiFetch).toHaveBeenCalledWith('/api/workspace/html-preview/old-root', { method: 'DELETE' });
  await respond(1, grant('new-root'));
  expect(host.querySelector('iframe')?.srcdoc).toContain('/new-root/');
});

it('shows the refusal without running an unguarded document', async () => {
  await act(async () => root.render(<WorkspaceHtmlPreview {...props} />));
  await respond(0, new Response(null, { status: 403 }));
  expect(host.querySelector('iframe')).toBeNull();
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
});

it('revokes a prepared grant even when the tab closed before its response arrived', async () => {
  await act(async () => root.render(<WorkspaceHtmlPreview {...props} />));
  act(() => {
    root.unmount();
    closed = true;
  });
  await respond(0, grant('closed-tab'));
  expect(transport.apiFetch).toHaveBeenCalledWith('/api/workspace/html-preview/closed-tab', { method: 'DELETE' });
  expect(host.querySelector('iframe')).toBeNull();
});
