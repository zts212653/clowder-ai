import React, { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAgentHookHealthCacheForTests, useAgentHookHealth } from '@/hooks/useAgentHookHealth';
import { apiFetch } from '@/utils/api-client';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
}));

const configuredResponse = {
  status: 'configured',
  targets: [
    {
      name: 'hooks/session-start',
      status: 'configured',
      drifted: false,
      reason: 'configured',
      targetPath: '/home/user/session-start-recall.sh',
    },
  ],
};

function flushPromises() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function Probe({ onStatus }: { onStatus: (status: string | null) => void }) {
  const { health } = useAgentHookHealth({ enabled: true });
  useEffect(() => {
    onStatus(health?.status ?? null);
  }, [health?.status, onStatus]);
  return null;
}

describe('useAgentHookHealth', () => {
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
    resetAgentHookHealthCacheForTests();
    vi.mocked(apiFetch).mockReset();
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      json: async () => configuredResponse,
    } as Response);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('caches status for the browser session instead of refetching per mount', async () => {
    const statuses: Array<string | null> = [];

    await act(async () => {
      root.render(<Probe onStatus={(status) => statuses.push(status)} />);
      await flushPromises();
    });

    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);

    await act(async () => {
      root.render(<Probe onStatus={(status) => statuses.push(status)} />);
      await flushPromises();
    });

    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledWith('/api/agent-hooks/status');
    expect(statuses).toContain('configured');
  });
});
