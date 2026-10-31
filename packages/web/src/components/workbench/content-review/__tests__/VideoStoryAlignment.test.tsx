import type { WorkVideoContext } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { VideoStoryAlignment } from '../VideoStoryAlignment';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
type Story = WorkVideoContext['story'][number];
const row = (id: string, startPts: number, sourceId?: string): Story => ({
  id,
  title: '片尾',
  streamId: 'video',
  startPts,
  endPts: startPts + 100,
  ...(sourceId ? { sourceId } : {}),
});
it('aligns the selected explicit pair and cannot reuse a selection after its mapping disappears', async () => {
  const host = document.createElement('div'),
    root = createRoot(host),
    align = vi.fn();
  const left = row('old', 2400, 'script#tail'),
    right = row('new', 18000, 'script#tail');
  try {
    await act(async () => root.render(<VideoStoryAlignment left={[left]} right={[right]} onAlign={align} />));
    const button = host.querySelector('button'),
      select = host.querySelector('select');
    expect(button?.disabled).toBe(true);
    if (!select || !button) throw new Error('Missing alignment controls');
    await act(async () => {
      select.value = 'script#tail';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => button.click());
    expect(align).toHaveBeenCalledExactlyOnceWith(left, right);
    await act(async () =>
      root.render(<VideoStoryAlignment left={[left]} right={[row('new', 18000)]} onAlign={align} />),
    );
    expect(host.querySelector('button')).toBeNull();
    expect(host.textContent).toContain('没有已核实的段落映射');
    expect(align).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
  }
});
