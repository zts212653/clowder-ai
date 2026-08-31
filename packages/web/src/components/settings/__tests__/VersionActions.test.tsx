// @vitest-environment jsdom

import type { SegmentEnablementMatrix } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivateVersionButton, RollbackButton, ToggleOverrideButton } from '../VersionActions';

const apiFetch = vi.fn();

vi.mock('../../../utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

function makeMatrix(overrides: Partial<SegmentEnablementMatrix> = {}): SegmentEnablementMatrix {
  return {
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
    ...overrides,
  };
}

describe('VersionActions (F257 Console 判据⑥)', () => {
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

  it('ToggleOverrideButton is disabled and shows reason when matrix disallows disable', () => {
    act(() => {
      root.render(
        <ToggleOverrideButton
          hookId="S6"
          currentlyEnabled
          onRefresh={() => {}}
          enablementMatrix={makeMatrix({
            disableable: false,
            runtimeOverride: {
              enabled: true,
              hasOverride: false,
              hasContentOverride: false,
              hasVersionSnapshot: false,
              availableEpochVersions: [],
              actions: {
                disable: {
                  allowed: false,
                  reason: '当前段 disableable=false，不可禁用',
                  reasonCode: 'not-disableable',
                },
                enable: { allowed: false, reason: '当前段已启用', reasonCode: 'already-enabled' },
                rollback: { allowed: false, reason: '当前段无覆盖可回滚', reasonCode: 'no-override' },
                activateVersion: {
                  allowed: false,
                  reason: '当前段无保留版本可激活',
                  reasonCode: 'no-version-snapshot',
                },
              },
            },
          })}
        />,
      );
    });

    const button = container.querySelector('button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(container.textContent).toContain('当前段 disableable=false，不可禁用');
  });

  it('RollbackButton is disabled and shows reason when matrix disallows rollback', () => {
    act(() => {
      root.render(
        <RollbackButton
          hookId="S6"
          onRefresh={() => {}}
          enablementMatrix={makeMatrix({
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
                activateVersion: {
                  allowed: false,
                  reason: '当前段无保留版本可激活',
                  reasonCode: 'no-version-snapshot',
                },
              },
            },
          })}
        />,
      );
    });

    const button = container.querySelector('button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(container.textContent).toContain('当前段无覆盖可回滚');
  });

  it('ActivateVersionButton is disabled and shows reason when matrix disallows activateVersion', () => {
    act(() => {
      root.render(
        <ActivateVersionButton
          hookId="S6"
          epochVersion={2}
          onRefresh={() => {}}
          enablementMatrix={makeMatrix({
            safetyTier: 'readonly',
            allowLocalOverride: false,
            runtimeOverride: {
              enabled: true,
              hasOverride: true,
              hasContentOverride: true,
              hasVersionSnapshot: true,
              availableEpochVersions: [2],
              actions: {
                disable: {
                  allowed: false,
                  reason: '当前段 disableable=false，不可禁用',
                  reasonCode: 'not-disableable',
                },
                enable: { allowed: false, reason: '当前段已启用', reasonCode: 'already-enabled' },
                rollback: { allowed: true, reason: null, reasonCode: null },
                activateVersion: {
                  allowed: false,
                  reason: '当前段 safetyTier=readonly，禁止激活版本',
                  reasonCode: 'safety-tier-readonly',
                },
              },
            },
          })}
        />,
      );
    });

    const button = container.querySelector('button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(container.textContent).toContain('当前段 safetyTier=readonly，禁止激活版本');
  });

  it('ActivateVersionButton is disabled and shows reason when version is not in availableEpochVersions', () => {
    act(() => {
      root.render(
        <ActivateVersionButton
          hookId="S6"
          epochVersion={3}
          onRefresh={() => {}}
          enablementMatrix={makeMatrix({
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
              },
            },
          })}
        />,
      );
    });

    const button = container.querySelector('button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(container.textContent).toContain('版本 v3 不在可激活历史版本列表中');
  });

  it('ToggleOverrideButton triggers API when allowed and reason provided', async () => {
    apiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });
    const onRefresh = vi.fn();

    act(() => {
      root.render(
        <ToggleOverrideButton hookId="S6" currentlyEnabled onRefresh={onRefresh} enablementMatrix={makeMatrix()} />,
      );
    });

    const button = container.querySelector('button') as HTMLButtonElement;
    expect(button.disabled).toBe(false);

    vi.spyOn(window, 'confirm').mockReturnValueOnce(true);
    vi.spyOn(window, 'prompt').mockReturnValueOnce('test reason');
    act(() => {
      button.click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(apiFetch).toHaveBeenCalledWith(
      '/api/prompt-hooks/S6/override',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ action: 'disable', reason: 'test reason' }),
      }),
    );
    expect(onRefresh).toHaveBeenCalled();
  });

  it('ActivateVersionButton triggers API when version is available and allowed', async () => {
    apiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });
    const onRefresh = vi.fn();

    act(() => {
      root.render(
        <ActivateVersionButton
          hookId="S6"
          epochVersion={2}
          onRefresh={onRefresh}
          enablementMatrix={makeMatrix({
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
              },
            },
          })}
        />,
      );
    });

    const button = container.querySelector('button') as HTMLButtonElement;
    expect(button.disabled).toBe(false);

    vi.spyOn(window, 'confirm').mockReturnValueOnce(true);
    vi.spyOn(window, 'prompt').mockReturnValueOnce('audit reason');
    act(() => {
      button.click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(apiFetch).toHaveBeenCalledWith(
      '/api/prompt-hooks/S6/versions/activate',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ epochVersion: 2, reason: 'audit reason' }),
      }),
    );
    expect(onRefresh).toHaveBeenCalled();
  });
});
