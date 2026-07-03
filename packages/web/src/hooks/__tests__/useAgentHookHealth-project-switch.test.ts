/**
 * Regression: switching projectPath must clear stale health before fetching.
 *
 * When the user switches from project A to project B the hook should NOT
 * render A's health targets while B's request is in flight. This prevents
 * the sync button from showing A's stale/missing targets when it would
 * post B's projectPath.
 *
 * Root cause: useEffect set loading=true but did not clear health state,
 * leaving the previous project's AgentHookStatusResponse visible until
 * the new request resolved.
 *
 * See: PR #1051 inline review + maintainer R4 P2
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import {
  type AgentHookStatusResponse,
  resetAgentHookHealthCacheForTests,
  useAgentHookHealth,
} from '../useAgentHookHealth';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
}));

const PROJECT_A = '/workspace/project-a';
const PROJECT_B = '/workspace/project-b';

const healthA: AgentHookStatusResponse = {
  status: 'configured',
  targets: [{ name: 'hooks', drifted: false, status: 'configured', targetPath: PROJECT_A, reason: '' }],
};

const healthB: AgentHookStatusResponse = {
  status: 'stale',
  targets: [{ name: 'hooks', drifted: true, status: 'stale', targetPath: PROJECT_B, reason: 'drifted' }],
};

/** Captures the latest hook return via ref. */
let lastResult: ReturnType<typeof useAgentHookHealth> | null = null;

function HookHost({ projectPath }: { projectPath?: string }) {
  const result = useAgentHookHealth({ enabled: true, projectPath });
  lastResult = result;
  return null;
}

describe('useAgentHookHealth project switch', () => {
  let container: HTMLDivElement;
  let root: Root;
  const apiFetchMock = vi.mocked(apiFetch);

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
    resetAgentHookHealthCacheForTests();
    lastResult = null;
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.removeChild(container);
    vi.restoreAllMocks();
  });

  it('clears health when projectPath changes to an uncached project', async () => {
    // --- Phase 1: render with project A, let it resolve ---
    let resolveA!: (res: Response) => void;
    const pendingA = new Promise<Response>((r) => {
      resolveA = r;
    });

    apiFetchMock.mockReturnValueOnce(pendingA);

    await act(async () => {
      root.render(React.createElement(HookHost, { projectPath: PROJECT_A }));
    });

    // Resolve A's fetch
    await act(async () => {
      resolveA(new Response(JSON.stringify(healthA), { status: 200 }));
      // Let microtasks flush
      await new Promise((r) => setTimeout(r, 0));
    });

    // Verify A's health is rendered
    expect(lastResult?.health).toEqual(healthA);
    expect(lastResult?.loading).toBe(false);

    // --- Phase 2: switch to project B (not cached) ---
    let resolveB!: (res: Response) => void;
    const pendingB = new Promise<Response>((r) => {
      resolveB = r;
    });
    apiFetchMock.mockReturnValueOnce(pendingB);

    await act(async () => {
      root.render(React.createElement(HookHost, { projectPath: PROJECT_B }));
    });

    // While B is in flight: health must be null (not A's stale data)
    expect(lastResult?.health).toBeNull();
    expect(lastResult?.loading).toBe(true);

    // Resolve B
    await act(async () => {
      resolveB(new Response(JSON.stringify(healthB), { status: 200 }));
      await new Promise((r) => setTimeout(r, 0));
    });

    // Now B's health should be rendered
    expect(lastResult?.health).toEqual(healthB);
    expect(lastResult?.loading).toBe(false);
  });
});
