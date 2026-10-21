import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { VideoWorkMaterialPreview } from '../VideoWorkMaterialPreview';

it.each([
  ['image/png', 'img'],
  ['audio/wav', 'audio'],
  ['video/webm', 'video'],
])('a failed %s preview explains the failure, pauses playback, and retries the same retained source', async (mediaType, tag) => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div'),
    root = createRoot(host);
  const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  const url = '/api/works/fixed/video-assets/2/3/original';
  const click = (text: string) =>
    act(async () => {
      [...host.querySelectorAll('button')].find((node) => node.textContent === text)?.click();
    });
  try {
    await act(async () => root.render(<VideoWorkMaterialPreview url={url} name="原素材" mediaType={mediaType} />));
    expect(host.querySelector(tag)).toBeNull();
    await click('在此预览');
    const media = host.querySelector(tag);
    expect(media).not.toBeNull();
    await act(async () => media?.dispatchEvent(new Event('error')));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('这份素材暂时无法预览');
    expect(host.querySelector(tag)).toBeNull();
    if (tag !== 'img') expect(pause).toHaveBeenCalledTimes(1);
    await click('重试预览');
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelector(tag)?.getAttribute('src')).toBe(url);
    await click('收起预览');
    expect(host.querySelector(tag)).toBeNull();
    if (tag !== 'img') expect(pause).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => root.unmount());
    pause.mockRestore();
  }
});
