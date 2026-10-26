import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Lightbox } from '@/components/Lightbox';
import { writeShellLanguage } from '@/components/shell/shell-language';
import { ContentLandingHeader } from '@/components/workbench/content-review/ContentLandingHeader';
import { ArtworkActions } from '../ArtworkActions';
import { ArtworkChromeProvider, useRegisterArtworkHistory } from '../ArtworkChrome';
import { ArtworkLightboxProvider, FloatingArtworkPresentation } from '../ArtworkLightboxScope';
import { copyArtworkPixels } from '../artwork-file-client';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  writeText: vi.fn(),
  write: vi.fn(),
  fit: vi.fn(),
  actual: vi.fn(),
  history: vi.fn(),
  wholeWork: vi.fn(),
}));
vi.mock('@/utils/api-client', () => ({ API_URL: 'http://localhost:3102', apiFetch: mocks.apiFetch }));
let container: HTMLDivElement;
let root: Root;
function Surface() {
  const media = useRef<HTMLDivElement>(null);
  useRegisterArtworkHistory(mocks.history);
  return (
    <>
      <ContentLandingHeader title="original.jpg" />
      <div ref={media}>
        <img src="blob:display" alt="original" />
      </div>
      <ArtworkActions
        root={media}
        src="blob:display"
        originalUrl="http://localhost:3102/api/content-publications/content%3Aone/media/2"
        filename="original.jpg"
        mime="image/jpeg"
        byteLength={2 * 1024 * 1024}
        width={320}
        height={240}
        wholeWorkAction={
          <button type="button" onClick={mocks.wholeWork}>
            在聊天里讨论整张图
          </button>
        }
        viewport={{ renderedScale: 0.5, fit: mocks.fit, actual: mocks.actual }}
      />
    </>
  );
}
beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: mocks.writeText, write: mocks.write },
  });
  mocks.apiFetch.mockImplementation(
    async (_url: string, init?: RequestInit) =>
      new Response(
        JSON.stringify(
          init?.method === 'POST'
            ? { ok: true }
            : {
                local: true,
                path: '/home/user/original.jpg',
                displayPath: '~/original.jpg',
                defaultApplication: 'Preview',
                defaultApplicationBundleId: 'com.apple.Preview',
                byteLength: 512,
              },
        ),
      ),
  );
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  localStorage.clear();
});
async function render() {
  await act(async () =>
    root.render(
      <ArtworkChromeProvider>
        <Surface />
      </ArtworkChromeProvider>,
    ),
  );
}
function button(label: string) {
  const found = [...container.querySelectorAll<HTMLButtonElement>('button')].find((node) =>
    node.textContent?.includes(label),
  );
  if (!found) throw new Error(label);
  return found;
}
async function more() {
  await act(async () => button('⋯').click());
}
it('more and right click expose the same file actions and use the full path for copy', async () => {
  await render();
  await more();
  const items = [...container.querySelectorAll('[role="menuitem"]')].map((node) => node.textContent);
  expect(items.join()).toContain('在 Finder 中显示');
  expect(container.textContent).toContain('512 B');
  expect(container.querySelector('[role="menu"]')?.textContent).toContain('预览');
  expect(container.querySelector('[role="menuitem"]')).toBe(document.activeElement);
  expect([...container.querySelectorAll('[role="menuitem"]')].every((item) => !!item.querySelector('svg'))).toBe(true);
  await act(async () => button('复制路径').click());
  expect(mocks.writeText).toHaveBeenCalledWith('/home/user/original.jpg');
  expect(container.textContent).toContain('已复制路径');
  expect(document.activeElement).toBe(button('⋯'));
  const image = container.querySelector('img');
  await act(async () =>
    image?.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 100 }),
    ),
  );
  expect([...container.querySelectorAll('[role="menuitem"]')].map((node) => node.textContent)).toEqual(items);
  await act(async () => button('用默认应用打开').click());
  expect(mocks.apiFetch).toHaveBeenLastCalledWith(
    '/api/content-publications/content%3Aone/media/2/open',
    expect.objectContaining({ method: 'POST', body: '{}' }),
  );
});
it('history and actual-size still call their original owner and Escape only closes the menu', async () => {
  await render();
  await more();
  await act(async () => button('修改记录').click());
  expect(mocks.history).toHaveBeenCalledTimes(1);
  await more();
  await act(async () => button('实际大小').click());
  expect(mocks.actual).toHaveBeenCalledTimes(1);
  await more();
  const menu = container.querySelector('[role="menu"]');
  await act(async () =>
    menu?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })),
  );
  expect(container.querySelector('[role="menu"]')).toBeNull();
  expect(container.textContent).toContain('original.jpg');
});
it('remote media information hides host actions and copies its canonical link', async () => {
  mocks.apiFetch.mockResolvedValue(new Response(JSON.stringify({ local: false })));
  await render();
  await more();
  expect(container.textContent).not.toContain('在 Finder 中显示');
  expect(container.textContent).not.toContain('用默认应用打开');
  expect(container.textContent).toContain('2.0 MB');
  await act(async () => button('复制链接').click());
  expect(mocks.writeText).toHaveBeenCalledWith('http://localhost:3102/api/content-publications/content%3Aone/media/2');
});
it('focuses an enabled menu action while file information loads, so Escape preserves the actual lightbox', async () => {
  let receive: (response: Response) => void = () => {};
  mocks.apiFetch.mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        receive = resolve;
      }),
  );
  const onClose = vi.fn();
  await act(async () =>
    root.render(
      <ArtworkLightboxProvider threadId="original-chat">
        <FloatingArtworkPresentation>
          <Lightbox
            url="/original.jpg"
            alt="original.jpg"
            composerSlot={<div>original composer</div>}
            onClose={onClose}
          >
            <Surface />
          </Lightbox>
        </FloatingArtworkPresentation>
      </ArtworkLightboxProvider>,
    ),
  );
  const dialog = document.body.querySelector('[role="dialog"]');
  const trigger = dialog?.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]');
  expect(trigger).toBeTruthy();
  await act(async () => trigger?.click());
  const focused = document.activeElement as HTMLButtonElement;
  expect(focused.closest('[role="menu"]')).toBeTruthy();
  expect(focused.disabled).toBe(false);
  await act(async () => receive(new Response(JSON.stringify({ local: true, path: '/home/user/original.jpg' }))));
  expect(document.activeElement?.textContent).toBe('在 Finder 中显示');
  await act(async () =>
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    ),
  );
  expect(dialog?.querySelector('[role="menu"]')).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(trigger);
  await act(async () =>
    trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })),
  );
  expect(onClose).toHaveBeenCalledTimes(1);
});
it('updates the open menu language without resolving or changing its default application again', async () => {
  await render();
  await more();
  const reads = mocks.apiFetch.mock.calls.length;
  await act(async () => writeShellLanguage('en'));
  expect(container.textContent).toContain('Open with default applicationPreview');
  expect(container.textContent).not.toContain('预览');
  expect(mocks.apiFetch).toHaveBeenCalledTimes(reads);
});
it('waits for the current owner file information before offering a path or link copy', async () => {
  let receive: (response: Response) => void = () => {};
  mocks.apiFetch.mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        receive = resolve;
      }),
  );
  await render();
  await more();
  expect(button('正在读取文件信息').disabled).toBe(true);
  expect(container.textContent).not.toContain('复制链接');
  await act(async () => button('正在读取文件信息').click());
  expect(mocks.writeText).not.toHaveBeenCalled();
  await act(async () => receive(new Response(JSON.stringify({ local: true, path: '/home/user/original.jpg' }))));
  await act(async () => button('复制路径').click());
  expect(mocks.writeText).toHaveBeenCalledWith('/home/user/original.jpg');
});
it('runs the original whole-work Chat action before its menu is dismissed', async () => {
  await render();
  await more();
  await act(async () => button('在聊天里讨论整张图').click());
  expect(mocks.wholeWork).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[role="menu"]')).toBeNull();
});
it('JPG pixels are encoded as PNG instead of writing an unsupported JPEG clipboard flavor', async () => {
  const image = document.createElement('img');
  const bitmap = { width: 320, height: 240, close: vi.fn() };
  const draw = vi.fn();
  const png = new Blob(['pixels'], { type: 'image/png' });
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => bitmap),
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: draw,
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((done, type) => {
    expect(type).toBe('image/png');
    done(png);
  });
  vi.stubGlobal(
    'ClipboardItem',
    class {
      constructor(readonly data: Record<string, Promise<Blob>>) {}
    },
  );
  mocks.apiFetch.mockResolvedValue(new Response('jpeg', { headers: { 'Content-Type': 'image/jpeg' } }));
  await copyArtworkPixels(image, 'http://localhost:3102/api/content-publications/content%3Aone/media/2');
  const item = mocks.write.mock.calls[0][0][0];
  expect(await item.data['image/png']).toBe(png);
  expect(draw).toHaveBeenCalledWith(bitmap, 0, 0, 320, 240);
  expect(bitmap.close).toHaveBeenCalledTimes(1);
  vi.restoreAllMocks();
});

it.each([true, false])('the overflow work-mode action follows its original owner result (%s)', async (opened) => {
  const onClose = vi.fn();
  const openWorkspace = vi.fn(async () => opened);
  await act(async () =>
    root.render(
      <ArtworkLightboxProvider threadId="original-chat">
        <FloatingArtworkPresentation>
          <Lightbox
            url="/original.jpg"
            alt="original.jpg"
            composerSlot={<div>same composer</div>}
            onClose={onClose}
            onOpenWorkspace={openWorkspace}
          >
            <Surface />
          </Lightbox>
        </FloatingArtworkPresentation>
      </ArtworkLightboxProvider>,
    ),
  );
  const dialog = document.body.querySelector('[role="dialog"]');
  await act(async () => dialog?.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')?.click());
  const action = [...(dialog?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])].find(
    (item) => item.textContent === '作品模式',
  );
  expect(action).toBeTruthy();
  await act(async () => action?.click());
  expect(openWorkspace).toHaveBeenCalledTimes(1);
  expect(onClose).toHaveBeenCalledTimes(opened ? 1 : 0);
  expect(dialog?.querySelector('[role="menu"]')).toBeNull();
  if (!opened) expect(dialog?.querySelector('[role="alert"]')?.textContent).toContain('暂时无法进入作品模式');
});
