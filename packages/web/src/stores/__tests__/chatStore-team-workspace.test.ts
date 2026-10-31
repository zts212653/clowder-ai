import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_THREAD_STATE } from '../chat-types';
import { useChatStore } from '../chatStore';

describe('F293 Team Workspace navigation state', () => {
  beforeEach(() => {
    useChatStore.setState({
      currentThreadId: 'thread-a',
      threadStates: {
        'thread-a': { ...DEFAULT_THREAD_STATE },
        'thread-b': { ...DEFAULT_THREAD_STATE },
      },
      workspaceMode: 'dev',
      teamWorkspaceSubject: null,
      workspaceOpenRequest: null,
      workspaceOpenRevision: 0,
      rightPanelMode: 'status',
      rightPanelOpen: false,
      presentationLock: null,
    });
  });

  it('explicit open reveals Team and preserves the exact requested subject', () => {
    useChatStore.getState().openTeamSubject({ type: 'cat', id: 'codex-sol' });

    expect(useChatStore.getState()).toMatchObject({
      workspaceMode: 'team',
      teamWorkspaceSubject: { type: 'cat', id: 'codex-sol' },
      rightPanelMode: 'workspace',
      rightPanelOpen: true,
      workspaceOpenRevision: 1,
      workspaceOpenRequest: {
        revision: 1,
        threadId: 'thread-a',
        target: { kind: 'team', subject: { type: 'cat', id: 'codex-sol' } },
      },
    });
    expect(useChatStore.getState().threadStates['thread-a']).not.toHaveProperty('workspaceOpenRequest');
  });

  it('consumes only the matching transient request revision', () => {
    useChatStore.getState().openTeamSubject({ type: 'cat', id: 'codex-sol' });
    useChatStore.getState().consumeWorkspaceOpenRequest(0);
    expect(useChatStore.getState().workspaceOpenRequest?.revision).toBe(1);

    useChatStore.getState().consumeWorkspaceOpenRequest(1);
    expect(useChatStore.getState().workspaceOpenRequest).toBeNull();
  });

  it('an internal list/detail change never opens or steals the Workspace', () => {
    useChatStore.getState().setTeamWorkspaceSubject({ type: 'provider', id: 'openai' });

    expect(useChatStore.getState()).toMatchObject({
      workspaceMode: 'dev',
      teamWorkspaceSubject: { type: 'provider', id: 'openai' },
      rightPanelMode: 'status',
      rightPanelOpen: false,
      workspaceOpenRequest: null,
    });
  });

  it('restores the subject independently for each thread', () => {
    useChatStore.getState().openTeamSubject({ type: 'cat', id: 'codex-sol' });
    useChatStore.getState().setCurrentThread('thread-b');
    expect(useChatStore.getState().teamWorkspaceSubject).toBeNull();

    useChatStore.getState().openTeamSubject({ type: 'provider', id: 'anthropic' });
    useChatStore.getState().setCurrentThread('thread-a');
    expect(useChatStore.getState()).toMatchObject({
      workspaceMode: 'team',
      teamWorkspaceSubject: { type: 'cat', id: 'codex-sol' },
    });
  });
});
