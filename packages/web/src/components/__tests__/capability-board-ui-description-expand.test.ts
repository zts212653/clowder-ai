import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type CapabilityBoardItem, CapabilitySection } from '@/components/capability-board-ui';

describe('CapabilitySection description expansion', () => {
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

  it('shows full description in expanded panel after card click', () => {
    const description = '这是一段很长的技能描述，用于验证展开后会展示完整文案而不是只显示截断摘要。';
    const item: CapabilityBoardItem = {
      id: 'cross-cat-handoff',
      type: 'skill',
      source: 'cat-cafe',
      enabled: true,
      cats: { codex: true },
      description,
      triggers: ['交接'],
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

    expect(container.textContent).not.toContain('描述:');
    const expandButton = container.querySelector('button');
    act(() => expandButton?.click());
    expect(container.textContent).toContain('描述:');
    expect(container.textContent).toContain(description);
  });
});
