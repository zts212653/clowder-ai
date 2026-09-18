import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EvalHubItem } from '../HubEvalTypes';

const storeMocks = vi.hoisted(() => ({
  setCurrentThread: vi.fn(),
  setCurrentProject: vi.fn(),
  setWorkspaceMode: vi.fn(),
  setWorkspaceOpenFile: vi.fn(),
  routerPush: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/settings',
  useRouter: () => ({ push: storeMocks.routerPush }),
}));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) =>
      selector({ currentThreadId: 'thread-current', threads: [], ...storeMocks }),
    { getState: () => ({ currentThreadId: 'thread-current', ...storeMocks }) },
  ),
}));

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/utils/api-client';
import { HubEvalVerdictCard } from '../HubEvalVerdictCard';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const artifactItem: EvalHubItem = {
  id: 'hlr-artifact-1',
  domainId: 'eval:harness-ledger',
  packetId: 'hlr-artifact-1',
  feedbackType: 'live-verdict',
  verdict: 'keep_observe',
  phenomenon: 'runtime artifact verdict',
  operatorNarrative: {
    headline: '运行时 verdict',
    summary: 'summary',
    action: 'action',
    nextCheck: 'next',
    evidenceQuality: 'usable',
  },
  ownerAsk: 'observe',
  harnessUnderEval: { featureId: 'F257', componentId: 'ledger', name: 'Harness Ledger' },
  reeval: { status: 'observing', summary: 're-eval' },
  lifecycle: {
    availability: 'not_required',
    ownerResponseStatus: 'not_required',
    closureStatus: 'observing',
    reevalStatus: 'not_required',
    stale: false,
  },
  evidence: { snapshotRefs: [], attributionRefs: [], metricRefs: [], otherRefs: [] },
  trend: { generatedAt: '2026-09-15T00:00:00.000Z', window: { durationHours: 24 }, components: [] },
  systemWorkspace: {
    kind: 'eval_domain',
    id: 'eval:harness-ledger',
    label: 'Harness Ledger',
    threadId: 'thread-ledger',
    stateSot: 'registry',
  },
  source: {
    kind: 'artifact',
    domainSlug: 'eval-harness-ledger',
    artifactId: 'hlr-artifact-1',
    verdictId: 'hlr-artifact-1',
  },
};

describe('HubEvalVerdictCard evidence for runtime artifacts', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    storeMocks.setWorkspaceOpenFile.mockReset();
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

  async function click(label: string) {
    const button = Array.from(container.querySelectorAll('button')).find((node) => node.textContent === label);
    expect(button, `button ${label}`).toBeTruthy();
    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  it('reads bundle files through the owner-scoped artifact route instead of the workspace', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      jsonResponse({
        fileKey: 'snapshot',
        contentType: 'application/json',
        content: '{"verdictId":"hlr-artifact-1"}',
        truncated: false,
      }),
    );
    await act(async () => root.render(<HubEvalVerdictCard item={artifactItem} />));

    await click('快照包');

    expect(apiFetch).toHaveBeenCalledWith(
      '/api/eval-hub/artifacts/eval-harness-ledger/hlr-artifact-1/verdicts/hlr-artifact-1/files/snapshot',
    );
    expect(storeMocks.setWorkspaceOpenFile).not.toHaveBeenCalled();
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('快照包 · hlr-artifact-1');
    expect(dialog?.querySelector('pre')?.textContent).toBe('{\n  "verdictId": "hlr-artifact-1"\n}');
  });

  it('says so when the artifact cannot be read, without opening anything', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(jsonResponse({ error: 'artifact_not_found' }, 404));
    await act(async () => root.render(<HubEvalVerdictCard item={artifactItem} />));

    await click('结论文件');

    expect(apiFetch).toHaveBeenCalledWith(
      '/api/eval-hub/artifacts/eval-harness-ledger/hlr-artifact-1/verdicts/hlr-artifact-1/files/verdict',
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('结论文件读取失败');
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(storeMocks.setWorkspaceOpenFile).not.toHaveBeenCalled();
  });

  it('opens a child verdict’s friction raw report inside the artifact that holds it', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      jsonResponse({ fileKey: 'friction-report', contentType: 'application/json', content: '{}', truncated: false }),
    );
    const frictionItem: EvalHubItem = {
      ...artifactItem,
      id: 'fr-1-finding-a',
      domainId: 'eval:friction',
      source: { kind: 'artifact', domainSlug: 'eval-friction', artifactId: 'fr-1', verdictId: 'fr-1-finding-a' },
      friction: {
        projectionStatus: 'available',
        actionableCandidates: [],
        referenceOnly: [],
        source: { kind: 'artifact' },
      },
    };
    await act(async () => root.render(<HubEvalVerdictCard item={frictionItem} />));

    await click('原始报告');

    expect(apiFetch).toHaveBeenCalledWith(
      '/api/eval-hub/artifacts/eval-friction/fr-1/verdicts/fr-1-finding-a/files/friction-report',
    );
    expect(storeMocks.setWorkspaceOpenFile).not.toHaveBeenCalled();
  });

  it('keeps repository verdicts on the workspace panel', async () => {
    const workspaceItem: EvalHubItem = {
      ...artifactItem,
      source: {
        kind: 'workspace',
        verdictPath: 'docs/harness-feedback/verdicts/v.md',
        bundleDir: 'docs/harness-feedback/bundles/v',
      },
    };
    await act(async () => root.render(<HubEvalVerdictCard item={workspaceItem} />));

    await click('归因包');

    expect(storeMocks.setWorkspaceOpenFile).toHaveBeenCalledWith(
      'docs/harness-feedback/bundles/v/attribution.json',
      null,
      null,
    );
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
