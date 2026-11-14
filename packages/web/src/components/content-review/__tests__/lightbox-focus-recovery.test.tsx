import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Lightbox } from '@/components/Lightbox';
import { writeShellPresentation } from '@/components/shell/shell-presentation';

let host: HTMLDivElement, root: Root;
const close = vi.fn();
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([new DOMRect()] as unknown as DOMRectList);
  writeShellPresentation('classic');
  close.mockReset();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function render(owner: ReactNode, open?: () => Promise<boolean>) {
  await act(async () =>
    root.render(
      <Lightbox url="/focus.png" alt="Original" onClose={close} onOpenWorkspace={open}>
        {owner}
      </Lightbox>,
    ),
  );
}
function control(selector: string) {
  const node = document.querySelector<HTMLButtonElement>(`[role="dialog"] ${selector}`);
  if (!node) throw new Error(`Missing original control: ${selector}`);
  return node;
}
async function expectNoCloseActivation() {
  expect(document.activeElement).not.toBe(control('button[title="Close"]'));
  await act(async () => (document.activeElement as HTMLElement)?.click());
  expect(close).not.toHaveBeenCalled();
}

it('does not turn a temporarily disabled owner action into a Close action', async () => {
  await render(<button type="button">Save</button>);
  control('button:not([title])').focus();
  await render(
    <button type="button" disabled>
      Save
    </button>,
  );
  await expectNoCloseActivation();
  await render(<button type="button">Save</button>);
  await expectNoCloseActivation();
});

it('does not assign Close when the owner removes its focused text input', async () => {
  await render(<input aria-label="Owner draft" defaultValue="Unsent" />);
  control('input').focus();
  await render(<p>Owner retained</p>);
  await expectNoCloseActivation();
});

it('does not close the preview when the focused work-mode action fails and the user retries', async () => {
  const result = Promise.withResolvers<boolean>();
  await render(<p>Owner retained</p>, () => result.promise);
  const open = control('[data-testid="lightbox-open-workspace"]');
  open.focus();
  await act(async () => open.click());
  expect(open.disabled).toBe(true);
  await act(async () => result.resolve(false));
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('重试');
  expect(open.disabled).toBe(false);
  await expectNoCloseActivation();
});

it.each([
  'inert',
  'hidden',
  'aria-hidden',
] as const)('skips the %s owner arrow when replacing a preview arrow', async (hidden) => {
  const view = (generation: number) => (
    <>
      <section
        ref={(node) => {
          if (node && hidden === 'inert') node.setAttribute('inert', '');
        }}
        {...(hidden === 'hidden' ? { hidden: true } : hidden === 'aria-hidden' ? { 'aria-hidden': true } : {})}
      >
        <button type="button" data-artwork-gallery-direction="next" data-testid="hidden-owner-next">
          Owner Next
        </button>
      </section>
      <section key={generation}>
        <button type="button" data-artwork-gallery-direction="next" data-testid="preview-next">
          Preview Next
        </button>
      </section>
      <nav data-testid="artwork-gallery-thumbnails">
        <button type="button" aria-current="true">
          Selected artwork
        </button>
      </nav>
    </>
  );
  await render(view(1));
  const previous = control('[data-testid="preview-next"]');
  previous.focus();
  await render(view(2));
  expect(previous.isConnected).toBe(false);
  expect(document.activeElement).toBe(control('[data-testid="preview-next"]'));
  expect(close).not.toHaveBeenCalled();
});
