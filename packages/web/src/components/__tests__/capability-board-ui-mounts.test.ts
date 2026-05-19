import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type CapabilityBoardItem, CapabilitySection } from '@/components/capability-board-ui';

describe('CapabilitySection cat-cafe skill mounts', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('shows Kimi alongside Claude-family mount badges for cat-cafe skills', () => {
    const item: CapabilityBoardItem = {
      id: 'cross-cat-handoff',
      type: 'skill',
      source: 'cat-cafe',
      enabled: true,
      cats: { codex: true },
      description: '协作技能',
      triggers: ['handoff'],
      mounts: { claude: true, codex: false, gemini: true, kimi: true },
    };

    act(() => {
      root.render(
        React.createElement(CapabilitySection, {
          icon: null,
          title: '协作',
          subtitle: 'Clowder AI Skills',
          items: [item],
          catFamilies: [],
          toggling: null,
          onToggle: () => {},
        }),
      );
    });

    const expandButton = container.querySelector('button');
    act(() => expandButton?.click());

    const text = container.textContent ?? '';
    expect(text).toContain('挂载状态:');
    expect(text).toContain('Claude');
    expect(text).toContain('Codex');
    expect(text).toContain('Gemini');
    expect(text).toContain('Kimi');
  });
});
