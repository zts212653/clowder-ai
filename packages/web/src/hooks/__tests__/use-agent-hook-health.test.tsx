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

const staleResponse = {
  status: 'stale',
  targets: [
    {
      name: 'skills',
      status: 'stale',
      drifted: true,
      reason: '1 stale, 196 conflicts',
      targetPath: '',
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

let latestResult: ReturnType<typeof useAgentHookHealth> | null = null;

function SyncProbe() {
  latestResult = useAgentHookHealth({ enabled: true });
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

  it('records a partial sync attempt when sync succeeds but drift remains', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => staleResponse,
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => staleResponse,
      } as Response);

    await act(async () => {
      root.render(<SyncProbe />);
      await flushPromises();
    });

    await act(async () => {
      await latestResult?.sync();
      await flushPromises();
    });

    expect(latestResult?.health).toEqual(staleResponse);
    expect(latestResult?.synced).toBe(false);
    expect(latestResult?.syncAttempted).toBe(true);
  });

  function mock400(body: { code?: string; error: string }) {
    vi.mocked(apiFetch).mockResolvedValue({ ok: false, status: 400, json: async () => body } as Response);
  }

  async function renderErrorProbe() {
    const result: { status: string | null; uninitialised: boolean; error: string | null } = {
      status: null,
      uninitialised: false,
      error: null,
    };

    function ErrorProbe() {
      const { health, error } = useAgentHookHealth({ enabled: true });
      useEffect(() => {
        result.status = health?.status ?? null;
        result.uninitialised = health?.uninitialised === true;
        result.error = error;
      }, [health, error]);
      return null;
    }

    await act(async () => {
      root.render(<ErrorProbe />);
      await flushPromises();
    });
    return result;
  }

  it('surfaces PROJECT_NOT_INITIALIZED as neutral unsupported state', async () => {
    mock400({ code: 'PROJECT_NOT_INITIALIZED', error: 'Project not initialized (missing .cat-cafe/): /repo' });

    const result = await renderErrorProbe();

    expect(result.status).toBe('unsupported');
    expect(result.uninitialised).toBe(true);
    expect(result.error).toBeNull();
  });

  it('still reports other 400 responses as errors', async () => {
    mock400({
      code: 'INVALID_PROJECT_PATH',
      error: 'Invalid project path: not found, denied, or not a directory: /nope',
    });

    const result = await renderErrorProbe();

    expect(result.status).toBeNull();
    expect(result.error).toContain('400');
  });
});
