import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ThreadComposerHost } from '@/components/thread-chat/ThreadComposerHost';
import { ArtworkLightboxHost } from '../ArtworkLightboxHost';
import { ArtworkLightboxProvider, useArtworkLightboxScope } from '../ArtworkLightboxScope';

vi.mock('@/components/workbench/F307OwnerSurfaceRenderer', () => ({
  F307OwnerSurfaceRenderer: () => <div>原 owner</div>,
}));
let mounts = 0;
function OriginalComposer() {
  useEffect(() => {
    mounts++;
  }, []);
  return <textarea aria-label="原输入" defaultValue="未发送草稿" />;
}
function Harness() {
  const scope = useArtworkLightboxScope();
  return (
    <>
      <button
        type="button"
        onClick={() =>
          scope?.open({
            url: 'https://media.test/a.png',
            title: '原图',
            alt: '原图',
            mediaType: 'image',
            surface: null,
          })
        }
      >
        看原图
      </button>
      <ThreadComposerHost threadId="thread-a">
        <OriginalComposer />
      </ThreadComposerHost>
      <ArtworkLightboxHost />
    </>
  );
}
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mounts = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
it('moves the same physical composer into the floating work and back without remounting, losing draft or selection', async () => {
  await act(async () =>
    root.render(
      <ArtworkLightboxProvider threadId="thread-a">
        <Harness />
      </ArtworkLightboxProvider>,
    ),
  );
  const input = container.querySelector('textarea');
  if (!input) throw new Error('the running original composer must be mounted');
  input.value = '原草稿和未发送修改';
  input.focus();
  input.setSelectionRange(2, 5);
  await act(async () => container.querySelector('button')?.click());
  expect(document.querySelector('[role="dialog"] textarea')).toBe(input);
  expect(input.value).toBe('原草稿和未发送修改');
  expect(mounts).toBe(1);
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(container.querySelector('textarea')).toBe(input);
  expect(input.value).toBe('原草稿和未发送修改');
  expect(input.selectionStart).toBe(2);
  expect(input.selectionEnd).toBe(5);
  expect(mounts).toBe(1);
});
