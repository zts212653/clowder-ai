import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CatOverviewTab, type ConfigData, SystemTab } from '@/components/config-viewer-tabs';
import type { CatData } from '@/hooks/useCatData';

const CONFIG: ConfigData = {
  cats: {
    opus: { displayName: '布偶猫', provider: 'anthropic', model: 'claude-opus-4-5-20250214', mcpSupport: true },
    codex: { displayName: '缅因猫', provider: 'openai', model: 'codex-2025-03', mcpSupport: false },
  },
  perCatBudgets: {
    opus: { maxPromptTokens: 150000, maxContextTokens: 200000, maxMessages: 50, maxContentLengthPerMsg: 64000 },
    codex: { maxPromptTokens: 100000, maxContextTokens: 128000, maxMessages: 30, maxContentLengthPerMsg: 32000 },
  },
  a2a: { enabled: true, maxDepth: 2 },
  memory: { enabled: true, maxKeysPerThread: 50 },
  governance: { degradationEnabled: true, doneTimeoutMs: 300000, heartbeatIntervalMs: 30000 },
};

const CATS: CatData[] = [
  {
    id: 'opus',
    displayName: '布偶猫 Opus',
    breedDisplayName: '布偶猫',
    provider: 'anthropic',
    defaultModel: 'claude-opus-4-5',
    color: { primary: '#6366f1', secondary: '#818cf8' },
    mentionPatterns: [],
    avatar: '',
    roleDescription: '',
    personality: '',
  },
  {
    id: 'codex',
    displayName: '缅因猫 Codex',
    breedDisplayName: '缅因猫',
    provider: 'openai',
    defaultModel: 'codex',
    color: { primary: '#22c55e', secondary: '#4ade80' },
    mentionPatterns: [],
    avatar: '',
    roleDescription: '',
    personality: '',
  },
];

describe('CatOverviewTab', () => {
  it('renders all cats model info and budgets in one view', () => {
    const html = renderToStaticMarkup(React.createElement(CatOverviewTab, { config: CONFIG, cats: CATS }));
    expect(html).toContain('布偶猫');
    expect(html).toContain('anthropic');
    expect(html).toContain('claude-opus');
    expect(html).toContain('150k tokens');
    expect(html).toContain('原生 (--mcp-config)');
    expect(html).toContain('缅因猫');
    expect(html).toContain('openai');
    expect(html).toContain('HTTP 回调注入');
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

  it('renders governance config', () => {
    const html = renderToStaticMarkup(React.createElement(SystemTab, { config: CONFIG }));
    expect(html).toContain('治理');
    expect(html).toContain('300s');
    expect(html).toContain('30s');
  });

  it('renders codex execution config', () => {
    const nextConfig = {
      ...CONFIG,
      codexExecution: {
        model: 'gpt-5.3-codex',
        authMode: 'oauth',
        passModelArg: true,
      },
    } as unknown as ConfigData;

    const html = renderToStaticMarkup(React.createElement(SystemTab, { config: nextConfig }));
    expect(html).toContain('gpt-5.3-codex');
    expect(html).toContain('oauth');
  });
});
