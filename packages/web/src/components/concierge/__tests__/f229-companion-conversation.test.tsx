import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { resetConciergeDesktopObservation, useConciergeDesktopStore } from '@/stores/conciergeDesktopStore';
import { useConciergeStore } from '@/stores/conciergeStore';
import { apiFetch } from '@/utils/api-client';
import { useCompanionConversation } from '../useCompanionConversation';

let root: Root, container: HTMLDivElement;
function Harness({ threadId }: { threadId: string }) {
  const companion = useCompanionConversation(threadId);
  return (
    <>
      {companion.header}
      <output data-testid="seed">{companion.composerSeed?.text}</output>
    </>
  );
}
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  resetConciergeDesktopObservation();
  useConciergeStore.setState({ threadId: 'companion-original', pendingPrompt: null });
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify({ kind: 'unavailable' })));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  resetConciergeDesktopObservation();
});
it('hosts the actual page authorization in the original companion thread and leaves other threads untouched', async () => {
  const preview = {
    previewId: 'opaque-preview',
    pageUrl: 'http://127.0.0.1:5459/',
    field: '备注',
    fieldSelector: '#note',
    readbackSelector: '#readback',
    value: '合成值',
    expectedReadback: '合成值',
    permissionScope: 'synthetic-note',
    expiresAtMs: Date.now() + 60000,
  };
  let state = 'awaiting_consent';
  vi.mocked(apiFetch).mockImplementation(async (url, options) => {
    if (options?.method === 'POST') {
      state = 'settled';
      return new Response('{}');
    }
    return new Response(
      JSON.stringify({
        kind: 'available',
        requestMessageId: 'owner-source',
        requestText: '修改合成页面',
        pageUrl: preview.pageUrl,
        state,
        preview: state === 'awaiting_consent' ? preview : undefined,
        result:
          state === 'settled'
            ? {
                status: 'applied',
                forward: { status: 'applied', before: '', after: '合成值' },
                receiptPersistence: 'stored',
              }
            : undefined,
      }),
    );
  });
  await act(async () => root.render(<Harness threadId="other" />));
  expect(vi.mocked(apiFetch)).not.toHaveBeenCalled();
  await act(async () => root.render(<Harness threadId="companion-original" />));
  expect(container.querySelector('[aria-label="页面操作授权"]')).not.toBeNull();
  const button = [...container.querySelectorAll('button')].find((x) => x.textContent?.includes('允许'));
  expect(button).toBeDefined();
  await act(async () => button?.click());
  const confirms = vi
    .mocked(apiFetch)
    .mock.calls.filter(([url, options]) => url.endsWith('/confirm') && options?.method === 'POST');
  expect(confirms).toHaveLength(1);
  expect(JSON.parse(String(confirms[0][1]?.body))).toEqual({ previewId: 'opaque-preview' });
  expect(container.textContent).toContain('已核对页面修改');
});
it('consumes an explicit pending prompt only in its original composer and does not replay it on return', async () => {
  useConciergeStore.setState({ pendingPrompt: '请教我原功能' });
  await act(async () => root.render(<Harness threadId="other" />));
  expect(useConciergeStore.getState().pendingPrompt).toBe('请教我原功能');
  await act(async () => root.render(<Harness threadId="companion-original" />));
  expect(container.querySelector('[data-testid="seed"]')?.textContent).toBe('请教我原功能');
  expect(useConciergeStore.getState().pendingPrompt).toBeNull();
  await act(async () => root.render(<Harness threadId="other" />));
  await act(async () => root.render(<Harness threadId="companion-original" />));
  expect(container.querySelector('[data-testid="seed"]')?.textContent).toBe('');
});
it('puts desktop recovery information inside the explicitly opened conversation without changing configuration', async () => {
  useConciergeDesktopStore.setState({ desktopLost: true, available: false });
  await act(async () => root.render(<Harness threadId="companion-original" />));
  expect(container.textContent).toContain('桌面猫猫暂时不在线');
  expect(container.querySelector('a[href="/settings?s=plugins"]')).not.toBeNull();
  expect(vi.mocked(apiFetch).mock.calls.some(([, options]) => options?.method === 'PUT')).toBe(false);
});

it('keeps a failed explicit desktop restore honest and leaves the original conversation available', async () => {
  useConciergeDesktopStore.setState({ desktopLost: true, available: false });
  await act(async () => root.render(<Harness threadId="companion-original" />));
  const restore = [...container.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('重新打开桌面'),
  );
  expect(restore).toBeDefined();
  await act(async () => restore?.click());
  expect(container.textContent).toContain('未能重新打开');
  expect(container.querySelector('[aria-label="伴随对话入口"]')).not.toBeNull();
  expect(vi.mocked(apiFetch).mock.calls.filter(([url]) => url === '/api/concierge/desktop/show')).toHaveLength(1);
  expect(vi.mocked(apiFetch).mock.calls.some(([, options]) => options?.method === 'PUT')).toBe(false);
});
