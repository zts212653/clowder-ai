import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GameLobby } from '../GameLobby';

Object.assign(globalThis as Record<string, unknown>, { React });

const mockCats: React.ComponentProps<typeof GameLobby>['cats'] = [
  {
    id: 'opus',
    displayName: '宪宪',
    color: { primary: '#8B5CF6', secondary: '#7C3AED' },
    avatar: '/avatars/opus.png',
    mentionPatterns: ['opus'],
    provider: 'anthropic',
    defaultModel: 'claude-opus-4-6',
    roleDescription: '架构',
    personality: '',
    source: 'seed',
  },
  {
    id: 'sonnet',
    displayName: 'Sonnet',
    color: { primary: '#6366F1', secondary: '#4F46E5' },
    avatar: '/avatars/sonnet.png',
    mentionPatterns: ['sonnet'],
    provider: 'anthropic',
    defaultModel: 'claude-sonnet',
    roleDescription: '快速',
    personality: '',
    source: 'seed',
  },
  {
    id: 'codex',
    displayName: '砚砚',
    color: { primary: '#10B981', secondary: '#059669' },
    avatar: '/avatars/codex.png',
    mentionPatterns: ['codex'],
    provider: 'openai',
    defaultModel: 'gpt-5.3-codex',
    roleDescription: 'review',
    personality: '',
    source: 'seed',
  },
];

function render(props: Partial<React.ComponentProps<typeof GameLobby>> = {}): string {
  const merged: React.ComponentProps<typeof GameLobby> = {
    mode: 'player',
    cats: mockCats,
    onConfirm: () => {},
    onCancel: () => {},
    ...props,
  };
  return renderToStaticMarkup(React.createElement(GameLobby, merged));
}

describe('GameLobby', () => {
  it('renders lobby with data-testid', () => {
    const html = render();
    expect(html).toContain('data-testid="game-lobby"');
  });

  it('shows player mode title for player mode', () => {
    const html = render({ mode: 'player' });
    expect(html).toContain('玩家模式');
  });

  it('shows god-view title for god-view mode', () => {
    const html = render({ mode: 'god-view' });
    expect(html).toContain('上帝视角');
  });

  it('renders board presets', () => {
    const html = render();
    expect(html).toContain('data-testid="preset-6"');
    expect(html).toContain('data-testid="preset-7"');
    expect(html).toContain('data-testid="preset-9"');
    expect(html).toContain('data-testid="preset-12"');
    expect(html).toContain('6人局');
    expect(html).toContain('12人局');
  });

  it('renders cat toggles', () => {
    const html = render();
    expect(html).toContain('data-testid="cat-toggle-opus"');
    expect(html).toContain('data-testid="cat-toggle-sonnet"');
    expect(html).toContain('data-testid="cat-toggle-codex"');
    expect(html).toContain('宪宪');
  });

  it('renders confirm and cancel buttons', () => {
    const html = render();
    expect(html).toContain('data-testid="lobby-confirm"');
    expect(html).toContain('开始游戏');
    expect(html).toContain('取消');
  });

  it('renders voice mode checkbox', () => {
    const html = render();
    expect(html).toContain('语音模式');
  });

  it('shows seat count info', () => {
    const html = render();
    // Default 7-player, player mode = 6 cat seats needed
    expect(html).toContain('席位');
  });

  // Default selection is empty — button starts disabled until user picks cats
  it('starts with empty selection (click to add)', () => {
    const html = render({ cats: mockCats });
    // Confirm button should be disabled — no cats selected yet
    expect(html).toContain('disabled=""');
    expect(html).toContain('点击添加');
  });

  it('disables start when zero cats available', () => {
    // With no cats at all, can't start
    const html = render({ cats: [] });
    // Confirm button should be disabled
    expect(html).toContain('disabled=""');
  });
});
