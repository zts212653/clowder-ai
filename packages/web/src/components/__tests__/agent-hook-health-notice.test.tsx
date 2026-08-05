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
      targetPath: '/home/user/.claude/hooks/session-start-recall.sh',
      diff: { kind: 'text', message: 'target file is missing' },
    },
    {
      name: 'claude-settings',
      status: 'missing',
      drifted: true,
      reason: 'Claude settings is missing managed SessionStart/Stop hook entries',
      targetPath: '/home/user/.claude/settings.json',
      diff: { kind: 'json', message: 'managed SessionStart/Stop hook entries are missing', fields: ['hooks'] },
    },
    {
      name: 'codex-hooks',
      status: 'configured',
      drifted: false,
      reason: 'configured',
      targetPath: '/home/user/.codex/hooks.json',
    },
  ],
};

const partialSyncHealth: AgentHookStatusResponse = {
  status: 'stale',
  targets: [
    {
      name: 'hooks/session-start',
      status: 'configured',
      drifted: false,
      reason: 'configured',
      targetPath: '/home/user/.claude/hooks/session-start-recall.sh',
    },
    {
      name: 'skills',
      status: 'stale',
      drifted: true,
      reason: '1 stale, 196 conflicts',
      targetPath: '',
    },
    {
      name: 'mcp',
      status: 'stale',
      drifted: true,
      reason: '6 drift issues',
      targetPath: '',
    },
  ],
};

const uninitialisedHealth: AgentHookStatusResponse = {
  status: 'unsupported',
  targets: [],
  uninitialised: true,
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

    expect(html).toContain('Agent 运行环境需要同步');
    expect(html).toContain('Claude');
    expect(html).toContain('Codex');
    expect(html).toContain('Skills');
    expect(html).toContain('MCP');
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

    expect(html).toContain('Agent 运行环境检测失败');
    expect(html).toContain('Claude：未知');
    expect(html).toContain('Codex：未知');
    expect(html).toContain('Skills：未知');
    expect(html).toContain('MCP：未知');
    expect(html).not.toContain('Claude：正常');
    expect(html).not.toContain('Codex：正常');
    expect(html).toContain('border-conn-red-ring');
    expect(html).toContain('一键同步');
  });

  it('renders standalone uninitialised projects as neutral guidance without diagnostic controls', () => {
    const html = renderToStaticMarkup(<AgentHookHealthNotice health={uninitialisedHealth} onSync={() => {}} />);

    expect(html).toContain('该项目尚未初始化');
    expect(html).toContain('这个项目还没完成 Clowder AI 初始化，因此暂不检查或同步运行环境配置。');
    expect(html).toContain('border-conn-slate-ring');
    expect(html).not.toContain('Agent 运行环境检测失败');
    expect(html).not.toContain('一键同步');
    expect(html).not.toContain('Claude：未知');
    expect(html).not.toContain('预览将修复的改动');
  });

  it('uses setup-card guidance for uninitialised projects in the initialization context', () => {
    const html = renderToStaticMarkup(
      <AgentHookHealthNotice health={uninitialisedHealth} placement="project-setup" onSync={() => {}} />,
    );

    expect(html).toContain('先选择下方方式完成项目初始化；完成后再检查 Hook、Skills 和 MCP 配置。');
    expect(html).not.toContain('这个项目还没完成 Clowder AI 初始化');
  });

  it('shows visible feedback when sync ran but capability drift remains', () => {
    const html = renderToStaticMarkup(
      <AgentHookHealthNotice health={partialSyncHealth} syncAttempted onSync={() => {}} />,
    );

    expect(html).toContain('Agent 运行环境部分同步');
    expect(html).toContain('同步已执行');
    expect(html).toContain('Skills：1 stale, 196 conflicts');
    expect(html).toContain('MCP：6 drift issues');
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
    expect(html).toContain('Agent 运行环境需要同步');
    expect(html).toContain('初始化全新项目');
  });

  it('uses the setup-context copy for an uninitialised project', () => {
    const html = renderToStaticMarkup(
      <ProjectSetupCard
        projectPath="/tmp/api"
        isEmptyDir={false}
        isGitRepo={false}
        gitAvailable
        onComplete={() => {}}
        agentHookHealth={uninitialisedHealth}
        onSyncAgentHooks={() => {}}
      />,
    );

    expect(html).toContain('先选择下方方式完成项目初始化；完成后再检查 Hook、Skills 和 MCP 配置。');
    expect(html).not.toContain('这个项目还没完成 Clowder AI 初始化');
  });
});
