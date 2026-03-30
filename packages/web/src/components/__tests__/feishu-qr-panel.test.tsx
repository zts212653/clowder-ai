import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/utils/api-client';

const mockApiFetch = vi.mocked(apiFetch);

const { FeishuQrPanel } = await import('../FeishuQrPanel');

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

function queryTestId(el: HTMLElement, testId: string): HTMLElement | null {
  return el.querySelector(`[data-testid="${testId}"]`);
}

function queryButton(el: HTMLElement, text: string): HTMLButtonElement {
  const btn = Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes(text));
  if (!btn) throw new Error(`Missing button: ${text}`);
  return btn as HTMLButtonElement;
}

describe('F134 follow-up — FeishuQrPanel', () => {
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
    vi.useFakeTimers({ shouldAdvanceTime: true });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockApiFetch.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('shows generate button when idle', async () => {
    await act(async () => {
      root.render(React.createElement(FeishuQrPanel, { configured: false }));
    });
    await flushEffects();

    expect(queryTestId(container, 'feishu-generate-qr')).not.toBeNull();
  });

  it('fetches QR code on button click and displays image', async () => {
    mockApiFetch.mockResolvedValueOnce(
      jsonResponse({ qrUrl: 'data:image/png;base64,abc', qrPayload: 'device-123', intervalMs: 5000, expireMs: 600000 }),
    );

    await act(async () => {
      root.render(React.createElement(FeishuQrPanel, { configured: false }));
    });
    await flushEffects();

    await act(async () => {
      queryButton(container, 'Generate QR Code').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const img = queryTestId(container, 'feishu-qr-image') as HTMLImageElement | null;
    expect(img).not.toBeNull();
    expect(img!.src).toContain('data:image/png;base64,abc');
  });

  it('calls onConfirmed after status polling reaches confirmed', async () => {
    const onConfirmed = vi.fn();
    mockApiFetch
      .mockResolvedValueOnce(
        jsonResponse({
          qrUrl: 'data:image/png;base64,abc',
          qrPayload: 'device-123',
          intervalMs: 1000,
          expireMs: 600000,
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ status: 'waiting' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'confirmed' }));

    await act(async () => {
      root.render(React.createElement(FeishuQrPanel, { configured: false, onConfirmed }));
    });
    await flushEffects();

    await act(async () => {
      queryButton(container, 'Generate QR Code').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    await act(async () => {
      vi.advanceTimersByTime(1100);
    });
    await flushEffects();

    expect(onConfirmed).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Feishu connected');
  });
});
