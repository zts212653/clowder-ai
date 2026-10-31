import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { apiFetch, setGlobalBubbleDefaults } = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  setGlobalBubbleDefaults: vi.fn(),
}));

vi.mock('@/utils/api-client', () => ({ apiFetch }));
vi.mock('@/stores/chatStore', () => ({
  useChatStore: { getState: () => ({ setGlobalBubbleDefaults }) },
}));

import type { ConfigData } from '../../config-viewer-types';
import { writeShellLanguage } from '../../shell/shell-language';
import { ExecutionRecordDefaultSettings } from '../ExecutionRecordDefaultSettings';

const config = {
  cats: {},
  perCatCapacities: {},
  a2a: { enabled: true, maxDepth: 3 },
  memory: { enabled: true, maxKeysPerThread: 50 },
  governance: { degradationEnabled: true, doneTimeoutMs: 1, heartbeatIntervalMs: 1 },
  ui: { bubbleDefaults: { thinking: 'collapsed', cliOutput: 'collapsed' } },
} satisfies ConfigData;

describe('ExecutionRecordDefaultSettings', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.clearAllMocks();
    window.localStorage.clear();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });

  function render(props: Partial<Parameters<typeof ExecutionRecordDefaultSettings>[0]> = {}) {
    const onConfigChange = vi.fn();
    const onRetry = vi.fn();
    act(() => {
      root.render(
        <ExecutionRecordDefaultSettings
          config={config}
          hasLoadError={false}
          onConfigChange={onConfigChange}
          onRetry={onRetry}
          {...props}
        />,
      );
    });
    return { onConfigChange, onRetry };
  }

  it('shows honest loading and retry states', () => {
    writeShellLanguage('en');
    render({ config: null });
    expect(host.textContent).toContain('Loading activity default…');

    const { onRetry } = render({ config: null, hasLoadError: true });
    expect(host.textContent).toContain("Activity default couldn't be loaded");
    const retry = Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Try again');
    act(() => retry?.click());
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('saves immediately, exposes pending state and updates the live bubble default', async () => {
    writeShellLanguage('en');
    let resolveWrite: ((response: unknown) => void) | undefined;
    apiFetch.mockReturnValue(new Promise((resolve) => (resolveWrite = resolve)));
    const { onConfigChange } = render();
    const expanded = host.querySelector<HTMLInputElement>('[data-testid="execution-record-default-expanded"]');

    await act(async () => expanded?.click());
    expect(expanded?.checked).toBe(true);
    expect(host.textContent).toContain('Saving…');
    expect(apiFetch).toHaveBeenCalledWith('/api/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'ui.bubble.cliOutput', value: 'expanded' }),
    });

    const next = {
      ...config,
      ui: { bubbleDefaults: { thinking: 'collapsed' as const, cliOutput: 'expanded' as const } },
    };
    await act(async () => {
      resolveWrite?.({ ok: true, json: async () => ({ config: next }) });
    });
    expect(onConfigChange).toHaveBeenCalledWith(next);
    expect(setGlobalBubbleDefaults).toHaveBeenCalledWith(next.ui.bubbleDefaults);
  });

  it('keeps the previous value and reports a rejected save', async () => {
    writeShellLanguage('en');
    apiFetch.mockResolvedValue({ ok: false, status: 403 });
    render();

    await act(async () => {
      host.querySelector<HTMLInputElement>('[data-testid="execution-record-default-expanded"]')?.click();
    });
    await vi.waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toContain('could not be saved'));
    expect(host.querySelector<HTMLInputElement>('[data-testid="execution-record-default-collapsed"]')?.checked).toBe(
      true,
    );
  });
});
