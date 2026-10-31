import mermaid from 'mermaid';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MermaidDiagram } from '@/components/MermaidDiagram';
import { SHELL_PRESENTATION_STORAGE_KEY, writeShellPresentation } from '@/components/shell/shell-presentation';

Object.assign(globalThis as Record<string, unknown>, { React, IS_REACT_ACT_ENVIRONMENT: true });
const renderSpy = vi.spyOn(mermaid, 'render');
const consoleError = vi.spyOn(console, 'error');

async function settleRealRenders(count: number): Promise<void> {
  await act(async () => {
    // Observe the real renderer's promise, rather than waiting for DOM that React
    // can only commit after this act boundary finishes.
    await vi.waitFor(() => expect(renderSpy).toHaveBeenCalledTimes(count), { timeout: 5000 });
    await Promise.allSettled(renderSpy.mock.results.map((result) => result.value));
  });
}

afterAll(() => {
  renderSpy.mockRestore();
  consoleError.mockRestore();
});

beforeAll(() => {
  Object.defineProperty(SVGElement.prototype, 'getBBox', {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 100, height: 20 }),
  });
  Object.defineProperty(SVGElement.prototype, 'getComputedTextLength', {
    configurable: true,
    value: () => 80,
  });
});

describe('Mermaid reading isolation with the real renderer', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    renderSpy.mockClear();
    consoleError.mockClear();
    window.localStorage.setItem(SHELL_PRESENTATION_STORAGE_KEY, 'v2');
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
    window.localStorage.removeItem(SHELL_PRESENTATION_STORAGE_KEY);
    expect(consoleError.mock.calls.some(([message]) => String(message).includes('not wrapped in act'))).toBe(false);
  });

  it('keeps rejected diagrams and their source inside the message owner', async () => {
    act(() => {
      root.render(<MermaidDiagram source="this is not valid mermaid syntax" />);
    });
    await settleRealRenders(1);
    expect(container.textContent).toContain('Mermaid 图表渲染失败');

    expect(container.querySelector('pre')?.textContent).toBe('this is not valid mermaid syntax');
    expect(container.querySelector('[data-quote-exclude]')).toBeTruthy();
    expect([...document.body.children]).toEqual([container]);
    expect(document.body.querySelector('svg')).toBeNull();
  });

  it('keeps successful sanitized diagrams inside the same owner', async () => {
    act(() => {
      root.render(<MermaidDiagram source={'flowchart LR\n  A["读状态"] --> B["验证"]'} />);
    });
    await settleRealRenders(1);
    expect(container.querySelector('svg')).toBeTruthy();

    expect([...document.body.children]).toEqual([container]);
    expect(container.textContent).toContain('读状态');
    expect(container.textContent).toContain('验证');
    expect(container.querySelector('script')).toBeNull();
  });

  it('cleans this owner when classic switches to v2 without touching another owner', async () => {
    act(() => writeShellPresentation('classic'));
    act(() => root.render(<MermaidDiagram source="this is not valid mermaid syntax" />));
    await settleRealRenders(1);
    const scratchId = `d${renderSpy.mock.calls[0]?.[0]}`;
    expect(document.getElementById(scratchId)?.querySelector('svg')).toBeTruthy();

    const otherOwner = document.createElement('div');
    otherOwner.id = 'dmermaid-another-owner';
    document.body.append(otherOwner);
    act(() => writeShellPresentation('v2'));
    await settleRealRenders(2);

    expect(container.textContent).toContain('Mermaid 图表渲染失败');
    expect(document.getElementById(scratchId)).toBeNull();
    expect([...document.body.children]).toEqual([container, otherOwner]);
    expect(renderSpy.mock.calls[1]?.[0]).not.toBe(renderSpy.mock.calls[0]?.[0]);
  });
});
