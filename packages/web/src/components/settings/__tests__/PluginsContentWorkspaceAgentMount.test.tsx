import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('../PersonalChromePluginPanel', () => ({
  PersonalChromePluginPanel: () => <div data-testid="stub-personal-chrome" />,
}));
vi.mock('../OfficialPluginsPanel', () => ({ OfficialPluginsPanel: () => <div data-testid="stub-official" /> }));

import { apiFetch } from '@/utils/api-client';
import { PluginsContent } from '../PluginsContent';

const mockApiFetch = vi.mocked(apiFetch);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const onePlugin = [
  {
    id: 'dev.clowder.demo',
    name: 'Demo Plugin',
    description: 'demo',
    enabled: true,
    version: '1.0.0',
  },
];

let container: HTMLElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mockApiFetch.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

afterAll(() => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe('astra round-4 R1: Workspace Agent panel is reachable with a NON-EMPTY plugin list', () => {
  it('renders the workspace-agent panel in the populated plugins branch', async () => {
    mockApiFetch.mockImplementation(async (url: unknown) => {
      if (String(url) === '/api/plugins') return json(onePlugin);
      if (String(url) === '/api/plugins/workspace-agent') {
        return json({ enabled: false, triggerId: null, workspaceId: null, tokenConfigured: false, source: null });
      }
      return json({}, 404);
    });

    await act(async () => {
      root!.render(<PluginsContent />);
    });
    // The populated branch must still expose the Workspace Agent card
    // (round-4 R1: it was only mounted on loading/empty branches before).
    expect(container!.querySelector('[data-testid="workspace-agent-plugin-panel"]')).not.toBeNull();
  });
});
