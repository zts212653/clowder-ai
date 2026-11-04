import { MAX_HTML_WORK_BYTES } from '@cat-cafe/shared';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { writeShellLanguage } from '@/components/shell/shell-language';
import { useChatStore } from '@/stores/chatStore';
import { WorkContentBoundary } from '../WorkContentBoundary';

const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: api.fetch, API_URL: '' }));
const ref = { contentRef: `work:${'a'.repeat(64)}`, ownerRevision: 2 };
let host: HTMLDivElement, root: Root;
const back = vi.fn(),
  change = vi.fn();
function meta(revision = 2, mediaType = 'text/html') {
  return {
    reference: { ...ref, ownerRevision: revision },
    currentOwnerRevision: 2,
    description: { mediaType },
    version: { title: `计算器 v${revision}` },
  };
}
function body(revision = 2) {
  return {
    reference: { ...ref, ownerRevision: revision },
    mediaType: 'text/html',
    html: `<button onclick="bad()">v${revision}</button><script>document.title="v${revision}"</script>`,
  };
}
async function render(revision = 2, threadId = 'source-thread', children: ReactNode = <div>Original video owner</div>) {
  await act(async () =>
    root.render(
      <WorkContentBoundary
        reference={{ ...ref, ownerRevision: revision }}
        threadId={threadId}
        sourceThreadId={threadId}
        onBack={back}
        onVersionChange={change}
      >
        {children}
      </WorkContentBoundary>,
    ),
  );
}
function action(init: RequestInit) {
  return JSON.parse(String(init.body)).command;
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  writeShellLanguage('zh');
  useChatStore.setState({ currentThreadId: 'source-thread' });
  api.fetch.mockReset();
  back.mockReset();
  change.mockReset();
  api.fetch.mockImplementation(async (_url, init) => {
    const c = action(init);
    return Response.json(c.action === 'read' ? meta(c.reference.ownerRevision) : body(c.reference.ownerRevision));
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it('opens the exact authorized HTML version through the existing sandbox; version selection sends only reads', async () => {
  await render();
  let frame = host.querySelector('iframe');
  expect(frame?.title).toBe('计算器 v2');
  expect(frame?.getAttribute('srcdoc')).toContain('v2');
  expect(frame?.getAttribute('srcdoc')).not.toContain('onclick');
  expect(frame?.getAttribute('sandbox')).toBe('allow-scripts');
  expect(frame?.getAttribute('referrerpolicy')).toBe('no-referrer');
  const selector = host.querySelector('select');
  if (!selector) throw new Error('Version selector is missing');
  expect([...selector.options].map((o) => o.textContent)).toEqual(['第 1 版 · 历史', '第 2 版 · 当前']);
  act(() => {
    selector.value = '1';
    selector.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(change).toHaveBeenCalledWith(1);
  await render(1);
  frame = host.querySelector('iframe');
  expect(frame?.getAttribute('srcdoc')).toContain('v1');
  expect(frame?.getAttribute('srcdoc')).not.toContain('v2');
  const commands = api.fetch.mock.calls.map((call) => action(call[1]));
  expect(commands.map((c) => c.action)).toEqual(['read', 'read-body', 'read', 'read-body']);
  expect(commands.map((c) => c.reference)).toEqual([
    ref,
    ref,
    { ...ref, ownerRevision: 1 },
    { ...ref, ownerRevision: 1 },
  ]);
  act(() => host.querySelector('button')?.click());
  expect(back).toHaveBeenCalledOnce();
});

it.each([401, 403, 404])('does not render a fallback for denied or missing version (%i)', async (status) => {
  api.fetch.mockResolvedValue(new Response('{}', { status }));
  await render(1);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('找不到第 1 版，或你没有查看权限');
  expect(host.querySelector('iframe')).toBeNull();
  expect(host.textContent).not.toContain('Original video owner');
});
it.each([
  'bad-json',
  'wrong-metadata-version',
  'wrong-body-version',
  'wrong-handle',
  'wrong-type',
  'oversize',
  'server-error',
])('reports corrupt/unavailable data honestly: %s', async (failure) => {
  api.fetch.mockImplementation(async (_url, init) => {
    const c = action(init);
    if (failure === 'server-error') return new Response('{}', { status: 500 });
    if (failure === 'bad-json') return new Response('{');
    if (c.action === 'read') return Response.json(failure === 'wrong-metadata-version' ? meta(1) : meta());
    const result = body();
    if (failure === 'wrong-body-version') result.reference.ownerRevision = 1;
    if (failure === 'wrong-handle') result.reference.contentRef = `work:${'b'.repeat(64)}`;
    if (failure === 'wrong-type') result.mediaType = 'video/mp4';
    if (failure === 'oversize') result.html = '猫'.repeat(Math.floor(MAX_HTML_WORK_BYTES / 3) + 1);
    return Response.json(result);
  });
  await render();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('内容未能验证');
  expect(host.querySelector('iframe')).toBeNull();
});
it('clears the previous iframe while another version loads and discards an aborted late body', async () => {
  await render();
  const oldFrame = host.querySelector('iframe');
  let resolveOld: (response: Response) => void = () => {};
  api.fetch.mockImplementation((_url, init) => {
    const c = action(init);
    if (c.reference.ownerRevision === 1 && c.action === 'read-body')
      return new Promise<Response>((resolve) => {
        resolveOld = resolve;
      });
    return Promise.resolve(
      Response.json(c.action === 'read' ? meta(c.reference.ownerRevision) : body(c.reference.ownerRevision)),
    );
  });
  await render(1);
  expect(host.querySelector('iframe')).toBeNull();
  expect(host.textContent).toContain('正在读取第 1 版');
  await render(2);
  expect(host.querySelector('iframe')).not.toBe(oldFrame);
  await act(async () => resolveOld(Response.json(body(1))));
  expect(host.querySelector('iframe')?.getAttribute('srcdoc')).toContain('v2');
  expect(host.querySelector('iframe')?.getAttribute('srcdoc')).not.toContain('v1');
});
it('changing thread discards cached body, reauthorizes, and never keeps a revoked iframe', async () => {
  await render();
  api.fetch.mockResolvedValue(new Response('{}', { status: 403 }));
  await render(2, 'another-thread');
  expect(host.querySelector('iframe')).toBeNull();
  expect(JSON.parse(api.fetch.mock.calls.at(-1)?.[1].body).threadId).toBe('another-thread');
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
});
it('retry recovers this exact version and the existing video path still owns MP4 without a body fetch', async () => {
  api.fetch.mockResolvedValueOnce(new Response('{}', { status: 503 }));
  await render();
  await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent === '重试')?.click());
  expect(host.querySelector('iframe')).not.toBeNull();
  api.fetch.mockClear();
  api.fetch.mockResolvedValue(Response.json(meta(1, 'video/mp4')));
  await render(1);
  expect(host.textContent).toContain('Original video owner');
  expect(host.querySelector('iframe')).toBeNull();
  expect(api.fetch.mock.calls.map((call) => action(call[1]).action)).toEqual(['read']);
});

it('refreshes the authorized version catalogue after another submit without switching or reloading the fixed iframe', async () => {
  await render();
  const frame = host.querySelector('iframe');
  api.fetch.mockClear();
  api.fetch.mockResolvedValue(Response.json({ ...meta(), currentOwnerRevision: 3 }));
  await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent === '刷新版本')?.click());
  expect(host.querySelector('iframe')).toBe(frame);
  expect(host.querySelector('iframe')?.getAttribute('srcdoc')).toContain('v2');
  expect(host.querySelector('select')?.value).toBe('2');
  expect(host.querySelector('select')?.textContent).toContain('第 3 版 · 当前');
  expect(host.querySelector('select')?.textContent).toContain('第 2 版 · 历史');
  expect(api.fetch.mock.calls.map((call) => action(call[1]).action)).toEqual(['read']);
  api.fetch.mockResolvedValue(new Response('{}', { status: 403 }));
  await act(async () => window.dispatchEvent(new Event('cat-cafe:entrusted-work-projection-invalidated')));
  expect(host.querySelector('iframe')).toBeNull();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('没有查看权限');
});

it('changing shell language updates version controls without reloading the work or its iframe', async () => {
  await render();
  const frame = host.querySelector('iframe');
  api.fetch.mockClear();
  act(() => writeShellLanguage('en'));
  expect(host.querySelector('section')?.getAttribute('aria-label')).toBe('HTML work preview');
  expect(host.querySelector('select')?.getAttribute('aria-label')).toBe('Work version');
  expect(host.querySelector('select')?.textContent).toContain('Version 2 · Current');
  expect(host.querySelector('iframe')).toBe(frame);
  expect(api.fetch).not.toHaveBeenCalled();
});

it('reads the original Work thread when its host is the new-conversation page', async () => {
  useChatStore.setState({ currentThreadId: 'default' });
  api.fetch.mockImplementation(async (_url, init) => {
    if (JSON.parse(String(init.body)).threadId !== 'source-thread') return Response.json({}, { status: 403 });
    return Response.json(action(init).action === 'read' ? meta() : body());
  });
  await act(async () =>
    root.render(
      <WorkContentBoundary
        reference={ref}
        threadId="default"
        sourceThreadId="source-thread"
        onBack={back}
        onVersionChange={change}
      >
        <div>Original video owner</div>
      </WorkContentBoundary>,
    ),
  );
  expect(host.querySelector('iframe')?.getAttribute('srcdoc')).toContain('v2');
  expect(api.fetch.mock.calls.map(([, init]) => JSON.parse(String(init.body)).threadId)).toEqual([
    'source-thread',
    'source-thread',
  ]);
});

it('keeps existing media publications on their original owner without a new Work metadata prerequisite', async () => {
  api.fetch.mockResolvedValue(Response.json({}, { status: 403 }));
  await act(async () =>
    root.render(
      <WorkContentBoundary reference={ref} threadId="default" onBack={back} onVersionChange={change}>
        <div>Existing media remains readable</div>
      </WorkContentBoundary>,
    ),
  );
  expect(host.textContent).toContain('Existing media remains readable');
  expect(api.fetch).not.toHaveBeenCalled();
});
