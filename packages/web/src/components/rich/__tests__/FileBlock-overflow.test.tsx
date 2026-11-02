import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { openFileMenu } from '@/test-utils/open-file-menu';
import { FileBlock } from '../FileBlock';

it('keeps the full filename available in the shared title and download action for documents and video', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'),
    root = createRoot(host);
  const name = 'F269-包含中文与家庭emoji-👨‍👩‍👧‍👦-最终复核报告';
  const copy = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
  try {
    for (const extension of ['pdf', 'mp4']) {
      const fileName = `${name}.${extension}`;
      await act(async () =>
        root.render(
          <FileBlock
            block={{
              id: 'file',
              kind: 'file',
              v: 1,
              fileName,
              url: `/uploads/${extension === 'pdf' ? 'report.pdf' : 'walkthrough.mp4'}`,
            }}
          />,
        ),
      );
      expect(host.querySelector('.work-gallery-title')?.getAttribute('title')).toBe(fileName);
      await openFileMenu(host);
      expect(host.querySelector('a[download]')?.getAttribute('download')).toBe(fileName);
      expect(host.querySelector('a button')).toBeNull();
      await act(async () =>
        [...host.querySelectorAll<HTMLButtonElement>('[role="menu"] button')]
          .find((item) => item.textContent === '复制完整文件名')
          ?.click(),
      );
      expect(copy).toHaveBeenLastCalledWith(fileName);
    }
  } finally {
    await act(async () => root.unmount());
  }
});
