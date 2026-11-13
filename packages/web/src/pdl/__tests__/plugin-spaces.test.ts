import { beforeEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { callPluginOperation, readPluginSpaces, readPluginSubtree } from '../plugin-spaces';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
it('sends the real operation coordinates and owner-confirmed header only after the declared dialog confirms', async () => {
  vi.mocked(apiFetch).mockResolvedValue(Response.json({ ok: true, render: 'status', label: 'Removed' }));
  await callPluginOperation(
    'dev.owner',
    'sessions',
    'remove',
    { rowKey: 'row/one', input: { sessionId: 'session-one' } },
    true,
  );
  expect(apiFetch).toHaveBeenLastCalledWith(
    '/api/plugins/dev.owner/actions/sessions/remove',
    expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-cat-cafe-owner-confirmed': 'true' },
      body: '{"rowKey":"row/one","input":{"sessionId":"session-one"}}',
    }),
    undefined,
  );
});
it('keeps every plugin declaration as admitted and calls no plugin endpoint of its own', async () => {
  const fragments = {
    'official.collective-connector': { views: { client: { type: 'frame', src: '', route: 'plug-collective' } } },
    'other.plugin': { views: { client: { type: 'frame', src: 'https://other.test/' } } },
  };
  vi.mocked(apiFetch).mockResolvedValue(Response.json({ fragments: structuredClone(fragments) }));
  expect(await readPluginSpaces()).toEqual({ fragments });
  expect(apiFetch).toHaveBeenCalledTimes(1);
});
it('reads a subtree when it is first projected and passes it on as is (components load in the engine)', async () => {
  const subtree = { views: {}, components: { js: ["PDL_COMPONENTS['plugin:x/card'] = () => '';"], css: [] } };
  vi.mocked(apiFetch).mockImplementation(async () => Response.json(structuredClone(subtree)));
  expect(await readPluginSubtree('official.github-operations')).toEqual(subtree);
  expect(vi.mocked(apiFetch).mock.calls[0]![0]).toBe('/api/plugin-manager/pdl/official.github-operations');
  expect(document.body.querySelectorAll('script')).toHaveLength(0);
});
