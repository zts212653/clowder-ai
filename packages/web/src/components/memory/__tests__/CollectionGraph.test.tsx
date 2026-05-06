import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CollectionGraph } from '../CollectionGraph';

const GRAPH_RESPONSE = {
  nodes: [
    {
      anchor: 'a1',
      collectionId: 'project:cafe',
      sensitivity: 'internal',
      kind: 'spec',
      title: 'Memory Arch',
      redacted: false,
    },
    {
      anchor: 'a2',
      collectionId: 'world:lexander',
      sensitivity: 'private',
      kind: 'lore',
      title: 'Dragon Lore',
      redacted: true,
    },
    {
      anchor: 'a3',
      collectionId: 'project:cafe',
      sensitivity: 'internal',
      kind: 'decision',
      title: 'ADR-033',
      redacted: false,
    },
  ],
  edges: [
    {
      from: 'a1',
      to: 'a2',
      relation: 'related_to',
      crossCollection: true,
      edgeSensitivity: 'private',
      provenance: 'frontmatter',
      redacted: false,
    },
    {
      from: 'a1',
      to: 'a3',
      relation: 'evolved_from',
      crossCollection: false,
      edgeSensitivity: 'internal',
      provenance: 'frontmatter',
      redacted: false,
    },
  ],
  center: 'a1',
  depth: 1,
};

describe('CollectionGraph force-directed', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(GRAPH_RESPONSE) })),
    );
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    root.unmount();
    container.remove();
    vi.restoreAllMocks();
  });

  it('renders graph nodes after fetch', async () => {
    await act(async () => {
      root.render(<CollectionGraph />);
    });
    const input = container.querySelector('[data-testid="graph-anchor-input"]') as HTMLInputElement;
    const btn = container.querySelector('[data-testid="graph-fetch-btn"]') as HTMLButtonElement;
    await act(async () => {
      input.value = 'a1';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      btn.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(container.querySelector('[data-testid="graph-svg"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="graph-node-a1"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="graph-node-a2"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="graph-node-a3"]')).toBeTruthy();
  });

  it('shows tooltip on hover with node details', async () => {
    await act(async () => {
      root.render(<CollectionGraph />);
    });
    const input = container.querySelector('[data-testid="graph-anchor-input"]') as HTMLInputElement;
    const btn = container.querySelector('[data-testid="graph-fetch-btn"]') as HTMLButtonElement;
    await act(async () => {
      input.value = 'a1';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      btn.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const node = container.querySelector('[data-testid="graph-node-a1"]') as Element;
    await act(async () => {
      node.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    });
    const tooltip = container.querySelector('[data-testid="graph-tooltip"]');
    expect(tooltip).toBeTruthy();
    expect(tooltip?.textContent).toContain('Memory Arch');
    expect(tooltip?.textContent).toContain('project:cafe');
    expect(tooltip?.textContent).toContain('internal');
  });

  it('renders private/redacted nodes with reduced opacity', async () => {
    await act(async () => {
      root.render(<CollectionGraph />);
    });
    const input = container.querySelector('[data-testid="graph-anchor-input"]') as HTMLInputElement;
    const btn = container.querySelector('[data-testid="graph-fetch-btn"]') as HTMLButtonElement;
    await act(async () => {
      input.value = 'a1';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      btn.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const privateNode = container.querySelector('[data-testid="graph-node-a2"]') as SVGGElement;
    expect(privateNode.getAttribute('opacity')).toBe('0.5');
  });

  it('activates drill-down and tooltip via keyboard (Enter + focus)', async () => {
    await act(async () => {
      root.render(<CollectionGraph />);
    });
    const input = container.querySelector('[data-testid="graph-anchor-input"]') as HTMLInputElement;
    const btn = container.querySelector('[data-testid="graph-fetch-btn"]') as HTMLButtonElement;
    await act(async () => {
      input.value = 'a1';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      btn.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const node = container.querySelector('[data-testid="graph-node-a3"]') as SVGGElement;

    // Focus should show tooltip
    await act(async () => {
      node.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
    });
    const tooltip = container.querySelector('[data-testid="graph-tooltip"]');
    expect(tooltip).toBeTruthy();
    expect(tooltip?.textContent).toContain('ADR-033');

    // Enter key should trigger drill-down
    await act(async () => {
      node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(fetch).toHaveBeenCalledTimes(2);

    // Blur should hide tooltip
    await act(async () => {
      node.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="graph-tooltip"]')).toBeNull();
  });

  it('fetches new graph on node click (drill-down)', async () => {
    await act(async () => {
      root.render(<CollectionGraph />);
    });
    const input = container.querySelector('[data-testid="graph-anchor-input"]') as HTMLInputElement;
    const btn = container.querySelector('[data-testid="graph-fetch-btn"]') as HTMLButtonElement;
    await act(async () => {
      input.value = 'a1';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      btn.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    await act(async () => {
      const node = container.querySelector('[data-testid="graph-node-a3"]') as SVGGElement;
      node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('clears tooltip when graph data changes via drill-down', async () => {
    await act(async () => {
      root.render(<CollectionGraph />);
    });
    const input = container.querySelector('[data-testid="graph-anchor-input"]') as HTMLInputElement;
    const btn = container.querySelector('[data-testid="graph-fetch-btn"]') as HTMLButtonElement;
    await act(async () => {
      input.value = 'a1';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      btn.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const node = container.querySelector('[data-testid="graph-node-a1"]') as SVGGElement;
    await act(async () => {
      node.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="graph-tooltip"]')).toBeTruthy();

    await act(async () => {
      const drillNode = container.querySelector('[data-testid="graph-node-a3"]') as SVGGElement;
      drillNode.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(container.querySelector('[data-testid="graph-tooltip"]')).toBeNull();
  });
});
