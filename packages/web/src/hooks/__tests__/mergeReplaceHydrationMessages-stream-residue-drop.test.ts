import { describe, expect, it } from 'vitest';
import type { CatInvocationInfo, ChatMessage } from '../../stores/chat-types';
import { mergeReplaceHydrationMessages } from '../useChatHistory';
import {
  HISTORY_TURN_ID,
  makeA2AHandoffMessage,
  makeHistoryMessage,
  makeLocalResidue,
  makeMsg,
  makeToolEvent,
  NEXT_PARENT_INVOCATION_ID,
  PARENT_INVOCATION_ID,
  RESIDUE_TURN_ID,
} from './mergeReplaceHydrationMessages-stream-residue.fixtures';

describe('mergeReplaceHydrationMessages — stream residue drop cases', () => {
  it('drops unclaimed terminal tool-only msg-* stream residue when server history has matching stable tool evidence', () => {
    const history: ChatMessage[] = [makeHistoryMessage()];
    const current: ChatMessage[] = [makeLocalResidue()];

    const result = mergeReplaceHydrationMessages(history, current, {});

    expect(result.messages.map((msg) => msg.id)).toEqual(['0001781577227533-000193-f22d6fb6']);
    expect(result.stats.preservedLocalCount).toBe(0);
  });

  it('drops terminal residue when persisted sibling shares stable tool payload despite id and timestamp skew', () => {
    const history: ChatMessage[] = [
      makeMsg({
        id: '0001781577227533-000193-f22d6fb6',
        content: '我接 PR #931 的 Repo Inbox reconciliation，首反已处理。',
        toolEvents: [makeToolEvent('tool-server-random', { timestamp: 1781577227533 })],
        extra: {
          stream: {
            invocationId: PARENT_INVOCATION_ID,
            turnInvocationId: HISTORY_TURN_ID,
          },
        },
      }),
    ];
    const current: ChatMessage[] = [
      makeLocalResidue({
        toolEvents: [makeToolEvent('tool-client-random', { timestamp: 1781577280000 })],
      }),
    ];

    const result = mergeReplaceHydrationMessages(history, current, {});

    expect(result.messages.map((msg) => msg.id)).toEqual(['0001781577227533-000193-f22d6fb6']);
    expect(result.stats.preservedLocalCount).toBe(0);
  });

  it('drops terminal residue when persisted sibling evidence is split across same-turn records', () => {
    const resultTool = {
      type: 'tool_result' as const,
      label: 'command_execution result',
      detail: 'stdout: PR #931 labels updated',
    };
    const history: ChatMessage[] = [
      makeHistoryMessage(),
      makeMsg({
        id: '0001781577227534-000194-f22d6fb6',
        content: 'tool result persisted separately',
        toolEvents: [makeToolEvent('tool-server-result', resultTool)],
        extra: { stream: { invocationId: PARENT_INVOCATION_ID, turnInvocationId: HISTORY_TURN_ID } },
      }),
    ];
    const current: ChatMessage[] = [
      makeLocalResidue({
        toolEvents: [
          makeToolEvent('tool-client-use', { timestamp: 1781577280000 }),
          makeToolEvent('tool-client-result', { ...resultTool, timestamp: 1781577280500 }),
        ],
      }),
    ];

    const result = mergeReplaceHydrationMessages(history, current, {});

    expect(result.messages.map((msg) => msg.id).sort()).toEqual([
      '0001781577227533-000193-f22d6fb6',
      '0001781577227534-000194-f22d6fb6',
    ]);
    expect(result.stats.preservedLocalCount).toBe(0);
  });

  it('drops terminal residue when only another cat claims the shared parent invocation', () => {
    const history: ChatMessage[] = [makeHistoryMessage()];
    const current: ChatMessage[] = [
      makeLocalResidue({
        id: `msg-${PARENT_INVOCATION_ID}-codex`,
        extra: {
          stream: {
            invocationId: PARENT_INVOCATION_ID,
          },
        },
      }),
    ];
    const currentCatInvocations: Record<string, CatInvocationInfo> = {
      opus48: { invocationId: PARENT_INVOCATION_ID, turnInvocationId: '9ab9233d-8784-4472-a492-opus48turn' },
    };

    const result = mergeReplaceHydrationMessages(history, current, currentCatInvocations);

    expect(result.messages.map((msg) => msg.id)).toEqual(['0001781577227533-000193-f22d6fb6']);
    expect(result.stats.preservedLocalCount).toBe(0);
  });

  it('drops terminal residue when unrelated A2A boundaries belong to a different parent', () => {
    const history: ChatMessage[] = [
      makeMsg({
        id: '0001781577000000-000120-persisted-residue',
        content: 'same-turn residue already persisted',
        timestamp: 1781577000000,
        toolEvents: [makeToolEvent('tool-persisted-same-command', { timestamp: 1781577000100 })],
        extra: {
          stream: {
            invocationId: PARENT_INVOCATION_ID,
            turnInvocationId: HISTORY_TURN_ID,
          },
        },
      }),
      makeA2AHandoffMessage({
        id: 'a2a-1781577100000-unrelated-parent',
        timestamp: 1781577100000,
        extra: {
          systemKind: 'a2a_routing',
          a2aRouting: {
            fromCatId: 'opus48',
            targetCatId: 'codex',
            invocationId: NEXT_PARENT_INVOCATION_ID,
          },
        },
      }),
      makeMsg({
        id: '0001781577150000-000151-other-cat-unrelated-parent',
        catId: 'opus48',
        content: 'unrelated parallel assistant turn',
        timestamp: 1781577150000,
        toolEvents: undefined,
        extra: {
          stream: {
            invocationId: NEXT_PARENT_INVOCATION_ID,
            turnInvocationId: '9ab9233d-8784-4472-a492-opus48turn',
          },
        },
      }),
    ];
    const current: ChatMessage[] = [makeLocalResidue({ timestamp: 1781577227533 })];

    const result = mergeReplaceHydrationMessages(history, current, {});

    expect(result.messages.map((msg) => msg.id).sort()).toEqual([
      '0001781577000000-000120-persisted-residue',
      '0001781577150000-000151-other-cat-unrelated-parent',
      'a2a-1781577100000-unrelated-parent',
    ]);
    expect(result.stats.preservedLocalCount).toBe(0);
  });

  it('drops terminal residue when only a stale turnInvocationId remains after done cleared the parent invocation', () => {
    const history: ChatMessage[] = [makeHistoryMessage()];
    const current: ChatMessage[] = [makeLocalResidue()];
    const currentCatInvocations: Record<string, CatInvocationInfo> = {
      codex: { invocationId: undefined, turnInvocationId: RESIDUE_TURN_ID },
    };

    const result = mergeReplaceHydrationMessages(history, current, currentCatInvocations);

    expect(result.messages.map((msg) => msg.id)).toEqual(['0001781577227533-000193-f22d6fb6']);
    expect(result.stats.preservedLocalCount).toBe(0);
  });

  it('drops terminal residue when a later parent is active with the residue turn left behind', () => {
    const history: ChatMessage[] = [makeHistoryMessage()];
    const current: ChatMessage[] = [makeLocalResidue()];
    const currentCatInvocations: Record<string, CatInvocationInfo> = {
      codex: { invocationId: NEXT_PARENT_INVOCATION_ID, turnInvocationId: RESIDUE_TURN_ID },
    };

    const result = mergeReplaceHydrationMessages(history, current, currentCatInvocations);

    expect(result.messages.map((msg) => msg.id)).toEqual(['0001781577227533-000193-f22d6fb6']);
    expect(result.stats.preservedLocalCount).toBe(0);
  });
});
