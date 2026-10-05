import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/utils/api-client';
import { OwnerPageActionControl } from '../OwnerPageActionControl';

const fetchMock = vi.mocked(apiFetch);
const route = '/api/concierge/page-action';
const preview = {
  previewId: '11111111-1111-4111-8111-111111111111',
  pageUrl: 'http://127.0.0.1:5227/',
  field: 'Note text',
  fieldSelector: '#note-input',
  readbackSelector: '#readback',
  value: 'F317 local trial',
  expectedReadback: '{"open":false,"note":"F317 local trial","deleted":false}',
  restoreValue: '',
  expiresAtMs: Date.now() + 60_000,
  permissionScope: 'f317-local-note',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

let container: HTMLDivElement;
let root: Root;
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  fetchMock.mockReset();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it('hides the action when no Host-selected named page is installed', async () => {
  fetchMock.mockResolvedValue(json({ kind: 'unavailable' }));
  await act(async () => root.render(<OwnerPageActionControl />));
  expect(container.querySelector('[aria-label="页面操作授权"]')).toBeNull();
  expect(fetchMock).toHaveBeenCalledWith(route, undefined, { afterCurrentGet: false });
});

it('shows exact consent before Allow once and sends only an opaque preview ID', async () => {
  let state: 'ready' | 'awaiting_consent' | 'settled' = 'ready';
  fetchMock.mockImplementation(async (url, init) => {
    if (url === route && !init?.method)
      return json({
        kind: 'available',
        requestMessageId: 'direct-source',
        requestText: '把隔离便签写成固定试验值',
        pageUrl: preview.pageUrl,
        state,
        ...(state === 'awaiting_consent' ? { preview } : {}),
        ...(state === 'settled'
          ? {
              result: {
                status: 'unknown',
                forward: { status: 'applied', before: '', after: preview.expectedReadback },
              },
            }
          : {}),
      });
    if (url === `${route}/inspect` && init?.method === 'POST') {
      state = 'awaiting_consent';
      return json({ kind: 'awaiting_consent', preview });
    }
    if (url === `${route}/confirm` && init?.method === 'POST') {
      state = 'settled';
      return json({ status: 'unknown' });
    }
    return json({}, 404);
  });
  await act(async () => root.render(<OwnerPageActionControl />));
  expect(container.textContent).toContain('把隔离便签写成固定试验值');
  expect(container.textContent).not.toContain('允许一次并恢复');

  const inspect = Array.from(container.querySelectorAll('button')).find((button) =>
    button.textContent?.includes('检查具名页面'),
  );
  await act(async () => inspect?.click());
  expect(container.textContent).toContain(preview.pageUrl);
  expect(container.textContent).toContain('#note-input');
  expect(container.textContent).toContain('#readback');
  expect(container.textContent).toContain(preview.expectedReadback);
  expect(container.textContent).toContain('恢复原值：空值');
  const inspectCall = fetchMock.mock.calls.find((call) => call[0] === `${route}/inspect`);
  expect(JSON.parse(inspectCall?.[1]?.body as string)).toEqual({ requestMessageId: 'direct-source' });

  const allow = Array.from(container.querySelectorAll('button')).find((button) =>
    button.textContent?.includes('允许一次并恢复'),
  );
  await act(async () => allow?.click());
  const confirmCalls = fetchMock.mock.calls.filter((call) => call[0] === `${route}/confirm`);
  expect(confirmCalls).toHaveLength(1);
  expect(JSON.parse(confirmCalls[0]?.[1]?.body as string)).toEqual({ previewId: preview.previewId });
  expect(container.textContent).toContain('页面或恢复结果未确认；不会自动重试');
});
