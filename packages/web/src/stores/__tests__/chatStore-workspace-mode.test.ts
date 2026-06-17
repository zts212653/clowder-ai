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

  // F232 AC-A8 修订：产物升为 workspaceMode，不再是 rightPanelMode
  it('setWorkspaceMode accepts artifacts mode', () => {
    const { setWorkspaceMode } = useChatStore.getState();
    setWorkspaceMode('artifacts');
    expect(useChatStore.getState().workspaceMode).toBe('artifacts');
    expect(useChatStore.getState().rightPanelMode).toBe('workspace');
  });

  // 云端 round 5 P2：workspace/transcript 被 ChatContainer auto-open effect 强制开，
  // 显式关闭必须先退出这两个 mode → status，否则 effect 立即重开（关不掉）。
  it('closeRightPanel exits workspace/transcript to status, leaves status unchanged', () => {
    const { closeRightPanel } = useChatStore.getState();
    for (const mode of ['workspace', 'transcript'] as const) {
      useChatStore.setState({ rightPanelMode: mode });
      closeRightPanel();
      expect(useChatStore.getState().rightPanelMode, `${mode} 关闭应退出到 status`).toBe('status');
    }
    // status 模式关闭后保留
    useChatStore.setState({ rightPanelMode: 'status' });
    closeRightPanel();
    expect(useChatStore.getState().rightPanelMode, 'status 关闭应保留').toBe('status');
  });
});
