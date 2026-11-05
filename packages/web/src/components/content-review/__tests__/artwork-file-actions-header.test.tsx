import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { Lightbox } from '@/components/Lightbox';
import { writeShellLanguage } from '@/components/shell/shell-language';
import { ContentLandingHeader } from '@/components/workbench/content-review/ContentLandingHeader';
import { ArtworkLightboxProvider, FloatingArtworkPresentation } from '../ArtworkLightboxScope';
import { ArtworkWorkModeScope } from '../ArtworkWorkModeScope';

it('an opened artwork has one header, with version beside the title and no duplicate source/back row', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <ArtworkLightboxProvider threadId="original-chat">
          <FloatingArtworkPresentation>
            <Lightbox
              url="/original.jpg"
              alt="original.jpg"
              onClose={() => {}}
              composerSlot={<div>original composer</div>}
              onOpenWorkspace={async () => true}
            >
              <ContentLandingHeader
                title="original.jpg"
                leadingAction={<button>切换原作品</button>}
                onBack={() => {}}
                versionControl={
                  <select aria-label="作品版本">
                    <option>第 2 版 · 当前</option>
                  </select>
                }
              />
            </Lightbox>
          </FloatingArtworkPresentation>
        </ArtworkLightboxProvider>,
      ),
    );
    const dialog = document.body.querySelector('[role="dialog"]');
    const header = dialog?.querySelector('[data-testid="artwork-header"]');
    expect(header).toBeTruthy();
    expect(header?.textContent).toContain('original.jpg');
    expect(header?.querySelector('select')?.value).toBe('第 2 版 · 当前');
    expect(dialog?.textContent).not.toContain('切换原作品');
    expect(dialog?.textContent).not.toContain('返回');
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
it('work mode presents the host return and original version control once in one localized header', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const hostReturn = vi.fn(),
    sourceReturn = vi.fn(),
    versionChange = vi.fn();
  try {
    await act(async () =>
      root.render(
        <ArtworkWorkModeScope onReturn={hostReturn}>
          <ContentLandingHeader
            title="original.mp4"
            onBack={sourceReturn}
            onOpenFileTools={() => {}}
            versionControl={
              <select aria-label="作品版本" onChange={versionChange}>
                <option value="2">第 2 版 · 当前</option>
              </select>
            }
          />
        </ArtworkWorkModeScope>,
      ),
    );
    expect(container.querySelectorAll('header')).toHaveLength(1);
    expect(container.querySelectorAll('select')).toHaveLength(1);
    expect(container.textContent).not.toContain('文件工具');
    await act(async () => writeShellLanguage('en'));
    expect(container.querySelector('button')?.textContent).toContain('Chat');
    await act(async () => container.querySelector('button')?.click());
    expect(hostReturn).toHaveBeenCalledTimes(1);
    expect(sourceReturn).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    writeShellLanguage('zh');
  }
});
