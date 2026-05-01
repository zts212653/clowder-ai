import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentHookHealthNotice, type AgentHookStatusResponse } from '@/components/AgentHookHealthNotice';
import { ProjectSetupCard } from '@/components/ProjectSetupCard';

const missingHealth: AgentHookStatusResponse = {
  status: 'missing',
  targets: [
    {
      name: 'hooks/session-start',
      status: 'missing',
      drifted: true,
      reason: 'target file does not exist',
      targetPath: '/home/user/session-start-recall.sh',
      diff: { kind: 'text', message: 'target file is missing' },
    },
    {
      name: 'claude-settings',
      status: 'missing',
      drifted: true,
      reason: 'Claude settings is missing managed SessionStart/Stop hook entries',
      targetPath: '/home/user/settings.json',
      diff: { kind: 'json', message: 'managed SessionStart/Stop hook entries are missing', fields: ['hooks'] },
    },
    {
      name: 'codex-hooks',
      status: 'configured',
      drifted: false,
      reason: 'configured',
      targetPath: '/home/user/hooks.json',
    },
  ],
};

describe('AgentHookHealthNotice', () => {
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

  it('renders a repair affordance with Claude/Codex sub-status and preview summary', () => {
    const html = renderToStaticMarkup(<AgentHookHealthNotice health={missingHealth} onSync={() => {}} />);

    expect(html).toContain('Agent 运行 Hook 需要同步');
    expect(html).toContain('Claude');
    expect(html).toContain('Codex');
    expect(html).toContain('一键同步');
    expect(html).toContain('预览将修复的改动');
    expect(html).toContain('claude-settings');
  });

  it('calls onSync from the repair button', async () => {
    const onSync = vi.fn();

    await act(async () => {
      root.render(<AgentHookHealthNotice health={missingHealth} onSync={onSync} />);
    });

    const button = [...container.querySelectorAll('button')].find((node) => node.textContent?.includes('一键同步'));
    if (!button) throw new Error('Missing sync button');

    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onSync).toHaveBeenCalledTimes(1);
  });

  it('does not report configured sub-status when hook status is unknown after an error', () => {
    const html = renderToStaticMarkup(
      <AgentHookHealthNotice health={null} error="status request failed" onSync={() => {}} />,
    );

    expect(html).toContain('Agent 运行 Hook 检测失败');
    expect(html).toContain('Claude：未知');
    expect(html).toContain('Codex：未知');
    expect(html).not.toContain('Claude：正常');
    expect(html).not.toContain('Codex：正常');
  });
});

describe('ProjectSetupCard agent hook entry', () => {
  it('surfaces agent hook health inside the governance setup card', () => {
    const html = renderToStaticMarkup(
      <ProjectSetupCard
        projectPath="/tmp/api"
        isEmptyDir={false}
        isGitRepo={false}
        gitAvailable
        onComplete={() => {}}
        agentHookHealth={missingHealth}
        onSyncAgentHooks={() => {}}
      />,
    );

    expect(html).toContain('发现了一片新大陆');
    expect(html).toContain('Agent 运行 Hook 需要同步');
    expect(html).toContain('初始化全新项目');
  });
});
