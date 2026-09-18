// @vitest-environment jsdom

import type { SegmentEnablementMatrix } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivateVersionButton } from '../VersionActions';

vi.mock('../../../utils/api-client', () => ({ apiFetch: vi.fn() }));

const matrix: SegmentEnablementMatrix = {
  segmentId: 'S6',
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
    hasOverride: true,
    hasContentOverride: true,
    hasVersionSnapshot: true,
    availableEpochVersions: [2],
    actions: {
      disable: { allowed: true, reason: null, reasonCode: null },
      enable: { allowed: false, reason: '当前段已启用', reasonCode: 'already-enabled' },
      rollback: { allowed: true, reason: null, reasonCode: null },
      activateVersion: { allowed: true, reason: null, reasonCode: null },
      createVersion: { allowed: true, reason: null, reasonCode: null },
    },
  },
};

describe('VersionActions: stalled evaluation cycle', () => {
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
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });
  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('keeps the version switch available while the current cycle is stalled', () => {
    act(() => {
      root.render(
        <ActivateVersionButton
          hookId="S6"
          epochVersion={2}
          currentEvalStatus="stalled"
          onRefresh={() => {}}
          enablementMatrix={matrix}
        />,
      );
    });
    const button = container.querySelector('button') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(container.textContent).not.toContain('当前正在评估');
  });
});
