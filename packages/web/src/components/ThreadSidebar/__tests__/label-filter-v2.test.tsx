import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { writeShellLanguage } from '../../shell/shell-language';
import { LabelFilterBar } from '../LabelFilterBar';

const labels = Array.from({ length: 18 }, (_, i) => ({
  id: `label-${i}`,
  name: `很长的标签名字 ${i}`,
  color: i % 2 ? '#888888' : '',
  sortOrder: i,
  createdBy: 'user',
  createdAt: 0,
}));
let host: HTMLDivElement, root: Root;
const select = vi.fn();
function Harness({ v2 = true }: { v2?: boolean }) {
  const [filter, setFilter] = useState<string | null>(null);
  return (
    <LabelFilterBar
      variant={v2 ? 'v2' : 'classic'}
      labels={labels}
      selectedFilter={filter}
      uncategorizedCount={9}
      onSelect={(next) => {
        select(next);
        setFilter(next);
      }}
    />
  );
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  select.mockClear();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  writeShellLanguage('zh');
});
function click(selector: string) {
  act(() => host.querySelector<HTMLButtonElement>(selector)?.click());
}
it('v2 keeps all 18 label filters, selects, clears and closes on Escape without the old separator', () => {
  act(() => root.render(<Harness />));
  click('[data-testid="sidebar-label-filter-trigger"]');
  const menu = host.querySelector('[role="menu"]');
  expect(menu?.querySelectorAll('[role="menuitemradio"]')).toHaveLength(20);
  expect(menu?.className).not.toContain('right-0');
  expect(menu?.querySelector('.h-px')).toBeNull();
  click('[data-label-id="label-17"]');
  expect(select).toHaveBeenLastCalledWith('label-17');
  expect(host.querySelector('[data-testid="sidebar-label-filter-trigger"]')?.textContent).toBe(
    '标签 · 很长的标签名字 17',
  );
  click('[data-testid="sidebar-label-filter-trigger"]');
  expect(host.querySelector('[aria-checked="true"] [data-menu-check]')).not.toBeNull();
  act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(host.querySelector('[role="menu"]')).toBeNull();
  expect(document.activeElement?.getAttribute('data-testid')).toBe('sidebar-label-filter-trigger');
  click('[data-testid="sidebar-label-filter-clear"]');
  expect(select).toHaveBeenLastCalledWith(null);
});
it('v2 retains toggle-off and uncategorized semantics and supports English', () => {
  writeShellLanguage('en');
  act(() => root.render(<Harness />));
  click('[data-testid="sidebar-label-filter-trigger"]');
  click('[data-label-id="__uncategorized__"]');
  expect(select).toHaveBeenLastCalledWith('__uncategorized__');
  expect(host.textContent).toContain('Labels · Uncategorized');
  click('[data-testid="sidebar-label-filter-trigger"]');
  click('[data-label-id="__uncategorized__"]');
  expect(select).toHaveBeenLastCalledWith(null);
});
it('classic retains the original trigger, menu roles, alignment and separator', () => {
  act(() => root.render(<Harness v2={false} />));
  click('[data-testid="sidebar-label-filter-trigger"]');
  expect(host.querySelector('[role="menu"]')?.className).toContain('absolute right-0');
  expect(host.querySelectorAll('[role="menuitem"]')).toHaveLength(20);
  expect(host.querySelector('.h-px')).not.toBeNull();
  expect(host.querySelector('[data-testid="sidebar-label-filter-clear"]')).toBeNull();
});
