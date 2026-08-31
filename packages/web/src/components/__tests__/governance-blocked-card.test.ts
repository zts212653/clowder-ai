import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const { GovernanceBlockedCard } = await import('@/components/GovernanceBlockedCard');

describe('GovernanceBlockedCard', () => {
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

  it('keeps the historical notice but never offers direct InvocationRecord replay', () => {
    act(() => {
      root.render(
        React.createElement(GovernanceBlockedCard, {
          projectPath: '/home/user/workspace/my-project',
          reasonKind: 'needs_bootstrap',
        }),
      );
    });

    expect(container.querySelector('[data-testid="governance-blocked-card"]')).toBeTruthy();
    expect(container.textContent).toContain('my-project');
    expect(container.textContent).toContain('历史治理阻塞已解除');
    expect(container.textContent).toContain('请重新发送原消息');
    expect(container.textContent).not.toContain('直接重试派遣');
    expect(container.querySelector('[data-testid="governance-installer"]')).toBeTruthy();
  });

  it('extracts a Windows directory name without exposing the full path', () => {
    act(() => {
      root.render(
        React.createElement(GovernanceBlockedCard, {
          projectPath: 'C:\\workspace\\tmp',
          reasonKind: 'files_missing',
        }),
      );
    });

    expect(container.textContent).toContain('tmp');
    expect(container.textContent).not.toContain('C:\\workspace\\tmp');
  });
});
