import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { ActionRenderer } from '../ActionRenderer';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

const container = document.createElement('div');
const root = createRoot(container);
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

it('shows and independently copies the URL label and connection message from one action result', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.appendChild(container);
  const url = 'https://fixture.example/mcp?token=private-token';
  const message = '请连接这个 Work 对话：events/subscribe dot.summoned pairing_code=fixture';
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  vi.mocked(apiFetch).mockResolvedValue(
    new Response(JSON.stringify({ ok: true, render: 'text', label: url, data: message })),
  );
  await act(async () =>
    root.render(
      <ActionRenderer
        target={{ kind: 'plugin', id: 'fixture' }}
        operation={{
          name: 'setup',
          label: 'Setup',
          actions: [{ id: 'generate', label: '生成入口', render: 'button', resultRender: 'text' }],
        }}
      />,
    ),
  );
  const generate = container.querySelector('button')!;
  await act(async () => generate.click());
  expect(container.textContent).toContain(url);
  expect(container.textContent).toContain(message);
  const blocks = [...container.querySelectorAll('pre')];
  expect(blocks.map((block) => block.textContent)).toEqual([url, message]);
  const copy = (text: string) =>
    [...container.querySelectorAll('button')].find(
      (button) => button.parentElement?.querySelector('pre')?.textContent === text,
    )!;
  await act(async () => copy(url).click());
  await act(async () => copy(message).click());
  expect(writeText.mock.calls).toEqual([[url], [message]]);
});
