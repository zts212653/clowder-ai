import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/utils/api-client';

const mockApiFetch = vi.mocked(apiFetch);

const { WeixinQrPanel } = await import('../WeixinQrPanel');

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

describe('F137 Phase C — WeixinQrPanel', () => {
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

  it('shows "Generate QR Code" button when idle', async () => {
    await act(async () => {
      root.render(React.createElement(WeixinQrPanel, { configured: false }));
    });
    await flushEffects();

    expect(queryTestId(container, 'weixin-generate-qr')).not.toBeNull();
    expect(container.textContent).toContain('Generate QR Code');
  });

  it('shows connected state when already configured', async () => {
    await act(async () => {
      root.render(React.createElement(WeixinQrPanel, { configured: true }));
    });
    await flushEffects();

    expect(queryTestId(container, 'weixin-connected')).not.toBeNull();
    expect(container.textContent).toContain('WeChat connected');
  });

  it('fetches QR code on button click and displays image', async () => {
    mockApiFetch.mockResolvedValueOnce(jsonResponse({ qrUrl: 'https://example.com/qr.png', qrPayload: 'abc123' }));

    await act(async () => {
      root.render(React.createElement(WeixinQrPanel, { configured: false }));
    });
    await flushEffects();

    await act(async () => {
      queryButton(container, 'Generate QR Code').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const img = queryTestId(container, 'weixin-qr-image') as HTMLImageElement | null;
    expect(img).not.toBeNull();
    expect(img!.src).toBe('https://example.com/qr.png');
  });

  it('shows error when QR code fetch fails', async () => {
    mockApiFetch.mockResolvedValueOnce(jsonResponse({ error: 'Service unavailable' }, 500));

    await act(async () => {
      root.render(React.createElement(WeixinQrPanel, { configured: false }));
    });
    await flushEffects();

    await act(async () => {
      queryButton(container, 'Generate QR Code').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(container.textContent).toContain('Service unavailable');
  });

  it('auto-polls after QR fetch, transitions scanned → confirmed', async () => {
    mockApiFetch
      .mockResolvedValueOnce(jsonResponse({ qrUrl: 'https://example.com/qr.png', qrPayload: 'abc123' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'scanned' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'scanned' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'confirmed' }));

    await act(async () => {
      root.render(React.createElement(WeixinQrPanel, { configured: false }));
    });
    await flushEffects();

    await act(async () => {
      queryButton(container, 'Generate QR Code').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();
    expect(queryTestId(container, 'weixin-qr-image')).not.toBeNull();
    expect(container.textContent).toContain('Scanned');

    await act(async () => {
      vi.advanceTimersByTime(2600);
    });
    await flushEffects();
    expect(container.textContent).toContain('Scanned');

    await act(async () => {
      vi.advanceTimersByTime(2600);
    });
    await flushEffects();
    expect(queryTestId(container, 'weixin-connected')).not.toBeNull();
  });

  it('shows expired state after 60s timeout and allows regeneration', async () => {
    mockApiFetch
      .mockResolvedValueOnce(jsonResponse({ qrUrl: 'https://example.com/qr.png', qrPayload: 'abc123' }))
      .mockResolvedValue(jsonResponse({ status: 'waiting' }));

    await act(async () => {
      root.render(React.createElement(WeixinQrPanel, { configured: false }));
    });
    await flushEffects();

    await act(async () => {
      queryButton(container, 'Generate QR Code').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();
    expect(queryTestId(container, 'weixin-qr-image')).not.toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(61_000);
    });
    await flushEffects();

    expect(container.textContent?.toLowerCase()).toContain('expired');
    expect(container.textContent).toContain('Regenerate QR Code');
  });

  it('auto-poll calls qrcode-status with correct qrPayload', async () => {
    mockApiFetch
      .mockResolvedValueOnce(jsonResponse({ qrUrl: 'https://example.com/qr.png', qrPayload: 'test-payload' }))
      .mockResolvedValue(jsonResponse({ status: 'waiting' }));

    await act(async () => {
      root.render(React.createElement(WeixinQrPanel, { configured: false }));
    });
    await flushEffects();

    await act(async () => {
      queryButton(container, 'Generate QR Code').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    await act(async () => {
      vi.advanceTimersByTime(2600);
    });
    await flushEffects();

    const statusCalls = mockApiFetch.mock.calls.filter(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('qrcode-status'),
    );
    expect(statusCalls.length).toBeGreaterThanOrEqual(1);
    expect(statusCalls[0][0]).toContain('qrPayload=test-payload');
  });
});
