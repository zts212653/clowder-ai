import { resolveChatBackground } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { chatBackgroundPreferencesSchema as v1Provider } from '../../../../../api/test/fixtures/chat-background-v1/schema.js';
import { ChatBackgroundProvider, useChatBackgroundPreferences } from '../ChatBackgroundProvider';
import { backgroundResponse } from './background-test-response';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
const image = {
  kind: 'image' as const,
  url: '/backgrounds/sunset-clouds.jpg',
  name: 'Sunset',
  placement: 'fill' as const,
  opacity: { light: 0.11, dark: 0.14 },
  recommendedOpacity: { light: 0.11, dark: 0.14 },
};
let controller: NonNullable<ReturnType<typeof useChatBackgroundPreferences>>;
function Consumer() {
  const value = useChatBackgroundPreferences();
  if (value) controller = value;
  return <output>{value ? resolveChatBackground(value.preferences, 'chat-a').kind : 'missing'}</output>;
}
describe('shared background preference stream', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.resetAllMocks();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });
  const mount = (enabled = true) =>
    act(async () =>
      root.render(
        <ChatBackgroundProvider enabled={enabled}>
          <Consumer />
        </ChatBackgroundProvider>,
      ),
    );
  it('keeps image records v1-readable while durable sidecar intent survives reload', async () => {
    const metadata = { readableOpacity: { light: 0.38, dark: 0.14 }, manualOpacity: { light: true, dark: false } };
    const initial = backgroundResponse({ ...image, ...metadata });
    expect(v1Provider.parse(initial)).toEqual({ global: image, threads: {} });
    vi.mocked(apiFetch).mockImplementation(async (_url, init) => {
      if (init?.method !== 'PUT') return Response.json(initial);
      const change = JSON.parse(String(init.body));
      expect(v1Provider.parse({ global: change.background, threads: {} }).global).toEqual(image);
      expect(change.metadata).toEqual(metadata);
      return Response.json(backgroundResponse(change.background, change.metadata));
    });
    await mount();
    expect(controller.preferences.global).toEqual({ ...image, ...metadata });
    await act(async () => {
      expect(await controller.save({ scope: 'global', background: { ...image, ...metadata } })).toBe(true);
    });
    await act(async () => controller.reload());
    expect(controller.preferences.global).toEqual({ ...image, ...metadata });
  });
  for (const switchShell of [false, true]) {
    for (const finishSaveFirst of [false, true]) {
      it(`rejects a GET begun during a pending save (shell switch=${switchShell}, PUT first=${finishSaveFirst})`, async () => {
        let finishPut: (response: Response) => void = () => undefined;
        let finishGet: (response: Response) => void = () => undefined;
        const metadata = { readableOpacity: { light: 0.3, dark: 0.14 }, manualOpacity: { light: true } };
        const next = { ...image, ...metadata };
        const put = new Promise<Response>((resolve) => {
          finishPut = resolve;
        });
        const get = new Promise<Response>((resolve) => {
          finishGet = resolve;
        });
        vi.mocked(apiFetch)
          .mockResolvedValueOnce(Response.json({ threads: {} }))
          .mockReturnValueOnce(put)
          .mockReturnValueOnce(get);
        await mount();
        let saving: Promise<boolean> = Promise.resolve(false);
        await act(async () => {
          saving = controller.save({ scope: 'global', background: next });
        });
        let reloading: Promise<void> = Promise.resolve();
        if (switchShell) {
          await mount(false);
          await mount(true);
        } else
          await act(async () => {
            reloading = controller.reload();
          });
        const settlePut = () =>
          act(async () => {
            finishPut(Response.json(backgroundResponse(next)));
            expect(await saving).toBe(true);
          });
        const settleGet = async () => {
          await act(async () => {
            finishGet(Response.json({ threads: {} }));
            await reloading;
          });
          expect(controller.preferences.global).toEqual(next);
        };
        if (finishSaveFirst) {
          await settlePut();
          await settleGet();
        } else {
          await settleGet();
          await settlePut();
        }
        expect(controller.preferences.global).toEqual(next);
        expect(controller.loadError).toBe(false);
        expect(controller.loading).toBe(false);
        // A later failed save must roll back to the same confirmed value, not the stale GET.
        vi.mocked(apiFetch).mockResolvedValueOnce(new Response('failed', { status: 500 }));
        await act(async () => {
          expect(await controller.save({ scope: 'global', background: { kind: 'none' } })).toBe(false);
        });
        expect(controller.preferences.global).toEqual(next);
      });
    }
  }
  it('does not let an obsolete GET error disable saving after a canonical PUT succeeds', async () => {
    let finishPut: (response: Response) => void = () => undefined;
    let finishGet: (response: Response) => void = () => undefined;
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(Response.json({ threads: {} }))
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finishPut = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finishGet = resolve;
        }),
      );
    await mount();
    let saving: Promise<boolean> = Promise.resolve(false);
    let reloading: Promise<void> = Promise.resolve();
    await act(async () => {
      saving = controller.save({ scope: 'global', background: image });
    });
    await act(async () => {
      reloading = controller.reload();
    });
    await act(async () => {
      finishPut(Response.json({ global: image, threads: {} }));
      await saving;
    });
    await act(async () => {
      finishGet(new Response('old error', { status: 500 }));
      await reloading;
    });
    expect(controller.loadError).toBe(false);
    expect(controller.preferences.global).toEqual(image);
  });
  it('immediately previews a choice, serializes rapid writes, and keeps explicit none distinct from inheritance', async () => {
    let release: (value: Response) => void = () => undefined;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(Response.json({ threads: {} }))
      .mockReturnValueOnce(pending)
      .mockResolvedValueOnce(Response.json({ global: image, threads: { 'chat-a': { kind: 'none' } } }));
    await mount();
    let first: Promise<boolean> | undefined;
    let second: Promise<boolean> | undefined;
    await act(async () => {
      first = controller.save({ scope: 'global', background: image });
      second = controller.save({ scope: 'thread', threadId: 'chat-a', background: { kind: 'none' } });
    });
    expect(host.textContent).toBe('none');
    expect(vi.mocked(apiFetch).mock.calls.filter((call) => call[1]?.method === 'PUT')).toHaveLength(1);
    await act(async () => {
      release(Response.json({ global: image, threads: {} }));
      await first;
      await second;
    });
    expect(controller.preferences.threads['chat-a']).toEqual({ kind: 'none' });
    vi.mocked(apiFetch).mockResolvedValueOnce(Response.json({ global: image, threads: {} }));
    await act(async () => {
      expect(await controller.save({ scope: 'thread', threadId: 'chat-a', background: null })).toBe(true);
    });
    expect(host.textContent).toBe('image');
  });
  it('rolls a failed save back to the confirmed server state and refuses to overwrite an unreadable profile', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(Response.json({ global: image, threads: {} }))
      .mockResolvedValueOnce(new Response('failed', { status: 500 }));
    await mount();
    await act(async () => {
      expect(await controller.save({ scope: 'global', background: { kind: 'none' } })).toBe(false);
    });
    expect(host.textContent).toBe('image');
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response('failed', { status: 500 }));
    await act(async () => {
      await controller.reload();
    });
    await act(async () => {
      expect(await controller.save({ scope: 'global', background: { kind: 'none' } })).toBe(false);
    });
    expect(controller.loadError).toBe(true);
    expect(vi.mocked(apiFetch).mock.calls.filter((call) => call[1]?.method === 'PUT')).toHaveLength(1);
  });
  it('invalidates a failed load and its captured retry when disabled, then loads afresh when enabled', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response('failed', { status: 500 }));
    await mount();
    expect(controller.loadError).toBe(true);
    const staleReload = controller.reload;
    await mount(false);
    expect(controller.loadError).toBe(false);
    await act(async () => {
      await staleReload();
      await controller.reload();
    });
    expect(apiFetch).toHaveBeenCalledTimes(1);
    vi.mocked(apiFetch).mockResolvedValueOnce(Response.json({ global: image, threads: {} }));
    await mount();
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(controller.preferences.global).toEqual(image);
    expect(controller.loadError).toBe(false);
  });
  it('ignores a pending load that completes after the shell is disabled', async () => {
    let release: (response: Response) => void = () => undefined;
    vi.mocked(apiFetch).mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    await mount();
    await mount(false);
    await act(async () => release(new Response('failed', { status: 500 })));
    expect(controller.loadError).toBe(false);
    expect(controller.loading).toBe(false);
    expect(controller.preferences).toEqual({ threads: {} });
  });
});
