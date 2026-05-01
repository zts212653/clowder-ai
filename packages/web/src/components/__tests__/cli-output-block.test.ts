/**
 * F097: CliOutputBlock — collapsed/expanded rendering, terminal substrate, visibility chip
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliEvent } from '@/stores/chat-types';

// Stub MarkdownContent (heavy dep)
vi.mock('@/components/MarkdownContent', () => ({
  MarkdownContent: ({ content }: { content: string }) => React.createElement('div', { 'data-testid': 'md' }, content),
}));

const { CliOutputBlock } = await import('../cli-output/CliOutputBlock');

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

const doneEvents: CliEvent[] = [
  { id: 't1', kind: 'tool_use', timestamp: 1000, label: 'Read index.ts' },
  { id: 't2', kind: 'tool_result', timestamp: 1001, label: 'Read index.ts', detail: '200 lines' },
  { id: 't3', kind: 'text', timestamp: 1002, content: 'Looks good.' },
];

describe('CliOutputBlock', () => {
  it('renders summary line with tool count when collapsed (default)', () => {
    act(() => {
      root.render(
        React.createElement(CliOutputBlock, {
          events: doneEvents,
          status: 'done',
        }),
      );
    });
    const text = container.textContent ?? '';
    expect(text).toContain('CLI Output');
    expect(text).toContain('done');
    // 1 tool_use event → "1 tools"
    expect(text).toMatch(/1 tool/);
  });

  it('shows expanded content when defaultExpanded=true', () => {
    act(() => {
      root.render(
        React.createElement(CliOutputBlock, {
          events: doneEvents,
          status: 'done',
          defaultExpanded: true,
        }),
      );
    });
    // CLI block expanded, stdout visible; tools collapsed by default when done
    expect(container.textContent).toContain('Looks good.');
    expect(container.textContent).toContain('1 tool');
    // Expand tools section to see tool labels
    const toolsToggle = container.querySelector('[data-testid="tools-section-toggle"]') as HTMLElement | null;
    act(() => {
      toolsToggle?.click();
    });
    expect(container.textContent).toContain('Read index.ts');
  });

  it('streaming status → initially expanded, summary says streaming', () => {
    act(() => {
      root.render(
        React.createElement(CliOutputBlock, {
          events: [{ id: 't1', kind: 'tool_use', timestamp: 1000, label: 'Bash pnpm test' }],
          status: 'streaming',
        }),
      );
    });
    const text = container.textContent ?? '';
    expect(text).toContain('streaming');
    expect(text).toContain('Bash pnpm test');
  });

  it('user can manually collapse output during streaming', () => {
    act(() => {
      root.render(
        React.createElement(CliOutputBlock, {
          events: [{ id: 't1', kind: 'tool_use', timestamp: 1000, label: 'Bash pnpm test' }],
          status: 'streaming',
        }),
      );
    });
    // Initially expanded during streaming
    expect(container.querySelector('[data-testid="cli-output-body"]')).toBeTruthy();

    // User manually collapses
    const btn = container.querySelector('button');
    act(() => {
      btn?.click();
    });
    expect(container.querySelector('[data-testid="cli-output-body"]')).toBeFalsy();

    // Re-render (simulates new streaming event) — should stay collapsed
    act(() => {
      root.render(
        React.createElement(CliOutputBlock, {
          events: [
            { id: 't1', kind: 'tool_use', timestamp: 1000, label: 'Bash pnpm test' },
            { id: 't2', kind: 'tool_use', timestamp: 1001, label: 'Bash pnpm lint' },
          ],
          status: 'streaming',
        }),
      );
    });
    expect(container.querySelector('[data-testid="cli-output-body"]')).toBeFalsy();
  });

  it('user can manually collapse tools section during streaming', () => {
    act(() => {
      root.render(
        React.createElement(CliOutputBlock, {
          events: [{ id: 't1', kind: 'tool_use', timestamp: 1000, label: 'Bash pnpm test' }],
          status: 'streaming',
        }),
      );
    });
    // Tools section initially expanded during streaming
    const toolsToggle = container.querySelector('[data-testid="tools-section-toggle"]') as HTMLElement | null;
    expect(toolsToggle).toBeTruthy();
    expect(container.textContent).not.toContain('(collapsed)');

    // User collapses tools
    act(() => {
      toolsToggle?.click();
    });
    expect(container.textContent).toContain('(collapsed)');

    // Re-render with new streaming event — tools should stay collapsed
    act(() => {
      root.render(
        React.createElement(CliOutputBlock, {
          events: [
            { id: 't1', kind: 'tool_use', timestamp: 1000, label: 'Bash pnpm test' },
            { id: 't2', kind: 'tool_use', timestamp: 1001, label: 'Bash pnpm lint' },
          ],
          status: 'streaming',
        }),
      );
    });
    expect(container.textContent).toContain('(collapsed)');
  });

  it('resets output collapse when status restarts to streaming after done', () => {
    act(() => {
      root.render(
        React.createElement(CliOutputBlock, {
          events: [{ id: 't1', kind: 'tool_use', timestamp: 1000, label: 'Bash pnpm test' }],
          status: 'streaming',
        }),
      );
    });
    // User collapses during streaming
    const btn = container.querySelector('button');
    act(() => {
      btn?.click();
    });
    expect(container.querySelector('[data-testid="cli-output-body"]')).toBeFalsy();

    // Streaming ends → done
    act(() => {
      root.render(
        React.createElement(CliOutputBlock, {
          events: [{ id: 't1', kind: 'tool_use', timestamp: 1000, label: 'Bash pnpm test' }],
          status: 'done',
        }),
      );
    });

    // New streaming session starts → should re-expand (reset userInteracted)
    act(() => {
      root.render(
        React.createElement(CliOutputBlock, {
          events: [{ id: 't2', kind: 'tool_use', timestamp: 2000, label: 'Bash pnpm build' }],
          status: 'streaming',
        }),
      );
    });
    expect(container.querySelector('[data-testid="cli-output-body"]')).toBeTruthy();
  });

  it('resets tools collapse when status restarts to streaming after done', () => {
    act(() => {
      root.render(
        React.createElement(CliOutputBlock, {
          events: [{ id: 't1', kind: 'tool_use', timestamp: 1000, label: 'Bash pnpm test' }],
          status: 'streaming',
        }),
      );
    });
    // User collapses tools during streaming
    const toolsToggle = container.querySelector('[data-testid="tools-section-toggle"]') as HTMLElement | null;
    act(() => {
      toolsToggle?.click();
    });
    expect(container.textContent).toContain('(collapsed)');

    // Streaming ends → done
    act(() => {
      root.render(
        React.createElement(CliOutputBlock, {
          events: [{ id: 't1', kind: 'tool_use', timestamp: 1000, label: 'Bash pnpm test' }],
          status: 'done',
        }),
      );
    });

    // New streaming session → tools should re-expand
    act(() => {
      root.render(
        React.createElement(CliOutputBlock, {
          events: [{ id: 't2', kind: 'tool_use', timestamp: 2000, label: 'Bash pnpm build' }],
          status: 'streaming',
        }),
      );
    });
    expect(container.textContent).not.toContain('(collapsed)');
  });

  it('shows shared visibility chip when thinkingMode=debug', () => {
    act(() => {
      root.render(
        React.createElement(CliOutputBlock, {
          events: doneEvents,
          status: 'done',
          thinkingMode: 'debug',
        }),
      );
    });
    expect(container.textContent).toContain('shared');
  });

  it('shows private label when thinkingMode=play', () => {
    act(() => {
      root.render(
        React.createElement(CliOutputBlock, {
          events: doneEvents,
          status: 'done',
          thinkingMode: 'play',
        }),
      );
    });
    expect(container.textContent).toContain('private');
  });

  it('returns null when no events', () => {
    act(() => {
      root.render(
        React.createElement(
          'div',
          { id: 'wrapper' },
          React.createElement(CliOutputBlock, { events: [], status: 'done' }),
        ),
      );
    });
    const wrapper = container.querySelector('#wrapper');
    expect(wrapper?.children.length).toBe(0);
  });

  it('has dark terminal substrate class', () => {
    act(() => {
      root.render(
        React.createElement(CliOutputBlock, {
          events: doneEvents,
          status: 'done',
          defaultExpanded: true,
        }),
      );
    });
    // Look for the dark bg container
    const darkEl = container.querySelector('[data-testid="cli-output-body"]');
    expect(darkEl).toBeTruthy();
  });

  it('clicking summary toggles expansion', () => {
    act(() => {
      root.render(
        React.createElement(CliOutputBlock, {
          events: doneEvents,
          status: 'done',
        }),
      );
    });
    // Initially collapsed — no tool details
    expect(container.textContent).not.toContain('Looks good.');

    // Click to expand
    const button = container.querySelector('button');
    expect(button).toBeTruthy();
    act(() => {
      button?.click();
    });
    expect(container.textContent).toContain('Looks good.');

    // Click to collapse
    act(() => {
      button?.click();
    });
    expect(container.textContent).not.toContain('Looks good.');
  });

  it('shows failed status text', () => {
    act(() => {
      root.render(
        React.createElement(CliOutputBlock, {
          events: [{ id: 't1', kind: 'tool_use', timestamp: 1000, label: 'Bash deploy' }],
          status: 'failed',
        }),
      );
    });
    expect(container.textContent).toContain('failed');
  });

  // ── P1-1: per-tool collapse (AC-A2) ──
  it('tool rows are individually collapsible — click to show detail', () => {
    act(() => {
      root.render(
        React.createElement(CliOutputBlock, {
          events: [
            { id: 't1', kind: 'tool_use', timestamp: 1000, label: 'Read index.ts' },
            { id: 'r1', kind: 'tool_result', timestamp: 1001, label: 'Read index.ts', detail: '200 lines read' },
          ],
          status: 'done',
          defaultExpanded: true,
        }),
      );
    });
    // Tools section collapsed by default when done — expand it first
    const toolsToggle = container.querySelector('[data-testid="tools-section-toggle"]') as HTMLElement | null;
    act(() => {
      toolsToggle?.click();
    });
    // Tool label visible, but detail hidden by default (collapsed row)
    expect(container.textContent).toContain('Read index.ts');
    expect(container.textContent).not.toContain('200 lines read');

    // Click the tool row to expand it
    const toolRow = container.querySelector('[data-testid="tool-row-t1"]') as HTMLElement | null;
    expect(toolRow).toBeTruthy();
    act(() => {
      toolRow?.click();
    });
    expect(container.textContent).toContain('200 lines read');
  });

  // ── P1-2: auto-collapse on streaming→done (AC-A6) ──
  it('auto-collapses when status changes from streaming to done (no user interaction)', () => {
    // Start streaming → expanded
    act(() => {
      root.render(
        React.createElement(CliOutputBlock, {
          events: doneEvents,
          status: 'streaming',
        }),
      );
    });
    expect(container.querySelector('[data-testid="cli-output-body"]')).toBeTruthy();

    // Status changes to done → should auto-collapse
    act(() => {
      root.render(
        React.createElement(CliOutputBlock, {
          events: doneEvents,
          status: 'done',
        }),
      );
    });
    expect(container.querySelector('[data-testid="cli-output-body"]')).toBeFalsy();
  });

  it('does NOT auto-collapse if user manually expanded', () => {
    // Start collapsed (done)
    act(() => {
      root.render(
        React.createElement(CliOutputBlock, {
          events: doneEvents,
          status: 'done',
        }),
      );
    });
    // User clicks to expand
    const btn = container.querySelector('button');
    act(() => {
      btn?.click();
    });
    expect(container.querySelector('[data-testid="cli-output-body"]')).toBeTruthy();

    // Re-render with same status — should stay expanded (user interacted)
    act(() => {
      root.render(
        React.createElement(CliOutputBlock, {
          events: doneEvents,
          status: 'done',
        }),
      );
    });
    expect(container.querySelector('[data-testid="cli-output-body"]')).toBeTruthy();
  });

  // ── #349 regression: streaming→done should respect defaultExpanded ──
  it('does NOT auto-collapse on streaming→done when defaultExpanded=true', () => {
    // Start streaming with defaultExpanded=true → expanded
    act(() => {
      root.render(
        React.createElement(CliOutputBlock, {
          events: doneEvents,
          status: 'streaming',
          defaultExpanded: true,
        }),
      );
    });
    expect(container.querySelector('[data-testid="cli-output-body"]')).toBeTruthy();

    // Status changes to done → should stay expanded because default is expanded
    act(() => {
      root.render(
        React.createElement(CliOutputBlock, {
          events: doneEvents,
          status: 'done',
          defaultExpanded: true,
        }),
      );
    });
    expect(container.querySelector('[data-testid="cli-output-body"]')).toBeTruthy();
  });

  // ── #349 regression: async config load should sync defaultExpanded ──
  it('syncs expanded state when defaultExpanded prop changes from false to true', () => {
    // Initial render with defaultExpanded=false (simulates store initial value)
    act(() => {
      root.render(
        React.createElement(CliOutputBlock, {
          events: doneEvents,
          status: 'done',
          defaultExpanded: false,
        }),
      );
    });
    expect(container.querySelector('[data-testid="cli-output-body"]')).toBeFalsy();

    // Config loads async → defaultExpanded becomes true
    act(() => {
      root.render(
        React.createElement(CliOutputBlock, {
          events: doneEvents,
          status: 'done',
          defaultExpanded: true,
        }),
      );
    });
    expect(container.querySelector('[data-testid="cli-output-body"]')).toBeTruthy();
  });

  // ── P1-3: duplicate label matching ──
  it('correctly matches tool_result for duplicate tool labels', () => {
    const dupeEvents: CliEvent[] = [
      { id: 'u1', kind: 'tool_use', timestamp: 1000, label: 'Bash pnpm test' },
      { id: 'r1', kind: 'tool_result', timestamp: 1001, label: 'Bash pnpm test', detail: 'FAIL 3 tests' },
      { id: 'u2', kind: 'tool_use', timestamp: 1002, label: 'Bash pnpm test' },
      { id: 'r2', kind: 'tool_result', timestamp: 1003, label: 'Bash pnpm test', detail: 'PASS all' },
    ];
    act(() => {
      root.render(
        React.createElement(CliOutputBlock, {
          events: dupeEvents,
          status: 'done',
          defaultExpanded: true,
        }),
      );
    });
    // Expand tools section first (collapsed by default when done)
    const toolsToggle = container.querySelector('[data-testid="tools-section-toggle"]') as HTMLElement | null;
    act(() => {
      toolsToggle?.click();
    });
    // Expand both tool rows to see details
    const row1 = container.querySelector('[data-testid="tool-row-u1"]') as HTMLElement | null;
    const row2 = container.querySelector('[data-testid="tool-row-u2"]') as HTMLElement | null;
    act(() => {
      row1?.click();
      row2?.click();
    });
    const text = container.textContent ?? '';
    // First tool should show FAIL, second should show PASS
    expect(text).toContain('FAIL 3 tests');
    expect(text).toContain('PASS all');
  });

  // ── Cloud P1: tool-row click counts as user interaction ──
  it('does NOT auto-collapse if user expanded a tool row', () => {
    // Start streaming
    act(() => {
      root.render(
        React.createElement(CliOutputBlock, {
          events: [
            { id: 'u1', kind: 'tool_use', timestamp: 1000, label: 'Read' },
            { id: 'r1', kind: 'tool_result', timestamp: 1001, label: 'Read', detail: '200 lines' },
          ],
          status: 'streaming',
          defaultExpanded: true,
        }),
      );
    });
    // User clicks a tool row to expand detail
    const toolRow = container.querySelector('[data-testid="tool-row-u1"]') as HTMLElement | null;
    act(() => {
      toolRow?.click();
    });
    expect(container.textContent).toContain('200 lines');

    // Status changes to done → should NOT auto-collapse (user interacted via tool row)
    act(() => {
      root.render(
        React.createElement(CliOutputBlock, {
          events: [
            { id: 'u1', kind: 'tool_use', timestamp: 1000, label: 'Read' },
            { id: 'r1', kind: 'tool_result', timestamp: 1001, label: 'Read', detail: '200 lines' },
          ],
          status: 'done',
          defaultExpanded: true,
        }),
      );
    });
    expect(container.querySelector('[data-testid="cli-output-body"]')).toBeTruthy();
  });

  // ── P2-4: duration in summary ──
  it('shows duration in summary line', () => {
    const events: CliEvent[] = [
      { id: 't1', kind: 'tool_use', timestamp: 1000, label: 'Read' },
      { id: 'r1', kind: 'tool_result', timestamp: 1000 + 135_000, label: 'Read', detail: 'ok' },
    ];
    act(() => {
      root.render(
        React.createElement(CliOutputBlock, {
          events,
          status: 'done',
        }),
      );
    });
    // 135s = 2m15s
    expect(container.textContent).toContain('2m15s');
  });

  // ── P2-5: visibility chip always shown ──
  it('shows "private" when thinkingMode is undefined', () => {
    act(() => {
      root.render(
        React.createElement(CliOutputBlock, {
          events: doneEvents,
          status: 'done',
          // thinkingMode not provided
        }),
      );
    });
    expect(container.textContent).toContain('private');
  });
});
