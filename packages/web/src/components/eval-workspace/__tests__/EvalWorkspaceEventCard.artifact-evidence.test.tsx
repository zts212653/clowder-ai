import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}));

import { EvalWorkspaceEventCard } from '../EvalWorkspaceEventCard';
import type { EvalWorkspaceEvent } from '../evalWorkspaceEvents';

const artifactEvent: EvalWorkspaceEvent = {
  id: 'hlr-artifact-1',
  domainId: 'eval:harness-ledger',
  domainDisplayName: 'Harness Ledger',
  kind: 'watching',
  severity: 'info',
  verdict: 'keep_observe',
  title: '运行时 verdict',
  summary: 'summary',
  action: 'action',
  nextCheck: 'next',
  lifecycle: {
    availability: 'not_required',
    ownerResponseStatus: 'not_required',
    closureStatus: 'observing',
    reevalStatus: 'not_required',
    stale: false,
  },
  stale: false,
  source: {
    kind: 'artifact',
    domainSlug: 'eval-harness-ledger',
    artifactId: 'hlr-artifact-1',
    verdictId: 'hlr-artifact-1',
  },
  systemThreadId: 'thread-ledger',
};

describe('EvalWorkspaceEventCard evidence for runtime artifacts', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    mocks.apiFetch.mockReset();
    useChatStore.setState({ workspaceMode: 'eval', workspaceOpenFilePath: null });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('reads the verdict from the artifact route and leaves the workspace untouched', async () => {
    mocks.apiFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ fileKey: 'verdict', contentType: 'text/markdown', content: 'verdict body', truncated: false }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    await act(async () => root.render(<EvalWorkspaceEventCard event={artifactEvent} />));

    const button = Array.from(container.querySelectorAll('button')).find((node) => node.textContent === '结论文件');
    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(mocks.apiFetch).toHaveBeenCalledWith(
      '/api/eval-hub/artifacts/eval-harness-ledger/hlr-artifact-1/verdicts/hlr-artifact-1/files/verdict',
    );
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain('结论文件 · hlr-artifact-1');
    expect(useChatStore.getState().workspaceOpenFilePath).toBeNull();
    expect(useChatStore.getState().workspaceMode).toBe('eval');
  });
});
