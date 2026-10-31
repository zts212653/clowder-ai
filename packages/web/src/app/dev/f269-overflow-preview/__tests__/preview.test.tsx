import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { F269_PREVIEW_CASES, normalizeF269PreviewCase, normalizeF269PreviewView } from '../cases';
import { F269DesignGatePreview } from '../design-gate';
import { F269_TOOL_RESULT_FIXTURE, F269OverflowPreview } from '../preview';

Object.assign(globalThis as Record<string, unknown>, { React });

vi.mock('@/hooks/useFeatureDocDetail', () => ({
  useFeatureDocDetail: () => ({ detail: null, loading: false }),
}));

describe('F269 overflow evidence preview', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
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

  it('binds exactly three deterministic fixtures to audited ledger record ids', () => {
    expect(F269_PREVIEW_CASES.map((preview) => preview.ledgerRecordId)).toEqual([
      'css:packages/web/src/components/settings/primitives/SettingsRow.tsx:82',
      'css:packages/web/src/components/rich/FileBlock.tsx:71',
      'producer:web:story-tool-result',
    ]);
    expect(new Set(F269_PREVIEW_CASES.map((preview) => preview.screenshotFileName)).size).toBe(3);
    expect(F269_PREVIEW_CASES.every((preview) => preview.screenshotFileName.endsWith('.png'))).toBe(true);
  });

  it('normalizes unknown or repeated query values to the prose fixture', () => {
    expect(normalizeF269PreviewCase(undefined)).toBe('settings-prose');
    expect(normalizeF269PreviewCase('not-a-case')).toBe('settings-prose');
    expect(normalizeF269PreviewCase(['file-name', 'tool-result'])).toBe('settings-prose');
    expect(normalizeF269PreviewCase('tool-result')).toBe('tool-result');
  });

  it('defaults the dev route to the Phase B design gate while retaining explicit Phase A evidence', () => {
    expect(normalizeF269PreviewView(undefined)).toBe('design');
    expect(normalizeF269PreviewView('unknown')).toBe('design');
    expect(normalizeF269PreviewView(['design', 'evidence'])).toBe('design');
    expect(normalizeF269PreviewView('evidence')).toBe('evidence');
  });

  it('renders the approved Phase A baseline separately from the recoverable target', async () => {
    await act(async () => {
      root.render(<F269DesignGatePreview />);
    });

    const patterns = Array.from(container.querySelectorAll<HTMLElement>('[data-pattern]'));
    expect(patterns.map((node) => node.dataset.pattern)).toEqual([
      'compact-label',
      'expandable-prose',
      'long-form-reader',
      'critical-text',
    ]);
    expect(patterns.every((node) => node.textContent?.includes('Phase A baseline · 信息死路'))).toBe(true);
    expect(patterns.every((node) => node.textContent?.includes('目标 · 全文可达'))).toBe(true);
    expect(
      Array.from(container.querySelectorAll<HTMLElement>('[data-f269-baseline-fixture]')).map(
        (node) => node.dataset.f269BaselineFixture,
      ),
    ).toEqual(['file-name', 'settings-prose', 'critical-text']);
    expect(patterns.map((node) => node.dataset.ledgerRecordId)).toEqual([
      'css:packages/web/src/components/rich/FileBlock.tsx:71',
      'css:packages/web/src/components/settings/primitives/SettingsRow.tsx:82',
      'producer:web:story-tool-result',
      'css:packages/web/src/components/ApprovalItemCard.tsx:145',
    ]);
    expect(container.textContent).toContain('阅读全文');
    expect(container.textContent).toContain('密集列表模式');
    expect(container.textContent).toContain('查看技术详情');
    const visualRestraint = container.querySelector<HTMLElement>('[data-testid="f269-visual-restraint"]');
    expect(visualRestraint?.textContent).toContain('砚砚处理完成');
    expect(visualRestraint?.querySelector('[data-critical-text-appearance]')).toBeNull();
    expect(visualRestraint?.querySelector('[data-testid="toast-content"] button')).toBeNull();
    const closeToast = visualRestraint?.querySelector<HTMLButtonElement>('button[aria-label="关闭“砚砚处理完成”通知"]');
    expect(closeToast).not.toBeNull();
    await act(async () => closeToast?.click());
    expect(visualRestraint?.textContent).not.toContain('砚砚处理完成');

    const criticalPattern = container.querySelector<HTMLElement>('[data-pattern="critical-text"]');
    const [baseline, target] = criticalPattern?.querySelectorAll<HTMLElement>(':scope > div:last-child > div') ?? [];
    expect(baseline?.querySelector('[data-f269-baseline-fixture="critical-text"]')).not.toBeNull();
    expect(baseline?.querySelector('[data-critical-text-appearance]')).toBeNull();
    expect(target?.querySelector('[data-critical-text-appearance="inline"]')).not.toBeNull();
  });

  it('renders the Session Audit production recovery spot-check without nested panels', async () => {
    await act(async () => {
      root.render(<F269DesignGatePreview />);
    });

    const surface = container.querySelector<HTMLElement>('[data-testid="f269-session-audit-recovery"]');
    expect(surface?.textContent).toContain('cascade-f269-session-audit-preview-tail');
    expect(surface?.querySelectorAll('[data-overflow-measure="inline"]')).toHaveLength(5);
    expect(surface?.querySelector('[data-critical-text-appearance="inline"]')).not.toBeNull();
    expect(surface?.querySelector('[data-critical-text-appearance="panel"]')).toBeNull();
  });

  it('renders the Mission Control label recovery spot-check with sibling row actions', async () => {
    await act(async () => {
      root.render(<F269DesignGatePreview />);
    });

    const surface = container.querySelector<HTMLElement>('[data-testid="f269-mission-control-recovery"]');
    expect(surface?.textContent).toContain('Mission Control Feature Name With A Canonical Tail');
    expect(surface?.querySelectorAll('[data-overflow-measure="inline"]')).toHaveLength(2);
    expect(surface?.querySelector('button button')).toBeNull();
    expect(surface?.querySelector('a button')).toBeNull();

    const toggle = surface?.querySelector<HTMLButtonElement>(
      '[data-testid="mc-feature-row-F269"] button[data-feature-row-toggle]',
    );
    expect(toggle?.className).toContain('absolute');
    expect(toggle?.className).toContain('inset-0');
    await act(async () => toggle?.click());
    expect(surface?.textContent).toContain('关联线程');
    expect(surface?.textContent).toContain('canonical-tail-linked');
    expect(surface?.querySelectorAll('[data-overflow-measure="inline"]')).toHaveLength(3);
  });

  it.each([
    ['settings-prose', 'css:packages/web/src/components/settings/primitives/SettingsRow.tsx:82'],
    ['file-name', 'css:packages/web/src/components/rich/FileBlock.tsx:71'],
  ] as const)('renders the historical %s baseline under its Phase A audit anchor', async (caseId, recordId) => {
    await act(async () => {
      root.render(<F269OverflowPreview caseId={caseId} />);
    });

    expect(container.querySelector('[data-testid="f269-preview-surface"]')?.getAttribute('data-ledger-record-id')).toBe(
      recordId,
    );
    expect(container.querySelector('[data-f269-baseline-fixture]')?.getAttribute('data-f269-baseline-fixture')).toBe(
      caseId,
    );
    expect(container.textContent).toContain('Phase A baseline UI');
  });

  it('reproduces the Story Player physical slice with an absent tail sentinel', async () => {
    await act(async () => {
      root.render(<F269OverflowPreview caseId="tool-result" />);
    });

    expect(container.textContent).toContain(`${F269_TOOL_RESULT_FIXTURE.length - 2000} chars`);
    expect(container.textContent).not.toContain('F269_TAIL_SENTINEL_MUST_DISAPPEAR');
    expect(container.querySelector('[data-testid="f269-preview-surface"]')?.getAttribute('data-ledger-record-id')).toBe(
      'producer:web:story-tool-result',
    );
  });

  it('uses the Hub preview bridge for deterministic evidence capture', async () => {
    vi.useFakeTimers();
    const postMessage = vi.spyOn(window, 'postMessage').mockImplementation(() => {});

    await act(async () => {
      root.render(<F269OverflowPreview caseId="tool-result" autoCapture />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });

    expect(postMessage).toHaveBeenCalledWith(
      { type: 'screenshot-request', source: 'cat-cafe-preview' },
      window.location.origin,
    );

    postMessage.mockRestore();
    vi.useRealTimers();
  });
});
