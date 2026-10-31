import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceSurfaceVisibilityProvider } from '@/components/workbench/WorkspaceSurfaceVisibility';
import { MailboxApprovalEntry } from '../MailboxApprovalEntry';
import { MAILBOX_NAVIGATE_EVENT } from '../mailbox-navigation';

describe('the legacy approval destination in a retained Workspace', () => {
  let host: HTMLDivElement;
  let root: Root;
  const navigate = vi.fn();
  const render = (visible: boolean, proposalId: string | null = null) =>
    act(() =>
      root.render(
        <WorkspaceSurfaceVisibilityProvider visible={visible}>
          <MailboxApprovalEntry proposalId={proposalId} />
        </WorkspaceSurfaceVisibilityProvider>,
      ),
    );

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    navigate.mockClear();
    window.addEventListener(MAILBOX_NAVIGATE_EVENT, navigate);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    window.removeEventListener(MAILBOX_NAVIGATE_EVENT, navigate);
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('does not open the mailbox when a background approval page is restored', () => {
    render(false, 'old-proposal');
    expect(host.textContent).toContain('在待办中打开');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('does not steal focus when a background page changes its selected proposal', () => {
    render(false, 'old-proposal');
    navigate.mockClear();
    render(false, 'new-proposal');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('does not open the mailbox when a restored approval page becomes visible', () => {
    render(false, 'selected-proposal');
    navigate.mockClear();
    render(true, 'selected-proposal');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('does not reopen a dismissed mailbox on rerender or when leaving approvals', () => {
    render(true, 'selected-proposal');
    navigate.mockClear();
    render(true, 'selected-proposal');
    render(false, 'selected-proposal');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('does not open on a visible mount and preserves the explicit reopen button', () => {
    render(true, 'selected-proposal');
    expect(navigate).not.toHaveBeenCalled();
    navigate.mockClear();
    act(() => host.querySelector<HTMLButtonElement>('button')?.click());
    expect(navigate).toHaveBeenCalledTimes(1);
    expect((navigate.mock.calls[0][0] as CustomEvent).detail.proposalId).toBe('selected-proposal');
  });
});
