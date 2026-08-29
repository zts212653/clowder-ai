import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OfficialPluginCatchUp } from '../OfficialPluginCatchUp';

describe('OfficialPluginCatchUp', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('keeps a re-preview path available when a frozen preview becomes stale', () => {
    const onAction = vi.fn();
    act(() => {
      root.render(
        <OfficialPluginCatchUp
          health={{
            status: 'ready',
            lastCycleAt: null,
            lastSuccessfulObservationAt: null,
            lastPublishedAt: null,
            pendingCount: 0,
            catchUp: {
              status: 'previewed',
              fromCursor: 'poll-v1:1000',
              throughCursor: 'poll-v1:5000',
              candidateCount: 3,
              fingerprint: 'a'.repeat(64),
              previewedAt: 5_300,
            },
            warning: {
              code: 'CATCH_UP_REQUIRED',
              message: '已预览到 3 条候选，请选择仅恢复以后或同时补抓。',
              action: 'resolve-catch-up',
            },
          }}
          updateAvailable={false}
          busy={false}
          onAction={onAction}
        />,
      );
    });

    const repreview = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('重新预览'),
    );
    expect(repreview).toBeDefined();

    act(() => repreview?.click());
    expect(onAction).toHaveBeenCalledWith('preview');
  });
});
