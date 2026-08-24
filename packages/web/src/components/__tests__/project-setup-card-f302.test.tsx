import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectSetupCard } from '@/components/ProjectSetupCard';

vi.mock('next/image', () => ({ default: () => <span data-testid="next-image" /> }));

describe('ProjectSetupCard F302 copy', () => {
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

  it('presents Git setup as optional and does not promise hidden governance writes', () => {
    act(() =>
      root.render(
        <ProjectSetupCard
          projectPath="/tmp/community-plugin"
          isEmptyDir
          isGitRepo={false}
          gitAvailable
          onComplete={() => {}}
        />,
      ),
    );

    expect(container.textContent).toContain('猫猫已经可以工作');
    expect(container.textContent).toContain('Git 设置是可选的');
    expect(container.textContent).not.toContain('需要初始化后猫猫才能工作');
    expect(container.textContent).not.toContain('初始化将写入协作规则');
  });
});
