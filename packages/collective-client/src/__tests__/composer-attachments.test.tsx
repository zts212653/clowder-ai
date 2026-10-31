// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { Composer } from '../Composer.js';

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

it('lets a person choose files from the ordinary Channel composer without selecting a cat or creating work', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <Composer
          namespace="member:channel"
          channelId="general"
          placeholder="Message #general"
          delivery={{ kind: 'idle' }}
          onSend={vi.fn()}
        />,
      ),
    );
    const fileInput = container.querySelector<HTMLInputElement>('input[type=file]');
    expect(fileInput, 'The normal composer needs a real multi-file picker').not.toBeNull();
    expect(fileInput?.multiple).toBe(true);
    const more = container.querySelector<HTMLButtonElement>('.composer-expand');
    await act(async () => more?.click());
    expect(
      [...container.querySelectorAll('button')].some((button) => button.textContent?.includes('贴纸')),
      'The ordinary expression controls include the shared sticker picker',
    ).toBe(true);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
