// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LifelineStageDetail } from '../LifelineStageDetail';

const apiFetch = vi.fn();

vi.mock('../../../utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

describe('LifelineStageDetail replay flow', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    apiFetch.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function flush() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  const baseResponse = {
    segmentId: 'S-test',
    threadId: 't',
    turnId: '1',
    timestamp: 5000,
    catId: 'opus',
    stage: 'session-init',
    pipelineStatus: 'fired',
    version: 1,
    versionGap: null,
    content: 'rendered content',
    contentGap: null,
    contentSourceKind: 'template',
    contentSourceKindGap: null,
    templateRef: 'templates/S-test.md',
    templateRefGap: null,
    templateVars: { VAR: 'value' },
    templateVarsGap: null,
    messageAnchorId: 'anchor-1',
    messageAnchorIdGap: null,
    guardEvents: [],
    guardEventsGap: null,
    surroundingMessages: [],
    surroundingMessagesGap: null,
  };

  const enablementMatrix: import('@cat-cafe/shared').SegmentEnablementMatrix = {
    segmentId: 'S-test',
    safetyTier: 'editable',
    allowLocalOverride: true,
    disableable: true,
    localOverlay: {
      hasOverlay: false,
      hasBackup: false,
      actions: {
        edit: { allowed: true, reason: null, reasonCode: null },
        restoreBackup: { allowed: false, reason: '当前段无备份文件', reasonCode: 'no-backup' },
        reset: { allowed: false, reason: '当前段无本地覆盖可重置', reasonCode: 'no-local-overlay' },
      },
    },
    runtimeOverride: {
      enabled: true,
      hasOverride: false,
      hasContentOverride: false,
      hasVersionSnapshot: false,
      availableEpochVersions: [],
      actions: {
        disable: { allowed: true, reason: null, reasonCode: null },
        enable: { allowed: false, reason: '当前段已启用', reasonCode: 'already-enabled' },
        rollback: { allowed: false, reason: '当前段无覆盖可回滚', reasonCode: 'no-override' },
        activateVersion: { allowed: false, reason: '当前段无保留版本可激活', reasonCode: 'no-version-snapshot' },
      },
    },
  };

  function renderTracing() {
    act(() => {
      root.render(
        <LifelineStageDetail
          selected={{ stage: 'tracing', version: 1 }}
          chain={[
            {
              version: 1,
              origin: 'manifest',
              startedAt: 1000,
              status: 'tracing',
              isActive: true,
              tracing: {
                observationCount: 1,
                firedCount: 1,
                firstAt: 1000,
                lastAt: 1000,
              },
              eval: null,
              governance: null,
              events: [],
            },
          ]}
          observations={[
            {
              threadId: 't',
              turnId: '1',
              timestamp: 1000,
              catId: 'opus',
              pipelineStatus: 'fired',
              version: 1,
              charCount: 10,
            },
          ]}
          guardEvents={[]}
          epochGuardMetrics={{}}
          overrideState={null}
          hookId="S-test"
          onRefresh={() => {}}
          activeStage="tracing"
          actionable={{ stage: null, candidateCount: null, source: 'unavailable' }}
          enablementMatrix={enablementMatrix}
        />,
      );
    });
  }

  it('opens replay from observation row, loads data, and closes', async () => {
    apiFetch.mockResolvedValueOnce({ ok: true, json: async () => baseResponse });
    renderTracing();
    await flush();

    expect(document.body.textContent).not.toContain('回放现场');

    const expandBtn = container.querySelector('button') as HTMLButtonElement;
    expect(expandBtn).toBeTruthy();
    act(() => expandBtn.click());
    await flush();

    const replayBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('回放现场'),
    ) as HTMLButtonElement;
    expect(replayBtn).toBeTruthy();
    act(() => replayBtn.click());
    await flush();

    expect(apiFetch).toHaveBeenCalledWith('/api/segment-lifeline/S-test/replay?threadId=t&turnId=1');
    expect(document.body.textContent).toContain('anchor-1');
    expect(document.body.textContent).not.toContain('rendered content');

    const closeBtn = document.querySelector('[data-testid="replay-close"]') as HTMLButtonElement;
    expect(closeBtn).toBeTruthy();
    act(() => closeBtn.click());
    await flush();

    expect(document.body.textContent).not.toContain('anchor-1');
  });
});
