import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeShellPresentation } from '../../shell/shell-presentation';
import { SettingsContent } from '../SettingsContent';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(async (path: string) => {
    if (path === '/api/config') return new Response(JSON.stringify({ config: {} }));
    if (path.startsWith('/api/plugin-manager/plugins'))
      return new Response(JSON.stringify({ plugins: [], catalog: { status: 'fresh', refreshedAt: 1000 } }));
    if (path.includes('marketplaces')) return new Response(JSON.stringify({ sources: [] }));
    throw new Error(`Unexpected request: ${path}`);
  }),
}));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ cats: [], refresh: vi.fn(), isLoading: false, hasFetched: true }),
}));
vi.mock('@/hooks/useDossierProfiles', () => ({
  useDossierProfiles: () => ({ data: null }),
  catDossierCoversStrengths: () => false,
}));

describe('Plugin settings production composition', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    window.history.replaceState(null, '', '/settings?s=plugins');
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    writeShellPresentation('classic');
    vi.unstubAllGlobals();
  });

  it.each(['classic', 'v2'] as const)('renders one page heading with the live toolbar in %s', async (shell) => {
    writeShellPresentation(shell);
    await act(async () => root.render(<SettingsContent section="plugins" />));
    const headings = [...host.querySelectorAll('h2')].filter((node) => node.textContent === '插件集成');
    expect(headings).toHaveLength(1);
    expect(host.querySelectorAll('[data-plugin-manager-toolbar]')).toHaveLength(1);
    expect(host.querySelector('[data-plugin-manager-toolbar] input[type="file"]')).not.toBeNull();
    expect(host.textContent).toContain('从本地目录安装');
    expect(host.textContent).toContain('从安装包安装');
  });
});
