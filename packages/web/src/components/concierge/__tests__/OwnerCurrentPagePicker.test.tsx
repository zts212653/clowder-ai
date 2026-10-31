import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/utils/api-client';
import { OwnerCurrentPagePicker } from '../OwnerCurrentPagePicker';

it('lists pages only on owner click and selects an opaque page ID without URL, selector, or execution authority', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const fetch = vi.mocked(apiFetch);
  const pageId = '11111111-1111-4111-8111-111111111111';
  fetch.mockReset();
  fetch
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ pages: [{ pageId, title: '临时页面', url: 'https://example.test/work' }] })),
    )
    .mockResolvedValueOnce(new Response('{}'));
  const container = document.createElement('div');
  const root = createRoot(container);
  const refresh = vi.fn().mockResolvedValue(undefined);
  try {
    await act(async () =>
      root.render(<OwnerCurrentPagePicker requestMessageId="direct-source" disabled={false} onSelected={refresh} />),
    );
    expect(fetch).not.toHaveBeenCalled();
    await act(async () => container.querySelector('button')?.click());
    expect(fetch.mock.calls[0][0]).toBe('/api/concierge/page-action/pages');
    expect(container.textContent).toContain('控件标签交给 Jev');
    await act(async () => container.querySelector<HTMLButtonElement>('section button')?.click());
    expect(fetch.mock.calls[1][0]).toBe('/api/concierge/page-action/select');
    expect(JSON.parse(String(fetch.mock.calls[1][1]?.body))).toEqual({ requestMessageId: 'direct-source', pageId });
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/confirm'))).toBe(false);
  } finally {
    act(() => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  }
});
