import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CatOverviewTab, type ConfigData, SystemTab } from '@/components/config-viewer-tabs';
import type { CatData } from '@/hooks/useCatData';

const CONFIG: ConfigData & {
  owner: {
    name: string;
    aliases: string[];
    mentionPatterns: string[];
  };
} = {
  owner: {
    name: 'Co-worker',
    aliases: ['共创伙伴'],
    mentionPatterns: ['@co-worker', '@owner'],
  },
  cats: {
    opus: { displayName: '布偶猫', provider: 'anthropic', model: 'claude-opus-4-5-20250214', mcpSupport: true },
    codex: { displayName: '缅因猫', provider: 'openai', model: 'codex-2025-03', mcpSupport: false },
    antigravity: { displayName: '孟加拉猫', provider: 'antigravity', model: 'gemini-bridge', mcpSupport: false },
  },
  perCatBudgets: {
    opus: { maxPromptTokens: 150000, maxContextTokens: 200000, maxMessages: 50, maxContentLengthPerMsg: 64000 },
    codex: { maxPromptTokens: 100000, maxContextTokens: 128000, maxMessages: 30, maxContentLengthPerMsg: 32000 },
  },
  a2a: { enabled: true, maxDepth: 2 },
  memory: { enabled: true, maxKeysPerThread: 50 },
  hindsight: { enabled: true, baseUrl: 'http://localhost:8888', sharedBank: 'cat-cafe-shared' },
  governance: { degradationEnabled: true, doneTimeoutMs: 300000, heartbeatIntervalMs: 30000 },
};

const CATS: CatData[] = [
  {
    id: 'opus',
    displayName: '布偶猫 Opus',
    breedDisplayName: '布偶猫',
    nickname: '宪宪',
    provider: 'anthropic',
    providerProfileId: 'Claude (OAuth)',
    defaultModel: 'claude-opus-4-5',
    color: { primary: '#6366f1', secondary: '#818cf8' },
    mentionPatterns: ['@opus', '@布偶猫'],
    avatar: '',
    roleDescription: '',
    personality: '',
    source: 'seed',
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
    provider: 'openai',
    providerProfileId: 'Name1 (API Key)',
    defaultModel: 'codex',
    color: { primary: '#22c55e', secondary: '#4ade80' },
    mentionPatterns: ['@codex', '@缅因猫'],
    avatar: '',
    roleDescription: '',
    personality: '',
    source: 'seed',
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
    provider: 'antigravity',
    defaultModel: 'gemini-bridge',
    commandArgs: ['npx', 'antigravity', '--bridge'],
    color: { primary: '#f59e0b', secondary: '#fcd34d' },
    mentionPatterns: ['@antigravity', '@孟加拉猫'],
    avatar: '',
    roleDescription: '',
    personality: '',
    source: 'runtime',
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
  it('renders the screen-2 overview as owner-first summary cards without budget internals', () => {
    const html = renderToStaticMarkup(
      React.createElement(CatOverviewTab, {
        config: CONFIG,
        cats: CATS,
        onAddMember: () => {},
        onEditMember: () => {},
      }),
    );
    expect(html).toContain('Co-worker');
    expect(html).toContain('🔒 Owner');
    expect(html).toContain('#D4A76A');
    expect(html.indexOf('Co-worker')).toBeLessThan(html.indexOf('布偶猫 · 宪宪'));
    expect(html).toContain('全部');
    expect(html).toContain('订阅');
    expect(html).toContain('API Key');
    expect(html).toContain('未启用');
    expect(html.indexOf('+ 添加成员')).toBeLessThan(html.indexOf('布偶猫 · 宪宪'));
    expect(html).toContain('布偶猫 · 宪宪');
    expect(html).toContain('缅因猫 · 砚砚');
    expect(html).toContain('孟加拉猫 · 阿吉');
    expect(html).toContain('Anthropic · claude-opus-4-5-20250214 · OAuth 订阅');
    expect(html).toContain('OpenAI · codex-2025-03 · Name1 (API Key)');
    expect(html).toContain('已启用');
    expect(html).toContain('@布偶猫');
    expect(html).toContain('npx antigravity --bridge');
    expect(html).toContain('gemini-bridge');
    expect(html).toContain('编辑成员');
    expect(html).toContain('添加成员');
    expect(html).not.toContain('Locked');
    expect(html).not.toContain('border-dashed');
    expect(html).not.toContain('md:grid-cols-2');
    expect(html).not.toContain('Client');
    expect(html).not.toContain('Account');
    expect(html).not.toContain('Model');
    expect(html).not.toContain('Prompt 上限');
    expect(html).not.toContain('150k tokens');
    expect(html).not.toContain('原生 (--mcp-config)');
    expect(html).not.toContain('HTTP 回调注入');
  });
});

describe('SystemTab', () => {
  it('renders A2A config', () => {
    const html = renderToStaticMarkup(React.createElement(SystemTab, { config: CONFIG }));
    expect(html).toContain('A2A');
    expect(html).toContain('2');
  });

  it('renders memory config', () => {
    const html = renderToStaticMarkup(React.createElement(SystemTab, { config: CONFIG }));
    expect(html).toContain('记忆');
    expect(html).toContain('50');
  });

  it('renders Hindsight config', () => {
    const html = renderToStaticMarkup(React.createElement(SystemTab, { config: CONFIG }));
    expect(html).toContain('Hindsight');
    expect(html).toContain('localhost:8888');
    expect(html).toContain('cat-cafe-shared');
  });

  it('renders governance config', () => {
    const html = renderToStaticMarkup(React.createElement(SystemTab, { config: CONFIG }));
    expect(html).toContain('治理');
    expect(html).toContain('300s');
    expect(html).toContain('30s');
  });

  it('renders codex-first memory engine routing and runtime controls', () => {
    const nextConfig = {
      ...CONFIG,
      hindsight: {
        ...CONFIG.hindsight,
        engine: {
          reflect: 'codex_oauth',
          retainExtraction: 'codex_oauth',
          allowNativeFallback: false,
        },
        service: {
          mode: 'storage_retrieval_only',
          requireHealthcheck: true,
          writeTimeoutMs: 8000,
          recallTimeoutMs: 8000,
        },
      },
      codexExecution: {
        model: 'gpt-5.3-codex',
        authMode: 'oauth',
        passModelArg: true,
      },
    } as unknown as ConfigData;

    const html = renderToStaticMarkup(React.createElement(SystemTab, { config: nextConfig }));
    expect(html).toContain('引擎路由');
    expect(html).toContain('codex_oauth');
    expect(html).toContain('allowNativeFallback');
    expect(html).toContain('storage_retrieval_only');
    expect(html).toContain('gpt-5.3-codex');
    expect(html).toContain('oauth');
  });
});
