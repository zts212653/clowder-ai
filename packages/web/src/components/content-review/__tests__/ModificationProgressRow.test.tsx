import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModificationProgressRow } from '../ModificationProgressRow';
import type { ModificationProgressCopy } from '../modification-progress-copy';

let root: Root;
let host: HTMLElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const render = async (element: React.ReactElement) => {
  await act(async () => {
    root.render(element);
  });
};

const working: ModificationProgressCopy = {
  key: 'working',
  indicator: 'spinner',
  title: '修改中 · 窄屏设计稿 2\u00A0处',
  chip: '烁烁修改中 · 2\u00A0处',
  action: { kind: 'cancel-request', label: '取消修改', compactLabel: '取消' },
};

describe('ModificationProgressRow', () => {
  it('announces the real state politely, with a spinner while work is in progress', async () => {
    await render(<ModificationProgressRow copy={working} handlers={{}} />);
    const row = host.querySelector('[data-testid="modification-progress"]');
    expect(row?.getAttribute('data-state')).toBe('working');
    // <output> is the polite live region: a changed state is announced without stealing focus.
    expect(row?.querySelector('output')?.textContent).toContain('修改中 · 窄屏设计稿 2\u00A0处');
    const spinner = host.querySelector('[data-indicator="spinner"]');
    expect(spinner?.getAttribute('aria-hidden')).toBe('true');
    // Motion is decoration: it must respect reduced-motion preferences.
    expect(spinner?.className).toContain('motion-safe:animate-spin');
  });

  it('shows the short visible label but names the control by its full action', async () => {
    const cancel = vi.fn();
    await render(<ModificationProgressRow copy={working} handlers={{ 'cancel-request': cancel }} />);
    const button = host.querySelector('button');
    expect(button?.textContent).toBe('取消');
    expect(button?.getAttribute('aria-label')).toBe('取消修改');
    await act(async () => button?.click());
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('disables the action while a request is in flight so it cannot be repeated', async () => {
    const cancel = vi.fn();
    await render(<ModificationProgressRow copy={working} busy handlers={{ 'cancel-request': cancel }} />);
    const button = host.querySelector('button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await act(async () => button.click());
    expect(cancel).not.toHaveBeenCalled();
  });

  it('draws no control for an action that is not wired, instead of a button that does nothing', async () => {
    const copy: ModificationProgressCopy = {
      key: 'cancelled_still_running',
      indicator: 'attention',
      title: '修改已取消，执行仍在进行',
      detail: '取消修改不会停止本轮执行。',
      action: { kind: 'stop-run', label: '停止执行…', compactLabel: '停止执行…' },
    };
    await render(<ModificationProgressRow copy={copy} handlers={{ 'cancel-request': vi.fn() }} />);
    expect(host.querySelector('button')).toBeNull();
    expect(host.textContent).toContain('取消修改不会停止本轮执行。');
  });

  it('colours the state dot only, never the words', async () => {
    const cases: [ModificationProgressCopy['indicator'], string][] = [
      // A neutral dot follows the host text colour: the line may sit in a tinted message bubble.
      ['neutral', 'bg-current'],
      ['attention', 'bg-semantic-warning'],
      ['danger', 'bg-semantic-critical'],
    ];
    for (const [indicator, expected] of cases) {
      await render(
        <ModificationProgressRow
          copy={{ key: 'queued', indicator, title: '已排队', detail: '烁烁尚未开始处理。' }}
          handlers={{}}
        />,
      );
      const dot = host.querySelector(`[data-indicator="${indicator}"]`);
      expect(dot?.className).toContain(expected);
      expect(dot?.getAttribute('aria-hidden')).toBe('true');
      expect(host.innerHTML).not.toMatch(/text-semantic-/);
    }
  });

  it('keeps every word and the action in the host text colour so it stays readable on a tinted bubble', async () => {
    const copy: ModificationProgressCopy = {
      key: 'incomplete',
      indicator: 'danger',
      title: '修改未完成',
      detail: '执行失败，修改说明已保留。',
      action: { kind: 'open-execution', label: '打开执行对话', compactLabel: '打开执行对话' },
    };
    await render(<ModificationProgressRow copy={copy} handlers={{ 'open-execution': vi.fn() }} />);
    const html = host.innerHTML;
    // The neutral palette (secondary/muted/accent text) is tuned for plain surfaces; inside the user's own
    // bubble it falls below 4.5:1, so the row inherits the colour of the words around it instead.
    expect(html).not.toMatch(/text-cafe-(secondary|muted|accent)/);
    const button = host.querySelector('button');
    expect(button?.className).toContain('underline');
    // The secondary line is quieter by opacity, not by a lighter colour.
    expect(host.querySelector('output span:nth-child(2)')?.className).toContain('opacity-80');
  });

  it('shows a spinner that follows the host text colour', async () => {
    await render(<ModificationProgressRow copy={working} handlers={{}} />);
    const spinner = host.querySelector('[data-indicator="spinner"]');
    expect(spinner?.className).toContain('border-current');
    expect(spinner?.className).not.toContain('border-cafe-muted');
  });

  it('shows the unconfirmed-cancel message as an alert next to the unchanged state', async () => {
    await render(
      <ModificationProgressRow
        copy={working}
        notice="取消结果尚未确认。请求和候选已保留；重试会核对同一次取消。"
        handlers={{ 'cancel-request': vi.fn() }}
      />,
    );
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('取消结果尚未确认');
    expect(host.textContent).toContain('修改中 · 窄屏设计稿 2\u00A0处');
    expect(host.querySelector('button')).not.toBeNull();
  });
});
