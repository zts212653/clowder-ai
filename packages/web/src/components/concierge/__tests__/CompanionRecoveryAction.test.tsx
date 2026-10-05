import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionRecoveryAction } from '../CompanionRecoveryAction';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

it('keeps the same selected companion and reports failure until the Host confirms recovery', async () => {
  const restore = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  act(() => root.render(<CompanionRecoveryAction partnerName="宪宪" restore={restore} />));

  const button = container.querySelector('button') as HTMLButtonElement;
  expect(container.textContent).toContain('宪宪');
  await act(async () => button.click());
  expect(restore).toHaveBeenCalledOnce();
  expect(container.textContent).toContain('未能重新打开');
  expect(container.textContent).not.toContain('已恢复');
  expect(container.textContent).toContain('宪宪');

  await act(async () => button.click());
  expect(restore).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain('桌面猫猫球已恢复');
  expect(button.disabled).toBe(true);
});

it('admits only one restore call while the Host response is pending', async () => {
  let resolveRestore!: (recovered: boolean) => void;
  const restore = vi.fn(() => new Promise<boolean>((resolve) => (resolveRestore = resolve)));
  act(() => root.render(<CompanionRecoveryAction partnerName="砚砚" restore={restore} />));

  const button = container.querySelector('button') as HTMLButtonElement;
  act(() => {
    button.click();
    button.click();
  });
  expect(restore).toHaveBeenCalledOnce();
  expect(button.disabled).toBe(true);
  expect(container.textContent).not.toContain('已恢复');

  await act(async () => resolveRestore(false));
  expect(button.disabled).toBe(false);
  expect(container.textContent).toContain('未能重新打开');
});

it('keeps a thrown Host request in the retryable failure state', async () => {
  const restore = vi.fn().mockRejectedValue(new Error('Host unavailable'));
  act(() => root.render(<CompanionRecoveryAction partnerName={undefined} restore={restore} />));

  await act(async () => (container.querySelector('button') as HTMLButtonElement).click());
  expect(container.textContent).toContain('未能重新打开');
  expect(container.textContent).toContain('所选陪伴者保持不变');
});
