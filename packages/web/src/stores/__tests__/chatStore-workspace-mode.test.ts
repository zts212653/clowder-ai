import { beforeEach, describe, expect, it } from 'vitest';
import { useChatStore } from '../chatStore';

describe('chatStore workspaceMode', () => {
  beforeEach(() => {
    useChatStore.setState({ workspaceMode: 'dev', rightPanelMode: 'status' });
  });

  it('setWorkspaceMode accepts tasks mode', () => {
    const { setWorkspaceMode } = useChatStore.getState();
    setWorkspaceMode('tasks');
    expect(useChatStore.getState().workspaceMode).toBe('tasks');
    expect(useChatStore.getState().rightPanelMode).toBe('workspace');
  });

  it('setWorkspaceMode still works for existing modes', () => {
    const { setWorkspaceMode } = useChatStore.getState();
    for (const mode of ['dev', 'recall', 'schedule', 'tasks'] as const) {
      setWorkspaceMode(mode);
      expect(useChatStore.getState().workspaceMode).toBe(mode);
      expect(useChatStore.getState().rightPanelMode).toBe('workspace');
    }
  });
});
