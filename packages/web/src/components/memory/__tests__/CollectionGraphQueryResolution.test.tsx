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
  ],
  edges: [],
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

describe('CollectionGraph query resolution', () => {
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

  it('submits graph input through query resolution instead of blind anchor lookup', async () => {
    await act(async () => {
      root.render(<CollectionGraph />);
    });
    const input = container.querySelector('[data-testid="graph-anchor-input"]') as HTMLInputElement;
    const btn = container.querySelector('[data-testid="graph-fetch-btn"]') as HTMLButtonElement;
    await act(async () => {
      input.value = 'harness';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      btn.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(fetch).toHaveBeenCalledWith('/api/library/graph/resolve?query=harness&depth=1');
    expect(input.placeholder).toContain('F186');
    expect(input.placeholder).toContain('harness');
  });

  it('renders candidate list for natural-language graph queries', async () => {
    vi.stubGlobal(
      'fetch',
      mockGraphFetch({
        status: 'candidates',
        queryKind: 'search',
        query: 'harness',
        candidates: [
          {
            anchor: 'F301',
            title: 'Agent Harness Design',
            kind: 'discussion',
            collectionId: 'project:cat-cafe',
            source: 'docs/discussions/harness.md',
            matchReason: 'title',
            snippet: 'Agent Harness Design',
            edgeCount: 4,
          },
        ],
      }),
    );
    await act(async () => {
      root.render(<CollectionGraph />);
    });
    const input = container.querySelector('[data-testid="graph-anchor-input"]') as HTMLInputElement;
    const btn = container.querySelector('[data-testid="graph-fetch-btn"]') as HTMLButtonElement;
    await act(async () => {
      input.value = 'harness';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      btn.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const candidates = container.querySelector('[data-testid="graph-candidates"]');
    expect(candidates?.textContent).toContain('F301');
    expect(candidates?.textContent).toContain('Agent Harness Design');
    expect(candidates?.textContent).toContain('discussion');
    expect(candidates?.textContent).toContain('project:cat-cafe');
    expect(candidates?.textContent).toContain('title');
    expect(candidates?.textContent).toContain('4 relations');
    expect(container.querySelector('[data-testid="graph-svg"]')).toBeNull();
  });

  it('draws graph only after a user selects a candidate', async () => {
    vi.stubGlobal(
      'fetch',
      mockGraphFetch(
        {
          status: 'candidates',
          queryKind: 'search',
          query: 'harness',
          candidates: [
            {
              anchor: 'F301',
              title: 'Agent Harness Design',
              kind: 'discussion',
              collectionId: 'project:cat-cafe',
              matchReason: 'title',
              snippet: 'Agent Harness Design',
            },
          ],
        },
        GRAPH_RESPONSE,
      ),
    );
    await act(async () => {
      root.render(<CollectionGraph />);
    });
    const input = container.querySelector('[data-testid="graph-anchor-input"]') as HTMLInputElement;
    const btn = container.querySelector('[data-testid="graph-fetch-btn"]') as HTMLButtonElement;
    await act(async () => {
      input.value = 'harness';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      btn.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const candidateButton = container.querySelector('[data-testid="graph-candidate-F301"]') as HTMLButtonElement;
    await act(async () => {
      candidateButton.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(fetch).toHaveBeenLastCalledWith('/api/library/graph?anchor=F301&depth=1&collection=project%3Acat-cafe');
    expect(container.querySelector('[data-testid="graph-svg"]')).toBeTruthy();
  });

  it('preserves the selected candidate collection when drawing a graph', async () => {
    vi.stubGlobal(
      'fetch',
      mockGraphFetch(
        {
          status: 'candidates',
          queryKind: 'search',
          query: 'harness',
          candidates: [
            {
              anchor: 'F301',
              title: 'Project Harness',
              kind: 'discussion',
              collectionId: 'project:cat-cafe',
              matchReason: 'title',
            },
            {
              anchor: 'F301',
              title: 'Private Harness',
              kind: 'discussion',
              collectionId: 'private:lab',
              matchReason: 'title',
            },
          ],
        },
        GRAPH_RESPONSE,
      ),
    );
    await act(async () => {
      root.render(<CollectionGraph />);
    });
    const input = container.querySelector('[data-testid="graph-anchor-input"]') as HTMLInputElement;
    const btn = container.querySelector('[data-testid="graph-fetch-btn"]') as HTMLButtonElement;
    await act(async () => {
      input.value = 'harness';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      btn.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const candidateButtons = container.querySelectorAll('[data-testid="graph-candidate-F301"]');
    await act(async () => {
      (candidateButtons[1] as HTMLButtonElement).click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(fetch).toHaveBeenLastCalledWith('/api/library/graph?anchor=F301&depth=1&collection=private%3Alab');
  });

  it('preserves the selected candidate collection during node drill-down', async () => {
    const selectedGraph = {
      nodes: [
        {
          anchor: 'F301',
          collectionId: 'private:lab',
          sensitivity: 'internal',
          kind: 'discussion',
          title: 'Private Harness',
          redacted: false,
        },
      ],
      edges: [],
      center: 'F301',
      depth: 1,
    };
    vi.stubGlobal(
      'fetch',
      mockGraphFetch(
        {
          status: 'candidates',
          queryKind: 'search',
          query: 'harness',
          candidates: [
            {
              anchor: 'F301',
              title: 'Project Harness',
              kind: 'discussion',
              collectionId: 'project:cat-cafe',
              matchReason: 'title',
            },
            {
              anchor: 'F301',
              title: 'Private Harness',
              kind: 'discussion',
              collectionId: 'private:lab',
              matchReason: 'title',
            },
          ],
        },
        selectedGraph,
      ),
    );
    await act(async () => {
      root.render(<CollectionGraph />);
    });
    const input = container.querySelector('[data-testid="graph-anchor-input"]') as HTMLInputElement;
    const btn = container.querySelector('[data-testid="graph-fetch-btn"]') as HTMLButtonElement;
    await act(async () => {
      input.value = 'harness';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      btn.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const candidateButtons = container.querySelectorAll('[data-testid="graph-candidate-F301"]');
    await act(async () => {
      (candidateButtons[1] as HTMLButtonElement).click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    await act(async () => {
      const selectedNode = container.querySelector('[data-testid="graph-node-F301"]') as SVGGElement;
      selectedNode.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(fetch).toHaveBeenLastCalledWith('/api/library/graph?anchor=F301&depth=1&collection=private%3Alab');
  });

  it('renders helpful no-match copy and examples', async () => {
    vi.stubGlobal(
      'fetch',
      mockGraphFetch({
        status: 'no_match',
        queryKind: 'search',
        query: 'landy salary',
        message: 'No knowledge nodes matched this query.',
        examples: ['F186', 'harness'],
      }),
    );
    await act(async () => {
      root.render(<CollectionGraph />);
    });
    const input = container.querySelector('[data-testid="graph-anchor-input"]') as HTMLInputElement;
    const btn = container.querySelector('[data-testid="graph-fetch-btn"]') as HTMLButtonElement;
    await act(async () => {
      input.value = 'landy salary';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      btn.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const noMatch = container.querySelector('[data-testid="graph-no-match"]');
    expect(noMatch?.textContent).toContain('No knowledge nodes matched');
    expect(noMatch?.textContent).toContain('F186');
    expect(noMatch?.textContent).toContain('harness');
  });

  it('explains exact nodes that exist but have no graph edges', async () => {
    const singleNodeGraph = {
      nodes: [
        {
          anchor: 'F999',
          collectionId: 'project:cafe',
          sensitivity: 'internal',
          kind: 'feature',
          title: 'Lonely Feature',
          redacted: false,
        },
      ],
      edges: [],
      center: 'F999',
      depth: 1,
    };
    vi.stubGlobal(
      'fetch',
      mockGraphFetch(
        {
          status: 'graph',
          queryKind: 'exact',
          query: 'F999',
          resolvedAnchor: 'F999',
          graph: singleNodeGraph,
          note: 'no_edges',
        },
        singleNodeGraph,
      ),
    );
    await act(async () => {
      root.render(<CollectionGraph />);
    });
    const input = container.querySelector('[data-testid="graph-anchor-input"]') as HTMLInputElement;
    const btn = container.querySelector('[data-testid="graph-fetch-btn"]') as HTMLButtonElement;
    await act(async () => {
      input.value = 'F999';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      btn.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(container.querySelector('[data-testid="graph-svg"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="graph-no-edges-note"]')?.textContent).toContain('暂无关联边');
  });
});
