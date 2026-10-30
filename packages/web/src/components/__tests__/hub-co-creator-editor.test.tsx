import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  primeCoCreatorConfigCache,
  resetCoCreatorConfigCacheForTest,
  useCoCreatorDisplay,
} from '@/hooks/useCoCreatorConfig';
import { apiFetch } from '@/utils/api-client';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))),
}));

import { HubCoCreatorEditor } from '@/components/HubCoCreatorEditor';

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

function queryButton(_container: HTMLElement, text: string): HTMLButtonElement {
  // HubCoCreatorEditor uses createPortal(... , document.body), so query the body
  const button = Array.from(document.body.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes(text),
  );
  if (!button) throw new Error(`Missing button: ${text}`);
  return button as HTMLButtonElement;
}

describe('HubCoCreatorEditor', () => {
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
    resetCoCreatorConfigCacheForTest();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('keeps uploaded avatar path out of the form UI while preserving it in the save payload', async () => {
    mockApiFetch.mockResolvedValue(
      jsonResponse({
        config: {
          coCreator: {
            name: 'Co-worker',
            aliases: ['共创伙伴'],
            mentionPatterns: ['@co-worker', '@owner'],
            avatar: '/uploads/owner-lang.png',
          },
        },
      }),
    );
    const onSaved = vi.fn(() => Promise.resolve());
    const onClose = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(HubCoCreatorEditor, {
          open: true,
          coCreator: {
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

    expect(document.body.querySelector('input[aria-label="Owner Avatar"]')).toBeNull();
    expect(document.body.textContent).not.toContain('/uploads/owner-lang.png');

    await act(async () => {
      queryButton(container, '保存').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const patchCall = mockApiFetch.mock.calls.find(([path]) => path === '/api/config/co-creator');
    expect(patchCall?.[1]?.method).toBe('PATCH');
    const payload = JSON.parse(String(patchCall?.[1]?.body));
    expect(payload.avatar).toBe('/uploads/owner-lang.png');
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps the configured familiar address visible after saving through the existing editor', async () => {
    const coCreator = { name: 'Mina', nickname: '小明', aliases: [], mentionPatterns: ['@mina'] };
    primeCoCreatorConfigCache(coCreator);
    mockApiFetch.mockResolvedValue(jsonResponse({ config: { coCreator } }));
    function FamiliarAddress() {
      return <output data-testid="familiar-address">{useCoCreatorDisplay().nickname}</output>;
    }
    await act(async () => {
      root.render(
        <>
          <HubCoCreatorEditor open coCreator={coCreator} onClose={() => {}} onSaved={() => {}} />
          <FamiliarAddress />
        </>,
      );
    });
    expect(container.querySelector('output')?.textContent).toBe('小明');
    await act(async () => {
      queryButton(container, '保存').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();
    expect(container.querySelector('output')?.textContent).toBe('小明');
  });

  it('starts without an unconfirmed legacy address and permits explicit selection and clearing', async () => {
    const coCreator = { name: 'co-creator', nickname: '大当家', aliases: [], mentionPatterns: ['@co-creator'] };
    mockApiFetch.mockImplementation(async (_url, init) => {
      const patch = JSON.parse(String(init?.body));
      return jsonResponse({
        config: {
          coCreator: {
            ...coCreator,
            ...patch,
            ...(Object.hasOwn(patch, 'nickname')
              ? { nickname: patch.nickname ?? undefined, nicknameSource: 'user' }
              : {}),
          },
        },
      });
    });
    await act(async () => {
      root.render(<HubCoCreatorEditor open coCreator={coCreator} onClose={() => {}} onSaved={() => {}} />);
    });
    const input = document.body.querySelector<HTMLInputElement>('input[aria-label="Owner Nickname"]');
    expect(input).not.toBeNull();
    expect(input!.value).toBe('');
    // Saving another field must not interpret an untouched old value as consent.
    await act(async () => queryButton(container, '保存').click());
    expect(JSON.parse(String(mockApiFetch.mock.calls.at(-1)?.[1]?.body))).not.toHaveProperty('nickname');
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    for (const value of ['大当家', '']) {
      await act(async () => {
        setValue.call(input, value);
        input!.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () => queryButton(container, '保存').click());
      expect(JSON.parse(String(mockApiFetch.mock.calls.at(-1)?.[1]?.body)).nickname).toBe(value || null);
    }
  });
});
