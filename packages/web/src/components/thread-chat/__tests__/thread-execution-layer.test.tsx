/**
 * F322 original-B mount: between the history and the composer the classic interface keeps the old execution bar and the
 * "待处理" queue panel; the new shell shows the one execution row instead. The shell switch is the one the header and the
 * messages already use.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SHELL_PRESENTATION_STORAGE_KEY, writeShellPresentation } from '../../shell/shell-presentation';

vi.mock('../../execution-row/ExecutionRow', () => ({
  ExecutionRow: ({ threadId }: { threadId: string }) => <div data-testid="execution-row" data-thread={threadId} />,
}));
vi.mock('../../ThreadExecutionBar', () => ({
  ThreadExecutionBar: ({ threadId }: { threadId: string }) => (
    <div data-testid="old-execution-bar" data-thread={threadId} />
  ),
}));
vi.mock('../../QueuePanel', () => ({
  QueuePanel: ({ threadId }: { threadId: string }) => <div data-testid="old-queue-panel" data-thread={threadId} />,
}));

import { ThreadExecutionLayer } from '../ThreadExecutionLayer';

describe('ThreadExecutionLayer', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  beforeEach(() => {
    window.localStorage.removeItem(SHELL_PRESENTATION_STORAGE_KEY);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.localStorage.removeItem(SHELL_PRESENTATION_STORAGE_KEY);
  });

  const ids = () => [...container.querySelectorAll('[data-testid]')].map((el) => el.getAttribute('data-testid'));

  it('classic (and the default): the old execution bar then the queue panel, in that order, and no row', () => {
    act(() => root.render(<ThreadExecutionLayer threadId="t1" />));
    expect(ids()).toEqual(['old-execution-bar', 'old-queue-panel']);
    expect(container.querySelector('[data-testid="old-execution-bar"]')?.getAttribute('data-thread')).toBe('t1');
    expect(container.querySelector('[data-testid="old-queue-panel"]')?.getAttribute('data-thread')).toBe('t1');
  });

  it('classic chosen explicitly renders exactly what the default renders', () => {
    act(() => root.render(<ThreadExecutionLayer threadId="t1" />));
    const byDefault = container.innerHTML;
    act(() => writeShellPresentation('classic'));
    expect(container.innerHTML).toBe(byDefault);
  });

  it('v2: only the one execution row, for the same thread; the old bar and the panel are not rendered', () => {
    act(() => writeShellPresentation('v2'));
    act(() => root.render(<ThreadExecutionLayer threadId="t2" />));
    expect(ids()).toEqual(['execution-row']);
    expect(container.querySelector('[data-testid="execution-row"]')?.getAttribute('data-thread')).toBe('t2');
  });

  it('switching the preference swaps the surfaces live in both directions', () => {
    act(() => root.render(<ThreadExecutionLayer threadId="t3" />));
    expect(ids()).toEqual(['old-execution-bar', 'old-queue-panel']);
    act(() => writeShellPresentation('v2'));
    expect(ids()).toEqual(['execution-row']);
    act(() => writeShellPresentation('classic'));
    expect(ids()).toEqual(['old-execution-bar', 'old-queue-panel']);
  });
});
