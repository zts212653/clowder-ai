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
    expect(html).toContain('bg-slate-800');
    expect(html).not.toContain('--color-cocreator-bg');
  });

  it('EvidenceCard uses dark card styling with high-contrast text', () => {
    const result: EvidenceResult = {
      title: 'F097 CLI 重构',
      anchor: 'F097',
      snippet: 'tintedDark 品种色方案',
      confidence: 'high',
      sourceType: 'decision',
    };

    act(() => {
      root.render(React.createElement(EvidenceCard, { result }));
    });

    const html = container.innerHTML;
    // Dark card background
    expect(html).toContain('bg-slate-900');
    // Should NOT use old light-mode CSS vars
    expect(html).not.toContain('--color-base-white');
    expect(html).not.toContain('--color-gemini-bg');
  });

  it('EvidenceCard confidence badge uses appropriate dark colors', () => {
    const result: EvidenceResult = {
      title: 'Test',
      anchor: 'test',
      snippet: 'test',
      confidence: 'high',
      sourceType: 'decision',
    };

    act(() => {
      root.render(React.createElement(EvidenceCard, { result }));
    });

    const html = container.innerHTML;
    // High confidence should use emerald in dark mode
    expect(html).toContain('bg-emerald-900');
    expect(html).toContain('text-emerald-300');
  });
});
