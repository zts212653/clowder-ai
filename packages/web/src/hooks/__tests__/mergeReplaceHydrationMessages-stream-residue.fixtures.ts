import type { ChatMessage, ToolEvent } from '../../stores/chat-types';

export const HISTORY_TURN_ID = '73e66ec4-517b-45b9-9f53-37e2b34d9208';
export const RESIDUE_TURN_ID = 'e541d6bd-9a12-4413-8613-f2b6fe0d3c48';
export const PARENT_INVOCATION_ID = 'f2e5c7b6-a4cd-4610-9d75-89cd7a31f035';
export const NEXT_PARENT_INVOCATION_ID = '1c9d42a7-cb2f-4199-b8f9-9543cf5a9720';

export function makeToolEvent(id: string, overrides: Partial<ToolEvent> = {}): ToolEvent {
  return {
    id,
    type: 'tool_use',
    label: 'command_execution',
    detail: '/bin/zsh -lc "gh pr view 931 --repo zts212653/clowder-ai"',
    timestamp: 1781577227400,
    ...overrides,
  };
}

export function makeMsg(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'm-default',
    type: 'assistant',
    catId: 'codex',
    origin: 'stream',
    content: 'hello',
    timestamp: 1781577227533,
    ...overrides,
  };
}

export function makeUserMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: '0001781577100000-000150-user',
    type: 'user',
    content: 'please handle the next inbox item',
    timestamp: 1781577100000,
    ...overrides,
  };
}

export function makeA2AHandoffMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'a2a-1781577100000-codex-1',
    type: 'system',
    variant: 'info',
    content: '缅因猫 → 布偶猫 → 缅因猫',
    timestamp: 1781577100000,
    extra: {
      systemKind: 'a2a_routing',
      a2aRouting: {
        fromCatId: 'codex',
        targetCatId: 'opus48',
        invocationId: PARENT_INVOCATION_ID,
      },
    },
    ...overrides,
  };
}

export function makeHistoryMessage(): ChatMessage {
  return makeMsg({
    id: '0001781577227533-000193-f22d6fb6',
    content: '我接 PR #931 的 Repo Inbox reconciliation，首反已处理。',
    toolEvents: [makeToolEvent('tool-residue-1')],
    extra: {
      stream: {
        invocationId: PARENT_INVOCATION_ID,
        turnInvocationId: HISTORY_TURN_ID,
      },
    },
  });
}

export function makeLocalResidue(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return makeMsg({
    id: `msg-${RESIDUE_TURN_ID}-codex`,
    content: '',
    isStreaming: false,
    toolEvents: [makeToolEvent('tool-residue-1')],
    extra: {
      stream: {
        invocationId: PARENT_INVOCATION_ID,
        turnInvocationId: RESIDUE_TURN_ID,
      },
    },
    ...overrides,
  });
}
