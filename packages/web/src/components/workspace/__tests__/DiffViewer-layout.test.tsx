import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DiffViewer } from '../DiffViewer';

const DIFF = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1,1 +1,1 @@', '-old', '+new'].join('\n');

describe('DiffViewer split layout contract', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as Record<string, unknown>).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  // P2-A (sol @ ccd01dabf): callers that opt into nothing must keep the old
  // auto-layout contract, so code diffs still scroll at their natural width.
  it('keeps auto table layout for split diffs that opt into no new behaviour', async () => {
    await act(async () => root.render(<DiffViewer diff={DIFF} initialMode="split" />));
    const table = container.querySelector('table');
    expect(table?.className).not.toContain('table-fixed');
  });

  it('uses fixed layout only when wrapping or headers are requested', async () => {
    await act(async () => root.render(<DiffViewer diff={DIFF} initialMode="split" wrapLines />));
    expect(container.querySelector('table')?.className).toContain('table-fixed');
  });
});
