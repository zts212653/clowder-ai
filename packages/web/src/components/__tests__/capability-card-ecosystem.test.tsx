import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CapabilitySection, SectionIconMcp } from '@/components/capability-board-ui';

describe('F146-D: CapabilityCard ecosystem badge', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    root.unmount();
    container.remove();
  });

  it('renders ecosystem badge when item has ecosystem', async () => {
    await act(async () => {
      root.render(
        <CapabilitySection
          icon={<SectionIconMcp />}
          title="MCP"
          subtitle="test"
          items={[
            {
              id: 'test-mcp',
              type: 'mcp',
              source: 'external',
              enabled: true,
              cats: {},
              ecosystem: 'claude',
            },
          ]}
          catFamilies={[]}
          toggling={null}
          onToggle={() => {}}
        />,
      );
    });

    const html = container.innerHTML;
    expect(html).toContain('Claude');
    expect(html).toContain('bg-purple-50');
  });

  it('does not render ecosystem badge when item has no ecosystem', async () => {
    await act(async () => {
      root.render(
        <CapabilitySection
          icon={<SectionIconMcp />}
          title="MCP"
          subtitle="test"
          items={[
            {
              id: 'test-mcp',
              type: 'mcp',
              source: 'external',
              enabled: true,
              cats: {},
            },
          ]}
          catFamilies={[]}
          toggling={null}
          onToggle={() => {}}
        />,
      );
    });

    const html = container.innerHTML;
    expect(html).not.toContain('bg-purple-50');
  });
});
