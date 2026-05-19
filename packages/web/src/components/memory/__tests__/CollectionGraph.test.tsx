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

const GRAPH_RESOLUTION_RESPONSE = {
  status: 'graph',
  queryKind: 'exact',
  query: 'a1',
  resolvedAnchor: 'a1',
  graph: GRAPH_RESPONSE,
};

function jsonResponse(data: unknown) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve(data) });
}

function mockGraphFetch(
  resolveResponse: unknown = GRAPH_RESOLUTION_RESPONSE,
  directResponse: unknown = GRAPH_RESPONSE,
) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    return jsonResponse(url.includes('/api/library/graph/resolve') ? resolveResponse : directResponse);
  });
}

describe('CollectionGraph force-directed', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.stubGlobal('fetch', mockGraphFetch());
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

  it('shows readable title context for the center anchor', async () => {
    const graph = {
      nodes: [
        {
          anchor: 'F186',
          collectionId: 'project:cafe',
          sensitivity: 'internal',
          kind: 'feature',
          title: 'F186: 图书馆记忆架构（多域知识联邦）',
          redacted: false,
        },
      ],
      edges: [],
      center: 'F186',
      depth: 1,
    };
    vi.stubGlobal(
      'fetch',
      mockGraphFetch(
        {
          status: 'graph',
          queryKind: 'exact',
          query: 'F186',
          resolvedAnchor: 'F186',
          graph,
          note: 'no_edges',
        },
        graph,
      ),
    );
    await act(async () => {
      root.render(<CollectionGraph />);
    });
    const input = container.querySelector('[data-testid="graph-anchor-input"]') as HTMLInputElement;
    const btn = container.querySelector('[data-testid="graph-fetch-btn"]') as HTMLButtonElement;
    await act(async () => {
      input.value = 'F186';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      btn.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const stage = container.querySelector('[data-testid="graph-stage"]');
    const node = container.querySelector('[data-testid="graph-node-F186"]') as SVGGElement;
    const nodeTitle = container.querySelector('[data-testid="graph-node-title-F186"]');
    const detail = container.querySelector('[data-testid="graph-node-detail"]');

    expect(stage?.getAttribute('class')).toContain('grid');
    expect(node.textContent).toContain('F186');
    expect(nodeTitle?.textContent).toContain('图书馆记忆架构');
    expect(detail?.textContent).toContain('F186');
    expect(detail?.textContent).toContain('图书馆记忆架构');
    expect(detail?.textContent).toContain('feature');
  });

  it('keeps graph controls in a readable side panel instead of the canvas floor', async () => {
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

    const sidePanel = container.querySelector('[data-testid="graph-side-panel"]');
    const summary = container.querySelector('[data-testid="graph-summary"]');
    const legend = container.querySelector('[data-testid="graph-legend"]');
    const filters = container.querySelector('[data-testid="graph-edge-filter"]');

    expect(summary?.textContent).toContain('Nodes');
    expect(summary?.textContent).toContain('Edges');
    expect(legend?.closest('[data-testid="graph-side-panel"]')).toBe(sidePanel);
    expect(filters?.closest('[data-testid="graph-side-panel"]')).toBe(sidePanel);
  });

  it('does not expand canvas height for non-centered large graphs', async () => {
    const graph = {
      nodes: Array.from({ length: 74 }, (_, i) => ({
        anchor: `node-${i}`,
        collectionId: 'project:cafe',
        sensitivity: 'internal',
        kind: 'spec',
        title: `Node ${i}`,
        redacted: false,
      })),
      edges: [],
      depth: 1,
    };
    vi.stubGlobal(
      'fetch',
      mockGraphFetch({ status: 'graph', queryKind: 'exact', query: 'node-0', resolvedAnchor: 'node-0', graph }, graph),
    );
    await act(async () => {
      root.render(<CollectionGraph />);
    });
    const input = container.querySelector('[data-testid="graph-anchor-input"]') as HTMLInputElement;
    const btn = container.querySelector('[data-testid="graph-fetch-btn"]') as HTMLButtonElement;
    await act(async () => {
      input.value = 'node-0';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      btn.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(container.querySelector('[data-testid="graph-svg"]')?.getAttribute('viewBox')).toBe('0 0 940 620');
  });

  it('does not expand canvas height for centered sparse graphs', async () => {
    const graph = {
      nodes: Array.from({ length: 74 }, (_, i) => ({
        anchor: `node-${i}`,
        collectionId: 'project:cafe',
        sensitivity: 'internal',
        kind: 'spec',
        title: `Node ${i}`,
        redacted: false,
      })),
      edges: Array.from({ length: 73 }, (_, i) => ({
        from: `node-${i}`,
        to: `node-${i + 1}`,
        relation: 'related_to',
        crossCollection: false,
        edgeSensitivity: 'internal',
        provenance: 'frontmatter',
        redacted: false,
      })),
      center: 'node-0',
      depth: 1,
    };
    vi.stubGlobal(
      'fetch',
      mockGraphFetch({ status: 'graph', queryKind: 'exact', query: 'node-0', resolvedAnchor: 'node-0', graph }, graph),
    );
    await act(async () => {
      root.render(<CollectionGraph />);
    });
    const input = container.querySelector('[data-testid="graph-anchor-input"]') as HTMLInputElement;
    const btn = container.querySelector('[data-testid="graph-fetch-btn"]') as HTMLButtonElement;
    await act(async () => {
      input.value = 'node-0';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      btn.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(container.querySelector('[data-testid="graph-svg"]')?.getAttribute('viewBox')).toBe('0 0 940 620');
  });

  it('keeps the selected-node relation list in sync with edge filters', async () => {
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

    const detail = container.querySelector('[data-testid="graph-node-detail"]');
    expect(detail?.textContent).toContain('related to');
    expect(detail?.textContent).toContain('evolved from');

    const firstRelationToggle = container.querySelector(
      '[data-testid="graph-edge-filter"] input[type="checkbox"]',
    ) as HTMLInputElement;
    await act(async () => {
      firstRelationToggle.click();
    });

    expect(detail?.textContent).not.toContain('related to');
    expect(detail?.textContent).toContain('evolved from');
  });

  it('labels sparse graph edges with readable relation names', async () => {
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

    expect(container.querySelector('[data-testid="graph-edge-label-a1-a2-related_to"]')?.textContent).toContain(
      'related to',
    );
    expect(container.querySelector('[data-testid="graph-edge-label-a1-a3-evolved_from"]')?.textContent).toContain(
      'evolved from',
    );
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
    expect(tooltip?.className).not.toContain('right-[340px]');
    expect(tooltip?.className).toContain('inset-x-4');
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
