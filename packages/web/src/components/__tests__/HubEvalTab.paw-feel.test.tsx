import type { PawFeelDutyConfig, PawFeelInboxPage } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  usePathname: () => '/settings',
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: (
    selector: (state: {
      currentThreadId: string;
      setCurrentThread: () => void;
      threads: Array<{ id: string; projectPath?: string }>;
      setCurrentProject: () => void;
      setWorkspaceOpenFile: () => void;
    }) => unknown,
  ) =>
    selector({
      currentThreadId: 'thread-current',
      setCurrentThread: vi.fn(),
      threads: [{ id: 'thread-current', projectPath: '/tmp/current-project' }],
      setCurrentProject: vi.fn(),
      setWorkspaceOpenFile: vi.fn(),
    }),
}));

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/utils/api-client';
import { HubEvalTab } from '../HubEvalTab';

Object.assign(globalThis as Record<string, unknown>, { React });

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const emptyEvalSummary = {
  counts: { total: 0, actionable: 0, keepObserve: 0, stale: 0, registeredDomains: 0 },
  domains: [],
  items: [],
};

const historyPage: PawFeelInboxPage = {
  generatedAt: '2026-07-26T00:00:00.000Z',
  projectionStatus: 'available',
  items: [
    {
      disposition: {
        signalId: 'signal-closed',
        sourceMessageId: 'message-closed',
        sourceThreadId: 'thread-source',
        sourceCatId: 'codex-sol',
        markerDigest: 'digest',
        sameDigestOrdinal: 0,
        markerIndex: 0,
        state: 'closed',
        sequence: 3,
        discoveredAt: '2026-07-25T00:00:00.000Z',
        lastTransitionAt: '2026-07-26T00:00:00.000Z',
        lastActorCatId: 'sonnet',
        reasonCode: 'fixed',
        outcomeRef: 'commit:abc',
        backfilled: false,
        captureMethod: 'typed',
        captureAssessment: 'confirmed',
      },
      responsibility: {
        state: 'terminal',
        validExit: true,
        exitKind: 'terminal_disposition',
        evidenceRefs: ['commit:abc'],
      },
      source: {
        availability: 'available',
        preview: '工具卡住后没有返回清晰错误',
        sourceHref: '/thread/thread-source?messageId=message-closed',
        digestVerified: true,
      },
      ageMs: 24 * 3_600_000,
      overdue: false,
      deterministicGroupKey: 'tool:cat_cafe_hold_ball',
    },
  ],
  bundles: [],
  bundleCounts: {
    total: 1,
    byBasis: { message: 0, turn_invocation: 0, legacy_invocation: 0, single_signal: 1 },
  },
  denominator: {
    reportOccurrences: 1,
    uniqueSourceMessages: 1,
    historicalBackfill: 0,
    postActivationIntake: 1,
    typedConfirmed: 1,
    ambiguousOrContaminated: 0,
    reviewBundles: 1,
    problemFamilies: { status: 'unavailable', reason: 'No authoritative grouping contract' },
  },
  counts: {
    total: 1,
    unseen: 0,
    inProgress: 0,
    routePending: 0,
    disposed: 1,
    overdue: 0,
  },
  responsibilityCounts: {
    unreviewed: 0,
    bound_in_repair: 0,
    signature_waiting: 0,
    blocked: 0,
    terminal: 1,
  },
  degraded: false,
};

describe('HubEvalTab paw-feel settings surface', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.mocked(apiFetch).mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('keeps the responsibility ledger entry point visible when periodic eval fails', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonResponse({ error: 'offline' }, 503));

    await act(async () => {
      root.render(<HubEvalTab />);
    });
    await act(async () => {});

    expect(container.textContent).toContain('爪感差责任闭环');
    expect(container.textContent).toContain('查看值班与审计');
    expect(container.textContent).toContain('周期 Eval Hub 暂时不可用');
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledWith('/api/eval-hub/summary');
  });

  it('opens compact audit and persists a versioned primary/backup assignment', async () => {
    const savedConfig: PawFeelDutyConfig = {
      systemThreadId: 'thread_eval_friction',
      primaryCatId: 'sonnet',
      backupCatId: 'codex-sol',
      version: 1,
      updatedAt: '2026-07-26T00:00:00.000Z',
      updatedBy: 'you',
    };
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (url === '/api/eval-hub/summary') return jsonResponse(emptyEvalSummary);
      if (url === '/api/paw-feel/duty' && !init) return jsonResponse({ config: null });
      if (url === '/api/eval-hub/available-cats') {
        return jsonResponse({
          cats: [
            { catId: 'sonnet', handle: '@sonnet', family: 'ragdoll' },
            { catId: 'codex-sol', handle: '@codex-sol', family: 'maine-coon' },
          ],
        });
      }
      if (url.startsWith('/api/paw-feel/inbox?')) return jsonResponse(historyPage);
      if (url === '/api/paw-feel/duty' && init?.method === 'PATCH') {
        return jsonResponse({ config: savedConfig });
      }
      return jsonResponse({ error: `unexpected ${url}` }, 500);
    });

    await act(async () => {
      root.render(<HubEvalTab />);
    });
    await act(async () => {});

    const openButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === '查看值班与审计',
    );
    await act(async () => {
      openButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {});

    expect(container.textContent).toContain('尚未指定责任猫');
    expect(container.textContent).toContain('thread_eval_friction');
    expect(container.textContent).toContain('紧凑审计');
    expect(container.textContent).toContain('完整审阅只在 Workspace');
    expect(container.textContent).not.toContain('工具卡住后没有返回清晰错误');

    const [primary, backup] = Array.from(container.querySelectorAll('select'));
    await act(async () => {
      if (primary) {
        primary.value = 'sonnet';
        primary.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    await act(async () => {
      if (backup) {
        backup.value = 'codex-sol';
        backup.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });

    const saveButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === '保存值班',
    );
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {});

    expect(apiFetch).toHaveBeenCalledWith(
      '/api/paw-feel/duty',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          expectedVersion: 0,
          primaryCatId: 'sonnet',
          backupCatId: 'codex-sol',
        }),
      }),
    );
    expect(container.textContent).toContain('值班配置已写入持久台账');
    expect(container.textContent).toContain('版本 1');
  });

  it('keeps durable primary and backup assignments readable when the roster is unavailable', async () => {
    const savedConfig: PawFeelDutyConfig = {
      systemThreadId: 'thread_eval_friction',
      primaryCatId: 'sonnet',
      backupCatId: 'codex-sol',
      version: 3,
      updatedAt: '2026-07-26T00:00:00.000Z',
      updatedBy: 'you',
    };
    vi.mocked(apiFetch).mockImplementation(async (url) => {
      if (url === '/api/eval-hub/summary') return jsonResponse(emptyEvalSummary);
      if (url === '/api/paw-feel/duty') return jsonResponse({ config: savedConfig });
      if (url === '/api/eval-hub/available-cats') return jsonResponse({ error: 'roster unavailable' }, 503);
      if (url.startsWith('/api/paw-feel/inbox?')) return jsonResponse(historyPage);
      return jsonResponse({ error: `unexpected ${url}` }, 500);
    });

    await act(async () => {
      root.render(<HubEvalTab />);
    });
    await act(async () => {});

    const openButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === '查看值班与审计',
    );
    await act(async () => {
      openButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {});

    const [primary, backup] = Array.from(container.querySelectorAll('select'));
    expect(primary?.value).toBe('sonnet');
    expect(backup?.value).toBe('codex-sol');
    expect(primary?.selectedOptions[0]?.textContent).toContain('@sonnet');
    expect(backup?.selectedOptions[0]?.textContent).toContain('@codex-sol');
  });
});
