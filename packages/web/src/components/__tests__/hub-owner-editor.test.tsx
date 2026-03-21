import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))),
}));

import { HubOwnerEditor } from '@/components/HubOwnerEditor';

const mockApiFetch = vi.mocked(apiFetch);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
  });
}

function queryButton(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes(text),
  );
  if (!button) throw new Error(`Missing button: ${text}`);
  return button as HTMLButtonElement;
}

describe('HubOwnerEditor', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockApiFetch.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('keeps uploaded avatar path out of the form UI while preserving it in the save payload', async () => {
    mockApiFetch.mockResolvedValue(jsonResponse({ ok: true }));
    const onSaved = vi.fn(() => Promise.resolve());
    const onClose = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(HubOwnerEditor, {
          open: true,
          owner: {
            name: 'Co-worker',
            aliases: ['共创伙伴'],
            mentionPatterns: ['@co-worker', '@owner'],
            avatar: '/uploads/owner-lang.png',
            color: { primary: '#D4A76A', secondary: '#FFF8F0' },
          },
          onClose,
          onSaved,
        }),
      );
    });
    await flushEffects();

    expect(container.querySelector('input[aria-label="Owner Avatar"]')).toBeNull();
    expect(container.textContent).not.toContain('/uploads/owner-lang.png');

    await act(async () => {
      queryButton(container, '保存 Owner').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const patchCall = mockApiFetch.mock.calls.find(([path]) => path === '/api/config/owner');
    expect(patchCall?.[1]?.method).toBe('PATCH');
    const payload = JSON.parse(String(patchCall?.[1]?.body));
    expect(payload.avatar).toBe('/uploads/owner-lang.png');
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
