import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import type { PluginManagerListItem } from '@cat-cafe/shared';
import { apiFetch } from '@/utils/api-client';
import { designFixture, fetchManagerDetail } from '../plugin-manager-live-api';

const mockFetch = vi.mocked(apiFetch);

it('shows unknown historical origin without calling it a local or catalog source or changing Host actions', () => {
  const plugin: PluginManagerListItem = {
    pluginId: 'official.chatgpt-dot',
    pluginInstanceId: 'legacy-dot',
    packageDigest: null,
    lifecycleRevision: 4,
    displayName: 'Installed Dot',
    source: { kind: 'unknown', packageName: null, trust: 'unknown' },
    availableVersion: '0.1.1',
    installedVersion: '0.1.0',
    artifact: 'installed',
    config: 'ready',
    auth: 'connected',
    intent: 'enabled',
    live: 'running',
    capabilitySummary: [],
    actions: { install: false, setEnabled: true, uninstall: true, blockingReasons: [] },
  };
  const fixture = designFixture(plugin, undefined, { state: 'absent' });
  expect(fixture.source).toBe('unknown');
  expect(fixture.trust).toBe('unknown');
  expect(fixture.publisher).toBe('发布者未记录');
  expect(fixture.actions).toEqual(plugin.actions);
  expect(fixture.live).toBe('running');
});
beforeEach(() => {
  mockFetch.mockReset();
});

it('loads Host-bundled dot setup without requesting a nonexistent package archive README', async () => {
  const id = 'official.chatgpt-dot';
  mockFetch.mockImplementation(
    async (url) =>
      new Response(
        JSON.stringify(
          url === `/api/plugin-manager/plugins/${id}`
            ? { plugin: { pluginId: id, artifact: 'installed', live: 'stopped' }, catalog: { status: 'fresh' } }
            : { error: 'archive unavailable' },
        ),
        { status: url.endsWith('/documentation') ? 422 : 200 },
      ),
  );
  const detail = await fetchManagerDetail(id, false);
  expect(detail.pluginId).toBe(id);
  expect(mockFetch.mock.calls.map(([url]) => url)).not.toContain(`/api/plugin-manager/plugins/${id}/documentation`);
});

it('keeps package README discovery for ordinary catalog plugins', async () => {
  const id = 'ordinary.plugin';
  mockFetch.mockImplementation(
    async (url) =>
      new Response(
        JSON.stringify(
          url.endsWith('/documentation')
            ? { readmeMarkdown: '# Ordinary package' }
            : { plugin: { pluginId: id, artifact: 'installed', live: 'stopped' }, catalog: { status: 'fresh' } },
        ),
      ),
  );
  const detail = await fetchManagerDetail(id, false);
  expect(detail.readme).toEqual({ state: 'available', markdown: '# Ordinary package' });
});
