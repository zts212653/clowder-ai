import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RuntimeUpdateRequiredDialog } from '../RuntimeUpdateRequiredDialog';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe('RuntimeUpdateRequiredDialog', () => {
  it('explains that the old page is blocked and offers a single explicit refresh action', () => {
    const html = renderToStaticMarkup(<RuntimeUpdateRequiredDialog onReload={() => undefined} />);
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('页面已经更新');
    expect(html).toContain('刷新页面');
    expect(html).toContain('data-testid="runtime-update-required"');
  });

  it('focuses the only recovery action and invokes reload explicitly', () => {
    const onReload = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => root.render(<RuntimeUpdateRequiredDialog onReload={onReload} />));
    const button = container.querySelector('button');
    expect(document.activeElement).toBe(button);
    act(() => button?.click());
    expect(onReload).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
    container.remove();
  });
});
