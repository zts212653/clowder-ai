import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { HubMemberOverviewCard } from '../HubMemberOverviewCard';

const cat: CatData = {
  id: 'test-codex',
  displayName: 'Test Codex',
  clientId: 'openai',
  defaultModel: 'test',
  color: { primary: '#5B8C5A', secondary: '#FFFFFF' },
  mentionPatterns: ['@test-codex'],
  avatar: '',
  roleDescription: '',
  personality: '',
  carrier: 'app_server',
};

describe('Hub member actions and effective transport', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it('toggle and delete call their own action without opening the row editor', () => {
    const onEdit = vi.fn();
    const onToggleAvailability = vi.fn();
    const onDelete = vi.fn();
    act(() => root.render(<HubMemberOverviewCard {...{ cat, onEdit, onToggleAvailability, onDelete }} />));
    const toggle = host.querySelector<HTMLButtonElement>(
      'button[role="switch"][aria-label="成员启用状态：Test Codex"]',
    );
    const remove = host.querySelector<HTMLButtonElement>('button[aria-label="删除成员：Test Codex"]');
    expect(toggle).not.toBeNull();
    expect(remove).not.toBeNull();
    act(() => {
      toggle?.click();
      remove?.click();
    });
    expect(onToggleAvailability).toHaveBeenCalledExactlyOnceWith(cat);
    expect(onDelete).toHaveBeenCalledExactlyOnceWith(cat);
    expect(onEdit).not.toHaveBeenCalled();
    act(() => host.querySelector<HTMLElement>('[data-testid="cat-card-test-codex"]')?.click());
    expect(onEdit).toHaveBeenCalledExactlyOnceWith(cat);
  });

  it('renders the canonical carrier', () => {
    act(() => root.render(<HubMemberOverviewCard cat={cat} />));
    expect(host.textContent).toContain('APP SERVER');
    act(() => root.render(<HubMemberOverviewCard cat={{ ...cat, carrier: 'acp' }} />));
    expect(host.textContent).toContain('ACP');
    expect(host.textContent).not.toContain('APP SERVER');
  });

  it.each(['kimi', 'opencode'] as const)('identifies native %s by its actual tool', (clientId) => {
    act(() =>
      root.render(
        <HubMemberOverviewCard
          cat={{ ...cat, clientId, configurationSource: 'native_tool', carrier: 'cli', defaultModel: '' }}
        />,
      ),
    );
    expect(host.textContent).toContain(clientId === 'kimi' ? 'Kimi · 跟随工具模型' : 'OpenCode · 跟随工具模型');
    expect(host.textContent).not.toContain('ACP 工具');
  });
});
