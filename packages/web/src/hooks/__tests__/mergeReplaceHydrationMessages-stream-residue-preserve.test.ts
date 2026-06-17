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
  makeUserMessage,
  PARENT_INVOCATION_ID,
  RESIDUE_TURN_ID,
} from './mergeReplaceHydrationMessages-stream-residue.fixtures';

describe('mergeReplaceHydrationMessages — stream residue preserve cases', () => {
  it('preserves terminal tool-only msg-* stream residue when catch-up has no persisted sibling evidence yet', () => {
    const unrelatedHistory = makeMsg({
      id: '0001781577000000-000100-unrelated',
      content: 'previous turn under the same parent',
      toolEvents: [
        makeToolEvent('tool-unrelated-1', {
          detail: '/bin/zsh -lc "gh pr view 999 --repo zts212653/clowder-ai"',
        }),
      ],
      extra: {
        stream: {
          invocationId: PARENT_INVOCATION_ID,
          turnInvocationId: HISTORY_TURN_ID,
        },
      },
    });
    const current: ChatMessage[] = [makeLocalResidue({ toolEvents: [makeToolEvent('tool-race-only-1')] })];

    const result = mergeReplaceHydrationMessages([unrelatedHistory], current, {});

    expect(result.messages.map((msg) => msg.id).sort()).toEqual([
      '0001781577000000-000100-unrelated',
      `msg-${RESIDUE_TURN_ID}-codex`,
    ]);
    expect(result.stats.preservedLocalCount).toBe(1);
  });

  it('preserves terminal residue when persisted sibling covers only part of local tool payload', () => {
    const history: ChatMessage[] = [
      makeMsg({
        id: '0001781577227533-000193-f22d6fb6',
        content: 'partial persisted tool output',
        toolEvents: [makeToolEvent('tool-server-use', { timestamp: 1781577227533 })],
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
        toolEvents: [
          makeToolEvent('tool-client-use', { timestamp: 1781577280000 }),
          makeToolEvent('tool-client-result', {
            type: 'tool_result',
            label: 'command_execution result',
            detail: 'stdout: PR #931 labels updated',
            timestamp: 1781577280500,
          }),
        ],
      }),
    ];

    const result = mergeReplaceHydrationMessages(history, current, {});

    expect(result.messages.map((msg) => msg.id).sort()).toEqual([
      '0001781577227533-000193-f22d6fb6',
      `msg-${RESIDUE_TURN_ID}-codex`,
    ]);
    expect(result.stats.preservedLocalCount).toBe(1);
  });

  it('preserves terminal residue when persisted sibling has fewer duplicate tool payloads', () => {
    const duplicateTool = { detail: '/bin/zsh -lc "gh pr view 931 --repo zts212653/clowder-ai"' };
    const history: ChatMessage[] = [
      makeMsg({
        id: '0001781577227533-000193-f22d6fb6',
        content: 'one duplicate command persisted',
        toolEvents: [makeToolEvent('tool-server-once', duplicateTool)],
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
        toolEvents: [
          makeToolEvent('tool-client-first', { ...duplicateTool, timestamp: 1781577280000 }),
          makeToolEvent('tool-client-second', { ...duplicateTool, timestamp: 1781577280500 }),
        ],
      }),
    ];

    const result = mergeReplaceHydrationMessages(history, current, {});

    expect(result.messages.map((msg) => msg.id).sort()).toEqual([
      '0001781577227533-000193-f22d6fb6',
      `msg-${RESIDUE_TURN_ID}-codex`,
    ]);
    expect(result.stats.preservedLocalCount).toBe(1);
  });

  it('preserves terminal residue when matching persisted sibling is separated by a user turn boundary', () => {
    const history: ChatMessage[] = [
      makeMsg({
        id: '0001781577000000-000120-earlier-turn',
        content: 'earlier turn ran the same command',
        timestamp: 1781577000000,
        toolEvents: [makeToolEvent('tool-earlier-same-command', { timestamp: 1781577000100 })],
        extra: {
          stream: {
            invocationId: PARENT_INVOCATION_ID,
            turnInvocationId: '15e6b518-5046-4e29-8e3e-earlyturn',
          },
        },
      }),
      makeUserMessage(),
    ];
    const current: ChatMessage[] = [
      makeLocalResidue({
        timestamp: 1781577227533,
        toolEvents: [makeToolEvent('tool-later-same-command', { timestamp: 1781577227400 })],
      }),
    ];

    const result = mergeReplaceHydrationMessages(history, current, {});

    expect(result.messages.map((msg) => msg.id).sort()).toEqual([
      '0001781577000000-000120-earlier-turn',
      '0001781577100000-000150-user',
      `msg-${RESIDUE_TURN_ID}-codex`,
    ]);
    expect(result.stats.preservedLocalCount).toBe(1);
  });

  it('preserves terminal residue when the separating user boundary is still local-only', () => {
    const history: ChatMessage[] = [
      makeMsg({
        id: '0001781577000000-000120-earlier-turn',
        content: 'earlier persisted turn ran the same command',
        timestamp: 1781577000000,
        toolEvents: [makeToolEvent('tool-earlier-same-command', { timestamp: 1781577000100 })],
        extra: {
          stream: {
            invocationId: PARENT_INVOCATION_ID,
            turnInvocationId: '15e6b518-5046-4e29-8e3e-earlyturn',
          },
        },
      }),
    ];
    const current: ChatMessage[] = [
      makeUserMessage(),
      makeLocalResidue({
        timestamp: 1781577227533,
        toolEvents: [makeToolEvent('tool-later-same-command', { timestamp: 1781577227400 })],
      }),
    ];

    const result = mergeReplaceHydrationMessages(history, current, {});

    expect(result.messages.map((msg) => msg.id).sort()).toEqual([
      '0001781577000000-000120-earlier-turn',
      '0001781577100000-000150-user',
      `msg-${RESIDUE_TURN_ID}-codex`,
    ]);
    expect(result.stats.preservedLocalCount).toBe(2);
  });

  it('preserves terminal residue when same-parent A2A turns are separated by a routing handoff', () => {
    const history: ChatMessage[] = [
      makeMsg({
        id: '0001781577000000-000120-earlier-a2a-turn',
        content: 'earlier same-parent A2A turn ran the same command',
        timestamp: 1781577000000,
        toolEvents: [makeToolEvent('tool-earlier-a2a-same-command', { timestamp: 1781577000100 })],
        extra: {
          stream: {
            invocationId: PARENT_INVOCATION_ID,
            turnInvocationId: '15e6b518-5046-4e29-8e3e-earlyturn',
          },
        },
      }),
      makeA2AHandoffMessage(),
    ];
    const current: ChatMessage[] = [
      makeLocalResidue({
        timestamp: 1781577227533,
        toolEvents: [makeToolEvent('tool-later-a2a-same-command', { timestamp: 1781577227400 })],
      }),
    ];

    const result = mergeReplaceHydrationMessages(history, current, {});

    expect(result.messages.map((msg) => msg.id).sort()).toEqual([
      '0001781577000000-000120-earlier-a2a-turn',
      'a2a-1781577100000-codex-1',
      `msg-${RESIDUE_TURN_ID}-codex`,
    ]);
    expect(result.stats.preservedLocalCount).toBe(1);
  });

  it('preserves terminal residue when same-parent A2A turns are separated by another cat assistant turn', () => {
    const history: ChatMessage[] = [
      makeMsg({
        id: '0001781577000000-000120-earlier-a2a-turn',
        content: 'earlier same-parent A2A turn ran the same command',
        timestamp: 1781577000000,
        toolEvents: [makeToolEvent('tool-earlier-a2a-same-command', { timestamp: 1781577000100 })],
        extra: {
          stream: {
            invocationId: PARENT_INVOCATION_ID,
            turnInvocationId: '15e6b518-5046-4e29-8e3e-earlyturn',
          },
        },
      }),
      makeMsg({
        id: '0001781577100000-000151-other-cat',
        catId: 'opus48',
        content: 'another cat answered in the same A2A parent chain',
        timestamp: 1781577100000,
        toolEvents: undefined,
        extra: {
          stream: {
            invocationId: PARENT_INVOCATION_ID,
            turnInvocationId: '9ab9233d-8784-4472-a492-opus48turn',
          },
        },
      }),
    ];
    const current: ChatMessage[] = [
      makeLocalResidue({
        timestamp: 1781577227533,
        toolEvents: [makeToolEvent('tool-later-a2a-same-command', { timestamp: 1781577227400 })],
      }),
    ];

    const result = mergeReplaceHydrationMessages(history, current, {});

    expect(result.messages.map((msg) => msg.id).sort()).toEqual([
      '0001781577000000-000120-earlier-a2a-turn',
      '0001781577100000-000151-other-cat',
      `msg-${RESIDUE_TURN_ID}-codex`,
    ]);
    expect(result.stats.preservedLocalCount).toBe(1);
  });

  it('preserves contentful wrong-key stream residue as a non-goal to avoid deleting partial text', () => {
    const history: ChatMessage[] = [makeHistoryMessage()];
    const current: ChatMessage[] = [makeLocalResidue({ content: 'partial stdout that history did not claim yet' })];

    const result = mergeReplaceHydrationMessages(history, current, {});

    expect(result.messages.map((msg) => msg.id).sort()).toEqual([
      '0001781577227533-000193-f22d6fb6',
      `msg-${RESIDUE_TURN_ID}-codex`,
    ]);
    expect(result.stats.preservedLocalCount).toBe(1);
  });

  it('preserves empty msg-* stream residue while the live cat invocation still claims it', () => {
    const history: ChatMessage[] = [makeHistoryMessage()];
    const current: ChatMessage[] = [makeLocalResidue()];
    const currentCatInvocations: Record<string, CatInvocationInfo> = {
      codex: { invocationId: PARENT_INVOCATION_ID, turnInvocationId: RESIDUE_TURN_ID },
    };

    const result = mergeReplaceHydrationMessages(history, current, currentCatInvocations);

    expect(result.messages.map((msg) => msg.id).sort()).toEqual([
      '0001781577227533-000193-f22d6fb6',
      `msg-${RESIDUE_TURN_ID}-codex`,
    ]);
    expect(result.stats.preservedLocalCount).toBe(1);
  });
});
