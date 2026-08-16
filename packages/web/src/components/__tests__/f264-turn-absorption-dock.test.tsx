import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TurnAbsorptionDock } from '../TurnAbsorptionDock';
import type { TurnAbsorptionProjection } from '../turn-absorption-summary';

function projection(defaultExpanded: boolean): TurnAbsorptionProjection {
  return {
    invocationId: 'child-1',
    counts: {
      total: 2,
      handled: 1,
      responded: 0,
      completedWithTurn: 1,
      actionable: 1,
      withdrawnAfterExposureUnhandled: 0,
    },
    defaultExpanded,
    items: [
      {
        sourceMessageId: 'm-handled',
        sourceTimestamp: new Date(2026, 7, 11, 8, 4).getTime(),
        content: '只在 terminal footer 显示的正文',
        kind: 'completed_with_turn',
        handlerCatId: 'codex-sol',
        invocationId: 'child-1',
        seenAt: 10,
        outcomeAt: new Date(2026, 7, 11, 8, 16).getTime(),
        recalled: false,
        bodyProjectedHere: true,
      },
      {
        sourceMessageId: 'm-actionable',
        sourceTimestamp: new Date(2026, 7, 11, 8, 5).getTime(),
        content: '仍在原时间线显示的正文',
        kind: 'actionable',
        handlerCatId: 'codex-sol',
        invocationId: 'child-1',
        seenAt: 11,
        outcomeAt: new Date(2026, 7, 11, 8, 17).getTime(),
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
      root.render(
        <TurnAbsorptionDock
          projection={projection(true)}
          messages={[]}
          getCatLabel={() => '小太阳·砚砚'}
          sourceAuthorLabel="You"
        />,
      );
    });

    const details = container.querySelector('details');
    expect(details?.open).toBe(true);
    expect(container.textContent).toContain('本轮处理了 1/2 条补充');
    expect(container.textContent).toContain('1 条随本轮完成');
    expect(container.textContent).toContain('1 条仍待处理');
    expect(container.textContent).toContain('You');
    expect(container.textContent).toContain('08:04');
    expect(container.textContent).toContain('随本轮完成 · 08:16');
    expect(container.textContent).toContain('由 小太阳·砚砚处理');
    expect(container.textContent).toContain('只在 terminal footer 显示的正文');
    expect(container.textContent).not.toContain('仍在原时间线显示的正文');
    expect(container.querySelector('[data-turn-absorption-kind="completed_with_turn"]')).not.toBeNull();
    expect(container.querySelector('[data-turn-absorption-kind="actionable"]')).not.toBeNull();
  });

  it('labels cross-thread absorption as carrier consumption rather than work completion', () => {
    const crossThread = projection(true);
    Object.assign(crossThread.items[0]!, { receiptScope: 'cross_thread_delivery' });

    act(() => {
      root.render(
        <TurnAbsorptionDock
          projection={crossThread}
          messages={[]}
          getCatLabel={() => '小太阳·砚砚'}
          sourceAuthorLabel="You"
        />,
      );
    });

    expect(container.textContent).toContain('1 条跨线程正文已消费');
    expect(container.textContent).toContain('正文已由本轮消费 · 08:16');
    expect(container.textContent).toContain('由 小太阳·砚砚读取');
    expect(container.textContent).not.toContain('随本轮完成');
    expect(container.textContent).not.toContain('由 小太阳·砚砚处理');
  });

  it('stays collapsed by default when N is above the lightweight threshold', () => {
    act(() => {
      root.render(
        <TurnAbsorptionDock
          projection={projection(false)}
          messages={[]}
          getCatLabel={(catId) => catId}
          sourceAuthorLabel="You"
        />,
      );
    });
    expect(container.querySelector('details')?.open).toBe(false);
  });

  it('omits an unproven outcome clock instead of inventing a fallback time', () => {
    const missingOutcomeClock = projection(true);
    delete missingOutcomeClock.items[1]?.outcomeAt;
    act(() => {
      root.render(
        <TurnAbsorptionDock
          projection={missingOutcomeClock}
          messages={[]}
          getCatLabel={(catId) => catId}
          sourceAuthorLabel="You"
        />,
      );
    });

    expect(
      container.querySelector('[data-turn-absorption-source="m-actionable"] [data-turn-absorption-status]')
        ?.textContent,
    ).toBe('仍待处理');
  });

  it('moves an image-only handled supplement into the terminal dock before folding its source', () => {
    const imageOnly = projection(true);
    imageOnly.items[0] = {
      ...imageOnly.items[0],
      content: '',
      contentBlocks: [{ type: 'image', url: '/uploads/absorbed-proof.png' }],
    };
    act(() => {
      root.render(
        <TurnAbsorptionDock
          projection={imageOnly}
          messages={[]}
          getCatLabel={(catId) => catId}
          sourceAuthorLabel="You"
        />,
      );
    });

    expect(container.querySelector('img[alt="attached image"]')?.getAttribute('src')).toContain(
      '/uploads/absorbed-proof.png',
    );
    expect(container.textContent).toContain('定位原消息 ↑');
  });

  it('reveals the content-free source anchor only when locate-original lands on it', () => {
    const sourceAnchor = document.createElement('div');
    sourceAnchor.dataset.messageId = 'm-handled';
    sourceAnchor.dataset.foldedSourceAnchor = 'child-1';
    sourceAnchor.setAttribute('aria-hidden', 'true');
    sourceAnchor.className = 'h-0 overflow-hidden';
    sourceAnchor.scrollIntoView = vi.fn();
    const affordance = document.createElement('button');
    affordance.hidden = true;
    affordance.dataset.foldedSourceAffordance = '';
    sourceAnchor.appendChild(affordance);
    document.body.appendChild(sourceAnchor);

    act(() => {
      root.render(
        <TurnAbsorptionDock
          projection={projection(true)}
          messages={[]}
          getCatLabel={(catId) => catId}
          sourceAuthorLabel="You"
        />,
      );
    });
    const locateButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === '定位原消息 ↑',
    );
    act(() => locateButton?.click());

    expect(affordance.hidden).toBe(false);
    expect(sourceAnchor.getAttribute('aria-hidden')).toBe('false');
    expect(sourceAnchor.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
    sourceAnchor.remove();
  });
});
