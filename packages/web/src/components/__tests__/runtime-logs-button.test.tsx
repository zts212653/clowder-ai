import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { RuntimeLogsButton } from '@/components/RightStatusPanel';
import { useChatStore } from '@/stores/chatStore';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ API_URL: 'http://api.test', apiFetch: mocks.apiFetch }));

const LOGS_DIR = 'packages/api/data/logs/api';
const initial = useChatStore.getState();
let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  mocks.apiFetch.mockReset();
  useChatStore.setState({ currentThreadId: 'thread-a', workspaceOpenRequest: null, workspaceOpenFilePath: null });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useChatStore.setState(initial, true);
});
afterAll(() => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

function logsOwner(listing: Response) {
  mocks.apiFetch.mockImplementation(async (url: string) => {
    if (url === '/api/workspace/worktrees') return new Response(JSON.stringify({ worktrees: [{ id: 'wt-1' }] }));
    if (url.startsWith('/api/workspace/tree?')) return listing;
    throw new Error(`unexpected route ${url}`);
  });
}

async function click() {
  await act(async () => root.render(<RuntimeLogsButton threadId="thread-a" />));
  await act(async () => container.querySelector<HTMLButtonElement>('button')?.click());
  for (let i = 0; i < 4; i += 1) await act(async () => Promise.resolve());
}

it('opens the newest log file when there is one, without a separate reveal', async () => {
  logsOwner(
    new Response(
      JSON.stringify({
        tree: [
          { name: 'api.2026-09-23.1.log', type: 'file' },
          { name: 'api.2026-09-24.2.log', type: 'file' },
        ],
      }),
    ),
  );
  await click();
  expect(useChatStore.getState().workspaceOpenFilePath).toBe(`${LOGS_DIR}/api.2026-09-24.2.log`);
  expect(useChatStore.getState().workspaceOpenRequest).toBeNull();
});

it.each([
  ['has no log files yet', new Response(JSON.stringify({ tree: [] }))],
  ['cannot be listed', new Response(JSON.stringify({ error: 'not found' }), { status: 404 })],
])('shows the logs directory itself when it %s', async (_case, listing) => {
  logsOwner(listing);
  await click();
  expect(useChatStore.getState().workspaceOpenRequest).toMatchObject({
    threadId: 'thread-a',
    target: { kind: 'reveal', worktreeId: 'wt-1', path: LOGS_DIR, navigationOrigin: { kind: 'workspace-card' } },
  });
  expect(useChatStore.getState().workspaceOpenFilePath).toBeNull();
});
