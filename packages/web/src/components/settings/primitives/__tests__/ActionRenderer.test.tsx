import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/utils/api-client';

const mockApiFetch = vi.mocked(apiFetch);
const { ActionRenderer } = await import('../ActionRenderer');

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

function queryButton(el: HTMLElement, text: string): HTMLButtonElement {
  const btn = Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes(text));
  if (!btn) throw new Error(`Missing button: ${text}`);
  return btn as HTMLButtonElement;
}

describe('ActionRenderer', () => {
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
    vi.useFakeTimers();
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

  it('resets rollback state without executing the rollback action when a polling operation times out', async () => {
    mockApiFetch.mockImplementation(async (url) => {
      const path = String(url);
      if (path.endsWith('/qr-status')) {
        return jsonResponse({ ok: true, render: 'polling', label: 'Waiting for scan' });
      }
      if (path.endsWith('/operations/connect/reset')) {
        return jsonResponse({ ok: true, currentAction: 'qr-generate' });
      }
      if (path.endsWith('/qr-generate')) {
        return jsonResponse({ ok: false, label: 'qr-generate should not run during timeout reset' }, 500);
      }
      return jsonResponse({ ok: false, label: 'unexpected action' }, 500);
    });

    await act(async () => {
      root.render(
        React.createElement(ActionRenderer, {
          connectorId: 'weixin',
          operation: {
            name: 'connect',
            label: 'Connect',
            currentAction: 'qr-status',
            lastResult: { render: 'img', data: { url: 'https://example.com/qr.png' }, label: 'Scan QR' },
            actions: [
              { id: 'qr-generate', label: 'Generate QR Code', render: 'button', next: 'qr-status' },
              { id: 'qr-status', label: 'Waiting', render: 'polling', rollback: 'qr-generate', timeout: 1 },
            ],
          },
        }),
      );
    });
    await flushEffects();

    await act(async () => {
      vi.advanceTimersByTime(1100);
      await Promise.resolve();
    });
    await flushEffects();

    expect(mockApiFetch).toHaveBeenCalledWith('/api/connectors/weixin/operations/connect/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ currentAction: 'qr-generate' }),
    });
    expect(mockApiFetch).not.toHaveBeenCalledWith('/api/connectors/weixin/actions/connect/qr-generate', {
      method: 'POST',
    });
    expect(container.textContent).toContain('Operation timed out. Please try again.');
    expect(container.querySelector('[data-testid="weixin-qr-image"]')).toBeNull();
    expect(container.querySelector('[data-testid="weixin-action-qr-generate"]')).not.toBeNull();
  });

  it('resets immediately when restored polling state is already past its persisted deadline', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    vi.setSystemTime(now);
    mockApiFetch.mockImplementation(async (url) => {
      const path = String(url);
      if (path.endsWith('/operations/connect/reset')) {
        return jsonResponse({ ok: true, currentAction: 'qr-generate' });
      }
      if (path.endsWith('/qr-status')) {
        return jsonResponse({ ok: true, render: 'polling', label: 'Waiting for scan' });
      }
      return jsonResponse({ ok: false, label: 'unexpected action' }, 500);
    });

    await act(async () => {
      root.render(
        React.createElement(ActionRenderer, {
          connectorId: 'weixin',
          operation: {
            name: 'connect',
            label: 'Connect',
            currentAction: 'qr-status',
            updatedAt: now.getTime() - 1500,
            lastResult: { render: 'img', data: { url: 'https://example.com/qr.png' }, label: 'Scan QR' },
            actions: [
              { id: 'qr-generate', label: 'Generate QR Code', render: 'button', next: 'qr-status' },
              { id: 'qr-status', label: 'Waiting', render: 'polling', rollback: 'qr-generate', timeout: 1 },
            ],
          },
        }),
      );
    });
    await flushEffects();
    await flushEffects();

    expect(mockApiFetch).toHaveBeenCalledWith('/api/connectors/weixin/operations/connect/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ currentAction: 'qr-generate' }),
    });
    expect(container.textContent).toContain('Operation timed out. Please try again.');
    expect(container.querySelector('[data-testid="weixin-qr-image"]')).toBeNull();
    expect(container.querySelector('[data-testid="weixin-action-qr-generate"]')).not.toBeNull();
  });

  it('shows a timeout error instead of spinning forever when polling has no rollback action', async () => {
    mockApiFetch.mockResolvedValue(jsonResponse({ ok: true, render: 'polling', label: 'Still waiting' }));

    await act(async () => {
      root.render(
        React.createElement(ActionRenderer, {
          connectorId: 'custom-im',
          operation: {
            name: 'connect',
            label: 'Connect',
            currentAction: 'wait-ready',
            lastResult: { render: 'status', data: { status: 'pending' }, label: 'Still waiting' },
            actions: [{ id: 'wait-ready', label: 'Waiting', render: 'polling', timeout: 1 }],
          },
        }),
      );
    });
    await flushEffects();

    expect(container.textContent).toContain('Still waiting');

    await act(async () => {
      vi.advanceTimersByTime(1100);
      await Promise.resolve();
    });
    await flushEffects();

    expect(container.textContent).toContain('Operation timed out. Please try again.');
    expect(container.textContent).not.toContain('Processing...');
  });

  it('passes pending config values when executing connector actions', async () => {
    mockApiFetch.mockResolvedValue(jsonResponse({ ok: true, render: 'status', label: 'Connected' }));

    await act(async () => {
      root.render(
        React.createElement(ActionRenderer, {
          connectorId: 'wecom-bot',
          pendingConfigValues: {
            WECOM_BOT_ID: 'bot-id-from-form',
            WECOM_BOT_SECRET: 'secret-from-form',
          },
          operation: {
            name: 'connect',
            label: 'Connect',
            currentAction: 'validate',
            actions: [{ id: 'validate', label: '测试并连接', render: 'button' }],
          },
        }),
      );
    });
    await flushEffects();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="wecom-bot-action-validate"]')?.click();
      await Promise.resolve();
    });
    await flushEffects();

    expect(mockApiFetch).toHaveBeenCalledWith('/api/connectors/wecom-bot/actions/connect/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        values: {
          WECOM_BOT_ID: 'bot-id-from-form',
          WECOM_BOT_SECRET: 'secret-from-form',
        },
      }),
    });
  });

  it('syncs action phase when refreshed connector status becomes unconfigured', async () => {
    const operation = {
      name: 'connect',
      label: 'Connect',
      actions: [
        { id: 'start', label: 'Connect Feishu', render: 'button', next: 'disconnect' },
        { id: 'disconnect', label: 'Disconnect', render: 'button', next: 'start' },
      ],
    };

    await act(async () => {
      root.render(
        React.createElement(ActionRenderer, {
          connectorId: 'feishu',
          configured: true,
          operation,
        }),
      );
    });
    await flushEffects();

    expect(container.querySelector('[data-testid="feishu-connected"]')).not.toBeNull();

    await act(async () => {
      root.render(
        React.createElement(ActionRenderer, {
          connectorId: 'feishu',
          configured: false,
          operation: { ...operation, currentAction: 'start' },
        }),
      );
    });
    await flushEffects();

    expect(container.querySelector('[data-testid="feishu-connected"]')).toBeNull();
    expect(container.querySelector('[data-testid="feishu-action-start"]')).not.toBeNull();
  });

  it('does not render connected from a persisted disconnect action when connector is unconfigured', async () => {
    await act(async () => {
      root.render(
        React.createElement(ActionRenderer, {
          connectorId: 'feishu',
          configured: false,
          operation: {
            name: 'connect',
            label: 'Connect',
            currentAction: 'disconnect',
            actions: [
              { id: 'start', label: 'Connect Feishu', render: 'button', next: 'disconnect' },
              { id: 'disconnect', label: 'Disconnect', render: 'button', next: 'start' },
            ],
          },
        }),
      );
    });
    await flushEffects();

    expect(container.querySelector('[data-testid="feishu-connected"]')).toBeNull();
    expect(container.querySelector('[data-testid="feishu-action-start"]')).not.toBeNull();
  });

  it('renders terminal status results from one-shot actions', async () => {
    mockApiFetch.mockResolvedValue(jsonResponse({ ok: true, render: 'status', label: 'Validation complete' }));

    await act(async () => {
      root.render(
        React.createElement(ActionRenderer, {
          connectorId: 'custom-im',
          operation: {
            name: 'setup',
            label: 'Setup',
            currentAction: 'validate',
            actions: [{ id: 'validate', label: 'Validate', render: 'button' }],
          },
        }),
      );
    });
    await flushEffects();

    await act(async () => {
      queryButton(container, 'Validate').click();
      await Promise.resolve();
    });
    await flushEffects();

    expect(container.querySelector('[data-testid="custom-im-status-result"]')?.textContent).toContain(
      'Validation complete',
    );
  });

  it('renders a generic QR action and displays the returned QR image', async () => {
    mockApiFetch
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          render: 'img',
          data: { url: 'data:image/png;base64,abc' },
          label: 'Scan with Feishu',
        }),
      )
      .mockResolvedValue(jsonResponse({ ok: true, render: 'polling', label: 'Waiting for scan' }));

    await act(async () => {
      root.render(
        React.createElement(ActionRenderer, {
          connectorId: 'feishu',
          operation: {
            name: 'connect',
            label: 'Connect',
            actions: [
              {
                id: 'qr-generate',
                label: 'Generate QR Code',
                render: 'button',
                resultRender: 'img',
                next: 'qr-status',
              },
              { id: 'qr-status', label: 'Waiting', render: 'polling', timeout: 60 },
            ],
          },
        }),
      );
    });
    await flushEffects();

    await act(async () => {
      queryButton(container, 'Generate QR Code').click();
      await Promise.resolve();
    });
    await flushEffects();

    const img = container.querySelector<HTMLImageElement>('[data-testid="feishu-qr-image"]');
    expect(mockApiFetch).toHaveBeenCalledWith('/api/connectors/feishu/actions/connect/qr-generate', {
      method: 'POST',
    });
    expect(img).not.toBeNull();
    expect(img!.src).toContain('data:image/png;base64,abc');
    expect(container.textContent).toContain('Scan with Feishu');
  });

  it('advances a completed QR polling action to the connected state', async () => {
    mockApiFetch.mockImplementation(async (url) => {
      const path = String(url);
      if (path.endsWith('/qr-generate')) {
        return jsonResponse({
          ok: true,
          render: 'img',
          data: { url: 'https://example.com/qr.png' },
          label: 'Scan QR',
        });
      }
      if (path.endsWith('/qr-status')) {
        return jsonResponse({ ok: true, render: 'status', label: 'WeChat connected' });
      }
      return jsonResponse({ ok: false, label: 'unexpected action' }, 500);
    });

    await act(async () => {
      root.render(
        React.createElement(ActionRenderer, {
          connectorId: 'weixin',
          operation: {
            name: 'connect',
            label: 'Connect',
            actions: [
              {
                id: 'qr-generate',
                label: 'Generate QR Code',
                render: 'button',
                resultRender: 'img',
                next: 'qr-status',
              },
              { id: 'qr-status', label: 'Waiting', render: 'polling', next: 'disconnect', timeout: 60 },
              { id: 'disconnect', label: 'Disconnect', render: 'button', next: 'qr-generate' },
            ],
          },
        }),
      );
    });
    await flushEffects();

    await act(async () => {
      queryButton(container, 'Generate QR Code').click();
      await Promise.resolve();
    });
    await flushEffects();

    await act(async () => {
      vi.advanceTimersByTime(150);
      await Promise.resolve();
    });
    await flushEffects();

    expect(container.querySelector('[data-testid="weixin-connected"]')).not.toBeNull();
    expect(container.textContent).toContain('WeChat connected');
  });

  it('surfaces terminal polling action failures instead of retrying forever', async () => {
    mockApiFetch.mockImplementation(async (url) => {
      const path = String(url);
      if (path.endsWith('/qr-generate')) {
        return jsonResponse({
          ok: true,
          render: 'img',
          data: { url: 'https://example.com/qr.png' },
          label: 'Scan QR',
        });
      }
      if (path.endsWith('/qr-status')) {
        return jsonResponse({ error: 'Activation failed after QR confirmation' }, 502);
      }
      return jsonResponse({ ok: false, label: 'unexpected action' }, 500);
    });

    await act(async () => {
      root.render(
        React.createElement(ActionRenderer, {
          connectorId: 'weixin',
          operation: {
            name: 'connect',
            label: 'Connect',
            actions: [
              {
                id: 'qr-generate',
                label: 'Generate QR Code',
                render: 'button',
                resultRender: 'img',
                next: 'qr-status',
              },
              { id: 'qr-status', label: 'Waiting', render: 'polling', next: 'disconnect', timeout: 60 },
              { id: 'disconnect', label: 'Disconnect', render: 'button', next: 'qr-generate' },
            ],
          },
        }),
      );
    });
    await flushEffects();

    await act(async () => {
      queryButton(container, 'Generate QR Code').click();
      await Promise.resolve();
    });
    await flushEffects();

    await act(async () => {
      vi.advanceTimersByTime(150);
      await Promise.resolve();
    });
    await flushEffects();

    expect(container.textContent).toContain('Activation failed after QR confirmation');

    const statusPollCalls = () => mockApiFetch.mock.calls.filter(([url]) => String(url).endsWith('/qr-status')).length;
    expect(statusPollCalls()).toBe(1);

    await act(async () => {
      vi.advanceTimersByTime(3000);
      await Promise.resolve();
    });
    await flushEffects();

    expect(statusPollCalls()).toBe(1);
  });

  it('retries transient polling fetch failures without leaving the QR flow', async () => {
    let statusPollCalls = 0;
    mockApiFetch.mockImplementation(async (url) => {
      const path = String(url);
      if (path.endsWith('/qr-generate')) {
        return jsonResponse({
          ok: true,
          render: 'img',
          data: { url: 'https://example.com/qr.png' },
          label: 'Scan QR',
        });
      }
      if (path.endsWith('/qr-status')) {
        statusPollCalls += 1;
        if (statusPollCalls === 1) {
          throw new Error('temporary network failure');
        }
        return jsonResponse({ ok: true, render: 'status', label: 'WeChat connected' });
      }
      return jsonResponse({ ok: false, label: 'unexpected action' }, 500);
    });

    await act(async () => {
      root.render(
        React.createElement(ActionRenderer, {
          connectorId: 'weixin',
          operation: {
            name: 'connect',
            label: 'Connect',
            actions: [
              {
                id: 'qr-generate',
                label: 'Generate QR Code',
                render: 'button',
                resultRender: 'img',
                next: 'qr-status',
              },
              { id: 'qr-status', label: 'Waiting', render: 'polling', next: 'disconnect', timeout: 60 },
              { id: 'disconnect', label: 'Disconnect', render: 'button', next: 'qr-generate' },
            ],
          },
        }),
      );
    });
    await flushEffects();

    await act(async () => {
      queryButton(container, 'Generate QR Code').click();
      await Promise.resolve();
    });
    await flushEffects();

    await act(async () => {
      vi.advanceTimersByTime(150);
      await Promise.resolve();
    });
    await flushEffects();

    expect(statusPollCalls).toBe(1);
    expect(container.textContent).not.toContain('Network error');
    expect(container.querySelector('[data-testid="weixin-qr-image"]')).not.toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(2500);
      await Promise.resolve();
    });
    await flushEffects();

    expect(statusPollCalls).toBe(2);
    expect(container.querySelector('[data-testid="weixin-connected"]')).not.toBeNull();
    expect(container.textContent).toContain('WeChat connected');
  });

  it('executes the generic disconnect action from a configured connector state', async () => {
    mockApiFetch.mockResolvedValue(jsonResponse({ ok: true, render: 'status', label: 'Disconnected' }));

    await act(async () => {
      root.render(
        React.createElement(ActionRenderer, {
          connectorId: 'feishu',
          configured: true,
          operation: {
            name: 'connect',
            label: 'Connect',
            actions: [
              { id: 'qr-generate', label: 'Generate QR Code', render: 'button', next: 'disconnect' },
              { id: 'disconnect', label: 'Disconnect', render: 'button', next: 'qr-generate' },
            ],
          },
        }),
      );
    });
    await flushEffects();

    expect(container.querySelector('[data-testid="feishu-connected"]')).not.toBeNull();

    await act(async () => {
      queryButton(container, 'Disconnect').click();
      await Promise.resolve();
    });
    await flushEffects();

    expect(mockApiFetch).toHaveBeenCalledWith('/api/connectors/feishu/actions/connect/disconnect', {
      method: 'POST',
    });
    expect(container.querySelector('[data-testid="feishu-action-qr-generate"]')).not.toBeNull();
  });
});
