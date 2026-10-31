import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CreateCollectionDialog } from '../CreateCollectionDialog';

const request = vi.hoisted(() => vi.fn());
vi.mock('@/utils/api-client', () => ({ apiFetch: request }));
let container: HTMLDivElement;
let root: Root;
const closed = vi.fn();
const created = vi.fn();
const response = (value: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(value), { status }));
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn());
  request.mockImplementation((path: string) =>
    response(
      path === '/api/library/register'
        ? { manifest: { id: 'domain:notes' } }
        : { indexed: 0, skipped: 0, blocked: false },
    ),
  );
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});
const render = async () => {
  await act(async () => root.render(<CreateCollectionDialog onClose={closed} onCreated={created} />));
};
const input = async (index: number, value: string) => {
  const element = container.querySelectorAll('input')[index];
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const button = (name: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === name)!;
const click = async (name: string) => {
  await act(async () => button(name).click());
};
const fill = async () => {
  await input(0, 'notes');
  await input(1, '学习笔记');
};

it('shows Chinese visibility and destination, uses session API transport, and rebuilds the newly registered id', async () => {
  await render();
  await fill();
  expect(container.textContent).toContain('新建资料库');
  expect(container.textContent).toContain('学习笔记 · 私有可见');
  expect(container.textContent).not.toContain('restricted');
  await click('创建');
  expect(JSON.parse(request.mock.calls[0][1].body)).toMatchObject({
    id: 'domain:notes',
    displayName: '学习笔记',
    sensitivity: 'private',
  });
  expect(request.mock.calls[1][0]).toBe('/api/library/domain%3Anotes/rebuild');
  expect(created).toHaveBeenCalledOnce();
  expect(fetch).not.toHaveBeenCalled();
});

it('a registered collection with a failed rebuild stays honest and retry never registers it twice', async () => {
  request.mockImplementation((path: string) =>
    response({ manifest: { id: 'domain:notes' } }, path.endsWith('/rebuild') ? 500 : 200),
  );
  await render();
  await fill();
  await click('创建');
  expect(created).not.toHaveBeenCalled();
  expect(container.textContent).toContain('资料库已建好，索引暂时没有建好');
  expect(container.querySelector('input')?.matches(':disabled')).toBe(true);
  request.mockImplementation(() => response({ indexed: 0, skipped: 0, blocked: false }));
  await click('重试索引');
  expect(request.mock.calls.filter(([path]) => path === '/api/library/register')).toHaveLength(1);
  expect(created).toHaveBeenCalledOnce();
});

it('an invalid register success or blocked rebuild cannot be reported as a completed creation', async () => {
  request.mockImplementation(() => response({}));
  await render();
  await fill();
  await click('创建');
  expect(created).not.toHaveBeenCalled();
  expect(request).toHaveBeenCalledOnce();
  expect(container.textContent).toContain('没有确认创建成功');
  request.mockImplementation((path: string) =>
    response(
      path.endsWith('/register') ? { manifest: { id: 'domain:notes' } } : { indexed: 0, skipped: 0, blocked: true },
    ),
  );
  await click('创建');
  expect(created).not.toHaveBeenCalled();
  expect(container.textContent).toContain('资料库已建好，索引暂时没有建好');
});

it('a bound directory must be scanned; changing the path discards the previous scan', async () => {
  await render();
  await fill();
  await input(2, '/isolated/docs');
  expect(button('创建').disabled).toBe(true);
  request.mockImplementation(() => response({ totalFiles: 5, markdownFiles: 3, secretFindings: 1, safe: false }));
  await click('预览扫描');
  expect(container.textContent).toContain('1 个敏感信息');
  await input(2, '/isolated/other');
  expect(container.querySelector('[data-testid="dry-run-preview"]')).toBeNull();
  expect(button('创建').disabled).toBe(true);
});

it('Escape closes idle dialogs, and writer errors never expose server paths', async () => {
  await render();
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
  expect(closed).toHaveBeenCalledOnce();
  request.mockImplementation(() => response({ error: 'Unknown /secret/path' }, 500));
  await fill();
  await click('创建');
  expect(container.textContent).toContain('暂时没有创建成功');
  expect(container.textContent).not.toContain('/secret/path');
});

it('a mismatched registered id cannot trigger indexing or report creation', async () => {
  request.mockImplementation(() => response({ manifest: { id: 'domain:another' } }));
  await render();
  await fill();
  await click('创建');
  expect(created).not.toHaveBeenCalled();
  expect(request).toHaveBeenCalledOnce();
  expect(container.textContent).toContain('没有确认创建成功');
});

it.each(['scan', 'register'] as const)('Escape cannot close a dialog while %s is in flight', async (operation) => {
  let resolveRequest!: (value: Response) => void;
  request.mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        resolveRequest = resolve;
      }),
  );
  await render();
  await fill();
  if (operation === 'scan') await input(2, '/isolated/docs');
  await click(operation === 'scan' ? '预览扫描' : '创建');
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
  expect(closed).not.toHaveBeenCalled();
  expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  await act(async () => resolveRequest(new Response('{}', { status: 500 })));
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
  expect(closed).toHaveBeenCalledOnce();
});
