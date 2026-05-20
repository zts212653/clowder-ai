import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MermaidDiagram } from '@/components/MermaidDiagram';

Object.assign(globalThis as Record<string, unknown>, { React, IS_REACT_ACT_ENVIRONMENT: true });

const mermaidMock = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}));

vi.mock('mermaid', () => ({
  default: mermaidMock,
}));

describe('MermaidDiagram', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mermaidMock.initialize.mockReset();
    mermaidMock.render.mockReset();
    mermaidMock.render.mockResolvedValue({
      svg: '<svg><script>alert("x")</script><g id="safe-node"></g></svg>',
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('renders sanitized SVG with strict Mermaid configuration', async () => {
    await act(async () => {
      root.render(<MermaidDiagram source={'flowchart TD\n  A --> B'} />);
    });

    await vi.waitFor(() => expect(container.querySelector('svg')).toBeTruthy());
    expect(mermaidMock.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        startOnLoad: false,
        securityLevel: 'strict',
      }),
    );
    expect(mermaidMock.render).toHaveBeenCalledWith(expect.stringMatching(/^mermaid-/), 'flowchart TD\n  A --> B');
    expect(container.innerHTML).toContain('safe-node');
    expect(container.innerHTML).not.toContain('<script');
  });

  it('uses SVG labels so sanitization does not erase Mermaid node text', async () => {
    await act(async () => {
      root.render(<MermaidDiagram source={'flowchart TD\n  A["State<br/>读状态"] --> B["Owner<br/>负责"]'} />);
    });

    await vi.waitFor(() => expect(container.querySelector('svg')).toBeTruthy());
    expect(mermaidMock.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        flowchart: expect.objectContaining({
          htmlLabels: false,
        }),
      }),
    );
  });
});
