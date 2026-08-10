import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TurnAbsorptionDock } from '../TurnAbsorptionDock';
import type { TurnAbsorptionProjection } from '../turn-absorption-summary';

function projection(defaultExpanded: boolean): TurnAbsorptionProjection {
  return {
    invocationId: 'child-1',
    counts: {
      total: 2,
      handled: 1,
      responded: 1,
      completedWithTurn: 0,
      actionable: 1,
      withdrawnAfterExposureUnhandled: 0,
    },
    defaultExpanded,
    items: [
      {
        sourceMessageId: 'm-handled',
        sourceTimestamp: 1,
        content: '只在 terminal footer 显示的正文',
        kind: 'responded',
        catId: 'codex-sol',
        invocationId: 'child-1',
        seenAt: 10,
        recalled: false,
        bodyProjectedHere: true,
      },
      {
        sourceMessageId: 'm-actionable',
        sourceTimestamp: 2,
        content: '仍在原时间线显示的正文',
        kind: 'actionable',
        catId: 'codex-sol',
        invocationId: 'child-1',
        seenAt: 11,
        recalled: false,
        bodyProjectedHere: false,
      },
    ],
  };
}

describe('F264 AC-42/43 terminal absorption dock', () => {
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

  it('renders exact counts and projects only the body moved from its source anchor', () => {
    act(() => {
      root.render(<TurnAbsorptionDock projection={projection(true)} messages={[]} getCatLabel={() => '小太阳·砚砚'} />);
    });

    const details = container.querySelector('details');
    expect(details?.open).toBe(true);
    expect(container.textContent).toContain('本轮处理了 1/2 条补充');
    expect(container.textContent).toContain('1 条明确回应');
    expect(container.textContent).toContain('1 条仍待处理');
    expect(container.textContent).toContain('只在 terminal footer 显示的正文');
    expect(container.textContent).not.toContain('仍在原时间线显示的正文');
    expect(container.querySelector('[data-turn-absorption-kind="responded"]')).not.toBeNull();
    expect(container.querySelector('[data-turn-absorption-kind="actionable"]')).not.toBeNull();
  });

  it('stays collapsed by default when N is above the lightweight threshold', () => {
    act(() => {
      root.render(<TurnAbsorptionDock projection={projection(false)} messages={[]} getCatLabel={(catId) => catId} />);
    });
    expect(container.querySelector('details')?.open).toBe(false);
  });

  it('moves an image-only handled supplement into the terminal dock before folding its source', () => {
    const imageOnly = projection(true);
    imageOnly.items[0] = {
      ...imageOnly.items[0],
      content: '',
      contentBlocks: [{ type: 'image', url: '/uploads/absorbed-proof.png' }],
    };
    act(() => {
      root.render(<TurnAbsorptionDock projection={imageOnly} messages={[]} getCatLabel={(catId) => catId} />);
    });

    expect(container.querySelector('img[alt="attached image"]')?.getAttribute('src')).toContain(
      '/uploads/absorbed-proof.png',
    );
    expect(container.textContent).toContain('定位原消息 ↑');
  });
});
