import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CatOverviewTab, type ConfigData } from '@/components/config-viewer-tabs';
import type { CatData } from '@/hooks/useCatData';

const CONFIG: ConfigData & {
  coCreator: {
    name: string;
    aliases: string[];
    mentionPatterns: string[];
  };
} = {
  coCreator: {
    name: 'Co-worker',
    aliases: ['共创伙伴'],
    mentionPatterns: ['@co-worker', '@owner'],
    avatar: '/avatars/owner-custom.png',
    color: { primary: '#E29578', secondary: '#FFE4D6' },
  },
  cats: {
    opus: { displayName: '布偶猫', clientId: 'anthropic', model: 'claude-opus-4-5-20250214', mcpSupport: true },
    codex: { displayName: '缅因猫', clientId: 'openai', model: 'codex-2025-03', mcpSupport: false },
    antigravity: { displayName: '孟加拉猫', clientId: 'antigravity', model: 'gemini-bridge', mcpSupport: true },
  },
  perCatBudgets: {
    opus: { maxPromptTokens: 150000, maxContextTokens: 200000, maxMessages: 50, maxContentLengthPerMsg: 64000 },
    codex: { maxPromptTokens: 100000, maxContextTokens: 128000, maxMessages: 30, maxContentLengthPerMsg: 32000 },
  },
  a2a: { enabled: true, maxDepth: 2 },
  memory: { enabled: true, maxKeysPerThread: 50 },
  codexExecution: { model: 'codex-mini-latest', authMode: 'oauth' as const, passModelArg: true },
  governance: { degradationEnabled: true, doneTimeoutMs: 300000, heartbeatIntervalMs: 30000 },
  ui: { bubbleDefaults: { thinking: 'collapsed' as const, cliOutput: 'expanded' as const } },
};

const CATS: CatData[] = [
  {
    id: 'opus',
    displayName: '布偶猫 Opus',
    breedDisplayName: '布偶猫',
    nickname: '宪宪',
    clientId: 'anthropic',
    accountRef: 'claude',
    defaultModel: 'claude-opus-4-5',
    color: { primary: '#6366f1', secondary: '#818cf8' },
    mentionPatterns: ['@opus', '@布偶猫'],
    avatar: '',
    roleDescription: '核心架构师',
    personality: '',
    roster: {
      family: 'ragdoll',
      roles: ['architect', 'peer-reviewer'],
      lead: true,
      available: true,
      evaluation: '主架构师',
    },
  },
  {
    id: 'codex',
    displayName: '缅因猫 Codex',
    breedDisplayName: '缅因猫',
    nickname: '砚砚',
    clientId: 'openai',
    accountRef: 'sponsor1',
    defaultModel: 'codex',
    color: { primary: '#22c55e', secondary: '#4ade80' },
    mentionPatterns: ['@codex', '@缅因猫'],
    avatar: '',
    roleDescription: '代码审查与安全',
    personality: '',
    roster: {
      family: 'maine-coon',
      roles: ['peer-reviewer', 'security'],
      lead: true,
      available: true,
      evaluation: '代码审查专家',
    },
  },
  {
    id: 'antigravity',
    displayName: '孟加拉猫 Antigravity',
    breedDisplayName: '孟加拉猫',
    nickname: '阿吉',
    clientId: 'antigravity',
    defaultModel: 'gemini-bridge',
    commandArgs: ['npx', 'antigravity', '--bridge'],
    color: { primary: '#f59e0b', secondary: '#fcd34d' },
    mentionPatterns: ['@antigravity', '@孟加拉猫'],
    avatar: '',
    roleDescription: '浏览器自动化',
    personality: '',
    roster: {
      family: 'bengal',
      roles: ['creative', 'visual', 'browser-agent'],
      lead: true,
      available: false,
      evaluation: '浏览器自动化',
    },
  },
];

describe('CatOverviewTab', () => {
  it('renders member cards with name, role and model — no budget internals', () => {
    const html = renderToStaticMarkup(
      React.createElement(CatOverviewTab, {
        config: CONFIG,
        cats: CATS,
        onAddMember: () => {},
        onEditMember: () => {},
        onToggleAvailability: () => {},
      }),
    );
    expect(html).toContain('布偶猫 宪宪');
    expect(html).toContain('缅因猫 砚砚');
    expect(html).toContain('孟加拉猫 阿吉');
    expect(html).toContain('核心架构师');
    expect(html).toContain('添加成员');
    expect(html).toContain('gemini-bridge');
    expect(html).not.toContain('Prompt 上限');
    expect(html).not.toContain('150k tokens');
    expect(html).not.toContain('原生 (--mcp-config)');
    expect(html).not.toContain('HTTP 回调注入');
    expect(html).not.toContain('>编辑<');
    expect(html).not.toContain('编辑成员');
    expect(html).not.toContain('npx antigravity --bridge');
  });

  it('anchors the first-member guide target to the card section', () => {
    const html = renderToStaticMarkup(
      React.createElement(CatOverviewTab, {
        config: CONFIG,
        cats: CATS,
        onEditMember: () => {},
      }),
    );
    const root = document.createElement('div');
    root.innerHTML = html;

    const guideTarget = root.querySelector('[data-guide-id="cats.first-member"]');
    expect(guideTarget).toBeTruthy();
    expect(guideTarget?.tagName).toBe('SECTION');
    expect(guideTarget?.textContent).toContain('布偶猫 宪宪');
  });

  it('uses the shared settings resource-card contract for member rows and actions', () => {
    const html = renderToStaticMarkup(
      React.createElement(CatOverviewTab, {
        config: CONFIG,
        cats: CATS,
        onEditMember: () => {},
        onDeleteMember: () => {},
        onToggleAvailability: () => {},
      }),
    );
    const root = document.createElement('div');
    root.innerHTML = html;

    const firstCard = root.querySelector('[data-guide-id="cats.first-member"]');
    expect(firstCard?.className).toContain('settings-resource-card');
    expect(firstCard?.querySelector('button[aria-label="删除成员"]')?.className).toContain('settings-resource-action');
    expect(firstCard?.querySelector('button[aria-pressed]')?.className).toContain('settings-resource-toggle');
  });
});
