import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAILBOX_NAVIGATE_EVENT } from '@/components/shell/mailbox/mailbox-navigation';
import { SHELL_PRESENTATION_STORAGE_KEY } from '@/components/shell/shell-presentation';
import { openEvolutionApproval } from '../evolution-approval-navigation';

const data = vi.hoisted(() => ({ setWorkspaceMode: vi.fn(), dispatch: vi.fn() }));
vi.mock('@/stores/chatStore', () => ({
  useChatStore: { getState: () => ({ currentThreadId: 'thread-current', setWorkspaceMode: data.setWorkspaceMode }) },
}));
vi.mock('@/components/workbench/experience-workbench-store', () => ({
  useF307ExperienceWorkbenchStore: { getState: () => ({ dispatch: data.dispatch }) },
}));

describe('explicit evolution approval navigation', () => {
  const navigate = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    window.addEventListener(MAILBOX_NAVIGATE_EVENT, navigate);
  });
  afterEach(() => {
    window.removeEventListener(MAILBOX_NAVIGATE_EVENT, navigate);
    localStorage.removeItem(SHELL_PRESENTATION_STORAGE_KEY);
  });

  it('opens the exact approval directly in v2 without leaving an approval Workspace page', () => {
    localStorage.setItem(SHELL_PRESENTATION_STORAGE_KEY, 'v2');
    openEvolutionApproval('proposal/one');
    expect(navigate).toHaveBeenCalledOnce();
    expect((navigate.mock.calls[0][0] as CustomEvent).detail).toEqual({
      section: 'pending',
      proposalId: 'proposal/one',
    });
    expect(data.setWorkspaceMode).not.toHaveBeenCalled();
    expect(data.dispatch).not.toHaveBeenCalled();
  });

  it('keeps the classic approval Workspace destination and exact proposal', () => {
    localStorage.setItem(SHELL_PRESENTATION_STORAGE_KEY, 'classic');
    openEvolutionApproval('proposal/one');
    expect(navigate).not.toHaveBeenCalled();
    expect(data.setWorkspaceMode).toHaveBeenCalledWith('dev');
    expect(data.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'open-surface',
        surface: expect.objectContaining({
          resultTargetRef: {
            owner: 'f246-approval-navigation',
            key: encodeURIComponent(JSON.stringify(['thread-current', 'proposal/one'])),
          },
        }),
      }),
    );
  });
});
