/**
 * F098-B1: Evidence Panel dark slate theme for readability
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { EvidenceResult } from '../EvidenceCard';
import { EvidenceCard } from '../EvidenceCard';
import { EvidencePanel } from '../EvidencePanel';

describe('Evidence Panel dark theme (F098-B1)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
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

  it('EvidencePanel uses slate dark background', () => {
    act(() => {
      root.render(
        React.createElement(EvidencePanel, {
          data: { results: [], degraded: false },
        }),
      );
    });

    const html = container.innerHTML;
    expect(html).toContain('bg-cafe-surface-sunken');
    expect(html).not.toContain('--color-cocreator-bg');
  });

  it('EvidenceCard uses dark card styling with high-contrast text', () => {
    const result: EvidenceResult = {
      title: 'F097 CLI 重构',
      anchor: 'F097',
      snippet: 'tintedDark 品种色方案',
      matchRank: 'high',
      sourceType: 'decision',
      authority: 'validated',
      updatedAt: '2026-07-12T00:00:00Z',
    };

    act(() => {
      root.render(React.createElement(EvidenceCard, { result }));
    });

    const html = container.innerHTML;
    // Dark card background
    expect(html).toContain('bg-cafe-surface-sunken');
    // Should NOT use old light-mode CSS vars
    expect(html).not.toContain('--color-base-white');
    expect(html).not.toContain('--color-gemini-bg');
    expect(html).toContain('match:high · authority:validated · updated:');
    expect(html).toContain('2026-07-12T00:00:00Z');
  });

  it('EvidenceCard match-rank badge uses appropriate dark colors', () => {
    const result: EvidenceResult = {
      title: 'Test',
      anchor: 'test',
      snippet: 'test',
      matchRank: 'high',
      sourceType: 'decision',
    };

    act(() => {
      root.render(React.createElement(EvidenceCard, { result }));
    });

    const html = container.innerHTML;
    // High match rank should use semantic emerald tokens
    expect(html).toContain('bg-semantic-success-surface');
    expect(html).toContain('text-semantic-success');
  });

  it('EvidenceCard renders legacy persisted confidence without crashing', () => {
    const legacyResult = {
      title: 'Legacy cached result',
      anchor: 'legacy-anchor',
      snippet: 'Persisted before F263 split the result axes',
      confidence: 'high',
      sourceType: 'decision',
    } as unknown as EvidenceResult;

    act(() => {
      root.render(React.createElement(EvidenceCard, { result: legacyResult }));
    });

    const html = container.innerHTML;
    expect(html).toContain('match:high · authority:unknown · updated:');
    expect(html).toContain('bg-semantic-success-surface');
    expect(html).toContain('高匹配');
  });

  it('EvidenceCard renders architecture source type without falling through', () => {
    const result: EvidenceResult = {
      title: 'Memory System Overview',
      anchor: 'doc:architecture/memory-system-overview',
      snippet: 'Architecture map',
      matchRank: 'high',
      sourceType: 'architecture',
    };

    act(() => {
      root.render(React.createElement(EvidenceCard, { result }));
    });

    const html = container.innerHTML;
    expect(html).toContain('架构');
    expect(html).toContain('doc:architecture/memory-system-overview');
  });
});
