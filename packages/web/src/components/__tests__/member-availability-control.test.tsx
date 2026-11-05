import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { HubMemberOverviewCard } from '../HubMemberOverviewCard';

const cat = {
  id: 'review-cat',
  displayName: '体验伙伴',
  clientId: 'openai',
  configurationSource: 'native_tool',
  defaultModel: '',
  avatar: '',
  mentionPatterns: ['@review'],
  roleDescription: '',
  personality: '',
  color: { primary: '#000', secondary: '#fff' },
} as CatData;
let host: HTMLDivElement;
let root: Root;
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

it('uses one accessible availability control and never opens the editor when toggled', async () => {
  const edit = vi.fn();
  const toggle = vi.fn();
  await act(async () => root.render(<HubMemberOverviewCard cat={cat} onEdit={edit} onToggleAvailability={toggle} />));
  const control = host.querySelector<HTMLButtonElement>('button[role="switch"]');
  expect(control).not.toBeNull();
  expect(control?.getAttribute('aria-checked')).toBe('true');
  expect(host.textContent?.match(/已启用/g)).toHaveLength(1);
  await act(async () => control?.click());
  expect(toggle).toHaveBeenCalledWith(cat);
  expect(edit).not.toHaveBeenCalled();
});

it('keeps the persisted state while saving, blocks repeat clicks, and reflects the server result', async () => {
  const toggle = vi.fn();
  const edit = vi.fn();
  await act(async () =>
    root.render(<HubMemberOverviewCard cat={cat} onEdit={edit} onToggleAvailability={toggle} togglingAvailability />),
  );
  const pending = host.querySelector<HTMLButtonElement>('[role="switch"]');
  expect(pending?.disabled).toBe(true);
  expect(pending?.getAttribute('aria-checked')).toBe('true');
  expect(pending?.getAttribute('aria-busy')).toBe('true');
  await act(async () => pending?.click());
  await act(async () => {
    pending?.querySelectorAll('span').forEach((child) => {
      child.click();
    });
  });
  expect(toggle).not.toHaveBeenCalled();
  expect(edit).not.toHaveBeenCalled();
  const disabled: CatData = {
    ...cat,
    roster: { family: 'test', roles: [], lead: false, available: false, evaluation: '' },
  };
  await act(async () => root.render(<HubMemberOverviewCard cat={disabled} onToggleAvailability={toggle} />));
  expect(host.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('false');
  expect(host.textContent).toContain('已停用');
});

it('opens a focused member with Enter or Space but ignores keys from its child actions', async () => {
  const edit = vi.fn();
  await act(async () => root.render(<HubMemberOverviewCard cat={cat} onEdit={edit} onToggleAvailability={vi.fn()} />));
  const row = host.querySelector<HTMLElement>('[data-testid="cat-card-review-cat"]');
  await act(async () => {
    row?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    row?.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
  });
  expect(edit).toHaveBeenCalledTimes(2);
  await act(async () =>
    host.querySelector('[role="switch"]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
  );
  expect(edit).toHaveBeenCalledTimes(2);
});

it('keeps a status for read-only cards without presenting a fake edit or toggle action', async () => {
  await act(async () => root.render(<HubMemberOverviewCard cat={cat} />));
  expect(host.textContent).toContain('已启用');
  expect(host.querySelector('[role="switch"]')).toBeNull();
  expect(host.querySelector('[data-testid="cat-card-review-cat"]')?.hasAttribute('role')).toBe(false);
});
