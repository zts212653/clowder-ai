import type { CapabilityTip } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const sourceTip: CapabilityTip = {
  id: 'capability-alpha-source',
  kind: 'capability',
  sourceRef: {
    path: 'docs/features/F244-capability-tips-system.md',
    anchor: 'open_source',
  },
  structureSource: {
    path: 'packages/api/src/infrastructure/harness-eval/capability-wakeup/capability-wakeup-rules.ts',
    anchor: 'browser-preview',
  },
  bodySource: {
    path: 'docs/features/F244-capability-tips-system.md',
    anchor: 'open_source',
  },
  contexts: ['thinking'],
  audience: ['all'],
  body: 'Source tips are valid inventory entries but this strip cannot open source anchors directly.',
  action: {
    type: 'open_source',
    label: 'Open source',
    sourceRef: {
      path: 'docs/features/F244-capability-tips-system.md',
      anchor: 'open_source',
    },
  },
  owner: 'codex',
};

const draftTip: CapabilityTip = {
  ...sourceTip,
  id: 'capability-beta-draft',
  body: 'Draft tips can safely open the concierge with a prefilled prompt from the waiting strip.',
  action: {
    type: 'open_concierge_draft',
    label: 'Learn more',
  },
};

const noActionTip: CapabilityTip = {
  ...sourceTip,
  id: 'capability-alpha-no-action',
  kind: 'magic_word',
  body: 'No-action tips are valid inventory entries but cannot back the waiting-strip CTA.',
  action: undefined,
};

vi.mock('@/lib/capabilityTipEvents', async () => ({
  recordCapabilityTipEvent: vi.fn(),
}));

describe('F244 CapabilityTipStrip action eligibility', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }
    root = null;
    container.remove();
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.doUnmock('@/lib/capability-tips.seed.json');
  });

  it('does not render non-draft tip actions as concierge draft actions', async () => {
    vi.doMock('@/lib/capability-tips.seed.json', () => ({
      default: [sourceTip, draftTip],
    }));

    const [{ CapabilityTipStrip }, { useConciergeStore }] = await Promise.all([
      import('../CapabilityTipStrip'),
      import('@/stores/conciergeStore'),
    ]);
    useConciergeStore.setState({
      surfaceState: 'collapsed',
      pendingPrompt: null,
    });

    await act(async () => {
      root = createRoot(container);
      root.render(
        <CapabilityTipStrip
          surface="assistant_stream_bubble"
          contexts={['thinking']}
          firstDelayMs={0}
          rotateMs={12000}
        />,
      );
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(0);
      await Promise.resolve();
    });

    const strip = container.querySelector('[data-testid="capability-tip-strip"]');
    expect(strip?.getAttribute('data-tip-id')).toBe('capability-beta-draft');
  });

  it('does not render no-action tips as concierge draft actions', async () => {
    vi.doMock('@/lib/capability-tips.seed.json', () => ({
      default: [noActionTip, draftTip],
    }));

    const [{ CapabilityTipStrip }, { useConciergeStore }] = await Promise.all([
      import('../CapabilityTipStrip'),
      import('@/stores/conciergeStore'),
    ]);
    useConciergeStore.setState({
      surfaceState: 'collapsed',
      pendingPrompt: null,
    });

    await act(async () => {
      root = createRoot(container);
      root.render(
        <CapabilityTipStrip
          surface="assistant_stream_bubble"
          contexts={['thinking']}
          firstDelayMs={0}
          rotateMs={12000}
        />,
      );
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(0);
      await Promise.resolve();
    });

    const strip = container.querySelector('[data-testid="capability-tip-strip"]');
    expect(strip?.getAttribute('data-tip-id')).toBe('capability-beta-draft');
  });
});
