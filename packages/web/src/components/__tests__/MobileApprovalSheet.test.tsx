import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MobileApprovalSheet } from '../MobileApprovalSheet';

vi.mock('../ApprovalPanel', () => ({
  ApprovalPanel: () => React.createElement('div', { 'data-testid': 'approval-panel-stub' }),
}));

describe('MobileApprovalSheet', () => {
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

  it('renders the real approval surface only while open', () => {
    act(() => root.render(<MobileApprovalSheet open={false} onClose={vi.fn()} />));
    expect(container.querySelector('[data-testid="mobile-approval-sheet"]')).toBeNull();

    act(() => root.render(<MobileApprovalSheet open onClose={vi.fn()} />));
    expect(container.querySelector('[data-testid="mobile-approval-sheet"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="approval-panel-stub"]')).toBeTruthy();
    expect(document.activeElement).toBe(container.querySelector('[aria-label="关闭审批中心"]'));
  });

  it('closes from the explicit button and Escape', () => {
    const onClose = vi.fn();
    act(() => root.render(<MobileApprovalSheet open onClose={onClose} />));

    act(() => {
      (container.querySelector('[aria-label="关闭审批中心"]') as HTMLButtonElement).click();
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
