import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { writeShellLanguage } from '@/components/shell/shell-language';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import { F307FileOwnerSurface } from '../F307FileOwnerSurface';
import { createFileSurface } from '../real-surface-adapters';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({
  API_URL: 'http://api.test',
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}));
vi.mock('socket.io-client', () => ({ io: () => ({ on: vi.fn(), emit: vi.fn(), disconnect: vi.fn() }) }));
vi.mock('@/components/MarkdownContent', () => ({ MarkdownContent: () => null }));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  writeShellLanguage('zh');
  writeShellPresentation('v2');
  mocks.apiFetch.mockReset();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.clear();
});

async function open(path: string) {
  mocks.apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.startsWith('/api/workspace/file?'))
      return new Response(
        JSON.stringify({
          path,
          content: '<h1>Evidence</h1><img src="shots/scene.png">',
          size: 58,
          sha256: 'digest',
          mime: 'text/html',
          truncated: false,
        }),
      );
    if (url === '/api/workspace/html-preview' && init?.method === 'POST')
      return new Response(
        JSON.stringify({ id: 'preview-test', assetPath: '/api/workspace/html-preview/preview-test/' }),
      );
    if (url === '/api/workspace/html-preview/preview-test' && init?.method === 'DELETE')
      return new Response(null, { status: 204 });
    throw new Error(`unexpected route: ${url}`);
  });
  await act(async () =>
    root.render(
      <F307FileOwnerSurface
        surface={createFileSurface({ worktreeId: 'registered-html', path })}
        onRequestDetach={vi.fn()}
      />,
    ),
  );
}

it.each([
  ['zh', 'report/index.html'],
  ['en', 'report/INDEX.HTM'],
] as const)('opens HTML as a sandboxed page, switches to source and back in %s', async (language, path) => {
  writeShellLanguage(language);
  await open(path);
  const frame = container.querySelector('iframe');
  expect(frame).not.toBeNull();
  expect(frame?.getAttribute('sandbox')).toBe('allow-scripts');
  expect(frame?.srcdoc).toContain('<h1>Evidence</h1>');
  expect(frame?.srcdoc).toContain('/api/workspace/html-preview/preview-test/');
  expect(frame?.srcdoc).toContain("connect-src 'none'");
  const toolbar = container.querySelector('[data-testid="workspace-file-toolbar"]');
  assert(toolbar);
  const button = [...toolbar.querySelectorAll('button')].find(
    (item) => item.textContent === (language === 'zh' ? '看源码' : 'View source'),
  );
  expect(button).toBeDefined();
  assert(button);
  await act(async () => button.click());
  expect(container.querySelector('iframe')).toBeNull();
  const preview = [...toolbar.querySelectorAll('button')].find(
    (item) => item.textContent === (language === 'zh' ? '页面预览' : 'Page preview'),
  );
  expect(preview).toBeDefined();
  assert(preview);
  await act(async () => preview.click());
  expect(container.querySelector('iframe')).not.toBeNull();
});

it('keeps classic HTML in its existing source-first view', async () => {
  writeShellPresentation('classic');
  await open('report/index.html');
  expect(container.querySelector('iframe')).toBeNull();
  expect(mocks.apiFetch.mock.calls.some(([url]) => String(url).startsWith('/api/workspace/html-preview'))).toBe(false);
});

async function clickFileAction(label: string) {
  const button = [...container.querySelectorAll('button')].find((item) => item.textContent?.trim() === label);
  assert(button, `The current file must expose ${label}`);
  await act(async () => button.click());
}

async function exposeFileTools() {
  if (!container.querySelector('[data-testid="workspace-file-toolbar"]')) await clickFileAction('文件工具');
}

it.each([
  ['classic', 'v2'],
  ['v2', 'classic'],
] as const)('resets the same HTML owner from %s to %s without losing a choice within one presentation', async (initial, next) => {
  const path = 'report/index.html';
  writeShellPresentation(initial);
  await open(path);
  await exposeFileTools();
  expect(!!container.querySelector('iframe')).toBe(initial === 'v2');

  await clickFileAction(initial === 'v2' ? '看源码' : 'Code');
  expect(!!container.querySelector('iframe')).toBe(initial !== 'v2');
  // The same surface and path rerender: a user's mode choice must not be reset by ordinary owner updates.
  await open(path);
  expect(!!container.querySelector('iframe')).toBe(initial !== 'v2');
  await clickFileAction(initial === 'v2' ? '页面预览' : 'Preview');
  expect(!!container.querySelector('iframe')).toBe(initial === 'v2');

  await act(async () => writeShellPresentation(next));
  await exposeFileTools();
  expect(!!container.querySelector('iframe')).toBe(next === 'v2');
  expect(mocks.apiFetch.mock.calls.filter(([url]) => String(url).startsWith('/api/workspace/file?'))).toHaveLength(1);
});
