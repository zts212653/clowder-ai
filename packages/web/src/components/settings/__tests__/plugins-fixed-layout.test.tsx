import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsContent } from '../SettingsContent';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(async () => new Response(JSON.stringify({ config: {} }))),
}));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ cats: [], refresh: vi.fn(), isLoading: false, hasFetched: true }),
}));
vi.mock('../PluginsContent', () => ({
  PluginsContent: () => <div data-testid="plugins-content" />,
}));
vi.mock('../SkillsContent', () => ({
  SkillsContent: () => <div data-testid="skills-content" />,
}));

describe('Plugins fixed-layout scroll chain', () => {
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

  it('constrains the plugins wrapper to a definite height so the detail pane scrolls', async () => {
    await act(async () => root.render(<SettingsContent section="plugins" />));
    const content = host.querySelector('[data-testid="plugins-content"]');
    expect(content).not.toBeNull();
    // The plugin manager's internal overflow-y-auto regions resolve their
    // h-full against this wrapper; a content-sized box silently disables
    // detail scrolling and the shell's overflow-hidden clips the tail.
    const wrapper = content!.parentElement!;
    expect(wrapper.classList.contains('h-full')).toBe(true);
    expect(wrapper.classList.contains('min-h-0')).toBe(true);
    expect(wrapper.classList.contains('flex')).toBe(true);
    expect(wrapper.classList.contains('flex-col')).toBe(true);
  });

  it('keeps the default unconstrained wrapper for other sections', async () => {
    await act(async () => root.render(<SettingsContent section="skills" />));
    const content = host.querySelector('[data-testid="skills-content"]');
    expect(content).not.toBeNull();
    expect(content!.parentElement!.getAttribute('class')).toBeNull();
  });
});
