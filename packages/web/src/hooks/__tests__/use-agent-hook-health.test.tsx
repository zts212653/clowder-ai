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
      targetPath: '/home/user/.claude/hooks/session-start-recall.sh',
    },
  ],
};

function flushPromises() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function Probe({
  onStatus,
  onError,
}: {
  onStatus?: (status: string | null) => void;
  onError?: (error: string | null) => void;
}) {
  const { health, error } = useAgentHookHealth({ enabled: true });
  useEffect(() => {
    onStatus?.(health?.status ?? null);
  }, [health?.status, onStatus]);
  useEffect(() => {
    onError?.(error);
  }, [error, onError]);
  return null;
}

function SyncProbe({ onError }: { onError: (error: string | null) => void }) {
  const { error, sync } = useAgentHookHealth({ enabled: false });

  useEffect(() => {
    void sync();
  }, [sync]);

  useEffect(() => {
    onError(error);
  }, [error, onError]);
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

  it('maps localhost-only 403 status failures to an actionable hint', async () => {
    const errors: Array<string | null> = [];
    vi.mocked(apiFetch).mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: 'Agent hook health requires an explicit targetRoot or a local API host' }),
    } as Response);

    await act(async () => {
      root.render(<Probe onError={(error) => errors.push(error)} />);
      await flushPromises();
      await flushPromises();
    });

    expect(errors).toContain(
      'Agent Hook 只支持从本机 localhost 直接访问的 Hub 检测。请改用 http://localhost:3003 打开后重试。',
    );
  });

  it('maps localhost-only 403 sync failures to an actionable hint', async () => {
    const errors: Array<string | null> = [];
    vi.mocked(apiFetch).mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: 'Agent hook sync requires an explicit targetRoot or a local API host' }),
    } as Response);

    await act(async () => {
      root.render(<SyncProbe onError={(error) => errors.push(error)} />);
      await flushPromises();
      await flushPromises();
    });

    expect(errors).toContain(
      'Agent Hook 同步只支持从本机 localhost 直接访问的 Hub 发起。请改用 http://localhost:3003 打开后重试。',
    );
  });
});
