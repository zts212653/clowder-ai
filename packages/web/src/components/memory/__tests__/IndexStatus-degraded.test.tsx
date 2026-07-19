/**
 * F188 Phase K — Task 4: frontend degraded banner (AC-K4)
 *
 * Pure-function tests for `shouldShowDegradedBanner` + render tests for
 * `DegradedBanner` extracted from IndexStatus.tsx. The full IndexStatus
 * component (with apiFetch + polling) is exercised in alpha dogfood; here
 * we lock the pure behavior so unit-level changes can't drift.
 *
 * Spec: docs/features/F188-library-stewardship.md Phase K AC-K4
 * Plan: docs/plans/2026-06-09-f188-phase-k-config-health-surface.md Task 4
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import {
  type ConfigWarning,
  DegradedBanner,
  type IndexStatusData,
  shouldShowDegradedBanner,
  WARNING_ACTION_TARGETS,
} from '../IndexStatus';

Object.assign(globalThis as Record<string, unknown>, { React });

function makeStatus(overrides: Partial<IndexStatusData> = {}): IndexStatusData {
  return {
    backend: 'sqlite',
    healthy: true,
    docsCount: 10,
    vectorsCount: 0,
    threadsCount: 1,
    passagesCount: 0,
    passageVectorsCount: 0,
    passageVectorsSupported: true,
    passageWarmupActive: false,
    edgesCount: 0,
    lastRebuildAt: null,
    embeddingModel: 'cl100k_base',
    reason: undefined,
    functionalStatus: 'degraded',
    configWarnings: [],
    ...overrides,
  };
}

const W: Record<string, ConfigWarning> = {
  vectors: { code: 'vectors_empty', message: 'Vector index empty', suggestedAction: 'Run reindex' },
  graph: { code: 'graph_empty', message: 'No edges', suggestedAction: 'Run extraction' },
  embedding: { code: 'embedding_disabled', message: 'No embedder', suggestedAction: 'Configure embedder' },
};

describe('shouldShowDegradedBanner (AC-K4 predicate)', () => {
  it('functionalStatus=ok → hide', () => {
    const status = makeStatus({ functionalStatus: 'ok', configWarnings: [] });
    expect(shouldShowDegradedBanner(status)).toBe(false);
  });

  it('functionalStatus=degraded + ≥1 warning → show', () => {
    const status = makeStatus({ functionalStatus: 'degraded', configWarnings: [W.vectors!] });
    expect(shouldShowDegradedBanner(status)).toBe(true);
  });

  it('healthy=false → hide (red fatal badge takes precedence)', () => {
    // Even if backend marks functionalStatus=degraded, hide yellow banner when
    // healthy=false — the red fatal badge already communicates the failure.
    const status = makeStatus({
      healthy: false,
      functionalStatus: 'degraded',
      configWarnings: [W.vectors!],
    });
    expect(shouldShowDegradedBanner(status)).toBe(false);
  });

  it('degraded + empty warnings → hide (defensive)', () => {
    const status = makeStatus({ functionalStatus: 'degraded', configWarnings: [] });
    expect(shouldShowDegradedBanner(status)).toBe(false);
  });
});

describe('DegradedBanner render (AC-K4 rendered structure)', () => {
  function render(warnings: ConfigWarning[], onWarningClick?: (code: string) => void): HTMLElement {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(<DegradedBanner warnings={warnings} onWarningClick={onWarningClick} />);
    });
    return container;
  }

  it('renders 1 warning row with message + suggestedAction', () => {
    const container = render([W.vectors!]);
    const banner = container.querySelector('[data-testid="memory-degraded-banner"]');
    expect(banner).toBeTruthy();
    const rows = container.querySelectorAll('[data-testid^="memory-degraded-warning-"]');
    expect(rows.length).toBe(1);
    expect(rows[0]!.getAttribute('data-testid')).toBe('memory-degraded-warning-vectors_empty');
    expect(rows[0]!.textContent).toContain('Vector index empty');
    expect(rows[0]!.textContent).toContain('Run reindex');
  });

  it('renders 3 warning rows each with code-keyed testid', () => {
    const container = render([W.vectors!, W.graph!, W.embedding!]);
    const rows = container.querySelectorAll('[data-testid^="memory-degraded-warning-"]');
    expect(rows.length).toBe(3);
    const codes = Array.from(rows).map((r) => r.getAttribute('data-testid')?.replace('memory-degraded-warning-', ''));
    expect(codes).toEqual(['vectors_empty', 'graph_empty', 'embedding_disabled']);
    // every row carries its suggestedAction text
    for (const row of rows) {
      expect(row.textContent?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('banner title carries the Memory-capabilities-degraded label', () => {
    const container = render([W.vectors!]);
    const banner = container.querySelector('[data-testid="memory-degraded-banner"]');
    expect(banner?.textContent).toContain('Memory capabilities degraded');
    expect(banner?.textContent).toContain('configuration issues detected');
  });

  // AC-K4 review P1-1 (砚砚 2026-06-19): suggestedAction must be clickable next step,
  // not a plain text span. Tests below RED-locked the contract so future drift would fail.

  it('AC-K4 P1-1: each suggestedAction renders as a real <button> (not span)', () => {
    const container = render([W.vectors!, W.graph!, W.embedding!]);
    const buttons = container.querySelectorAll('button[data-testid^="memory-degraded-action-"]');
    expect(buttons.length).toBe(3);
    for (const btn of buttons) {
      // <button> elements implicitly have role="button" + are keyboard accessible
      expect(btn.tagName).toBe('BUTTON');
      expect(btn.getAttribute('type')).toBe('button');
    }
  });

  it('AC-K4 P1-1: action button carries the suggestedAction text', () => {
    const container = render([W.vectors!]);
    const btn = container.querySelector('button[data-testid="memory-degraded-action-vectors_empty"]');
    expect(btn).toBeTruthy();
    expect(btn?.textContent).toContain('Run reindex');
  });

  it('AC-K4 P1-1: click on action button fires onWarningClick with warning code', () => {
    const onClick = vi.fn();
    const container = render([W.vectors!, W.embedding!], onClick);
    const vectorsBtn = container.querySelector(
      'button[data-testid="memory-degraded-action-vectors_empty"]',
    ) as HTMLButtonElement;
    const embeddingBtn = container.querySelector(
      'button[data-testid="memory-degraded-action-embedding_disabled"]',
    ) as HTMLButtonElement;
    expect(vectorsBtn).toBeTruthy();
    expect(embeddingBtn).toBeTruthy();
    act(() => {
      vectorsBtn.click();
    });
    expect(onClick).toHaveBeenLastCalledWith('vectors_empty');
    act(() => {
      embeddingBtn.click();
    });
    expect(onClick).toHaveBeenLastCalledWith('embedding_disabled');
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('AC-K4 P1-1: omitting onWarningClick still renders buttons (no crash on click)', () => {
    const container = render([W.vectors!]);
    const btn = container.querySelector(
      'button[data-testid="memory-degraded-action-vectors_empty"]',
    ) as HTMLButtonElement;
    expect(btn).toBeTruthy();
    // no callback wired — click should be safe noop, not throw
    expect(() => act(() => btn.click())).not.toThrow();
  });
});

describe('warning action routing', () => {
  it('routes embedding lifecycle warnings to the writable service controls', () => {
    expect(WARNING_ACTION_TARGETS.embedding_disabled).toBe('embedding-service-controls');
    expect(WARNING_ACTION_TARGETS.vec_table_missing).toBe('embedding-service-controls');
  });

  it('routes rebuildable index warnings to the rebuild controls', () => {
    expect(WARNING_ACTION_TARGETS.vectors_empty).toBe('rebuild-controls');
    expect(WARNING_ACTION_TARGETS.graph_empty).toBe('rebuild-controls');
  });

  it('keeps the dev preview on the local embedding setup path', () => {
    const previewSource = readFileSync(resolve(process.cwd(), 'src/app/dev/memory-status-preview/page.tsx'), 'utf8');
    expect(previewSource).not.toContain('OPENAI_EMBEDDING_API_KEY');
    expect(previewSource).not.toContain('Install sqlite-vec via Memory Center');
    expect(previewSource).toContain('recommended local embedding service');
    expect(previewSource).toContain('Open the local embedding service controls');
  });
});
