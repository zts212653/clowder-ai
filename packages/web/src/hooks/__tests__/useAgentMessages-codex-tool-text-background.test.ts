import { describe, expect, it } from 'vitest';
import { deriveBubbleId } from '@/debug/bubbleIdentity';
import type { ChatMessage } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import {
  installBackgroundHarness,
  threadCodexStreamBubbles,
} from './useAgentMessages-codex-tool-text-convergence.helpers';

const BG = 'thread-bg';

function bgTool(parent: string, ts = 1000) {
  return {
    type: 'tool_use' as const,
    catId: 'codex' as const,
    threadId: BG,
    toolName: 'shell',
    toolInput: { command: 'rg --files' },
    invocationId: parent,
    timestamp: ts,
  };
}

function bgText(parent: string, turn: string, content = '我来查，不靠记忆猜。', ts = 1100) {
  return {
    type: 'text' as const,
    catId: 'codex' as const,
    threadId: BG,
    content,
    origin: 'stream' as const,
    invocationId: parent,
    turnInvocationId: turn,
    timestamp: ts,
  };
}

function bgInvocationCreated(parent: string, turn: string, ts = 1050) {
  return {
    type: 'system_info' as const,
    catId: 'codex' as const,
    threadId: BG,
    content: JSON.stringify({ type: 'invocation_created', catId: 'codex', invocationId: turn }),
    invocationId: parent,
    turnInvocationId: turn,
    timestamp: ts,
  };
}

describe('Codex background path — tool work-log + text converge', () => {
  const bg = installBackgroundHarness();

  it('[bg race] tool_use before turn + invocation_created + text(turn) converge to ONE bubble', () => {
    const PARENT = 'parent-bg-a2a';
    const TURN = 'turn-bg-codex';

    bg.dispatchBg(bgTool(PARENT));
    bg.dispatchBg(bgInvocationCreated(PARENT, TURN));
    bg.dispatchBg(bgText(PARENT, TURN));

    const streamBubbles = threadCodexStreamBubbles(BG);
    expect(streamBubbles).toHaveLength(1);
    expect(streamBubbles[0]!.content).toContain('我来查');
    expect(streamBubbles[0]!.toolEvents?.length ?? 0).toBeGreaterThan(0);
  });

  it.each([
    {
      name: 'web_search',
      content: JSON.stringify({ type: 'web_search', count: 1 }),
      assertPlaceholder: (bubble: ChatMessage | undefined) => {
        expect(bubble?.toolEvents?.some((event) => event.label.includes('web_search'))).toBe(true);
      },
    },
    {
      name: 'thinking',
      content: JSON.stringify({ type: 'thinking', text: 'background thought' }),
      assertPlaceholder: (bubble: ChatMessage | undefined) => {
        expect(bubble?.thinking).toContain('background thought');
      },
    },
    {
      name: 'rich_block',
      content: JSON.stringify({ type: 'rich_block', block: { id: 'rb-bg-seed', kind: 'card', v: 1, title: 'seed' } }),
      assertPlaceholder: (bubble: ChatMessage | undefined) => {
        expect(bubble?.extra?.rich?.blocks.some((block) => block.id === 'rb-bg-seed')).toBe(true);
      },
    },
  ])('[bg system_info placeholder] $name seed is reused by pre-turn tool_use', ({ content, assertPlaceholder }) => {
    const PARENT = 'parent-bg-web-search';
    const TURN = 'turn-bg-web-search';

    useChatStore.setState({
      threadStates: {
        [BG]: {
          ...useChatStore.getState().getThreadState(BG),
          catInvocations: { codex: { invocationId: PARENT } },
        },
      },
    });

    bg.dispatchBg({
      type: 'system_info' as const,
      catId: 'codex' as const,
      threadId: BG,
      content,
      timestamp: 950,
    });
    bg.dispatchBg(bgTool(PARENT));
    bg.dispatchBg(bgInvocationCreated(PARENT, TURN));
    bg.dispatchBg(bgText(PARENT, TURN));

    const streamBubbles = threadCodexStreamBubbles(BG);
    expect(streamBubbles).toHaveLength(1);

    const bubble = streamBubbles[0];
    expect(bubble?.extra?.stream?.turnInvocationId).toBe(TURN);
    expect(bubble?.content).toContain('我来查');
    assertPlaceholder(bubble);
    expect(bubble?.toolEvents?.some((event) => event.label.includes('shell'))).toBe(true);
  });

  it('[bg race + same-parent earlier seed] isolates the residue; current turn seeds its OWN bubble', () => {
    const PARENT = 'parent-bg-shared';
    const TURN = 'turn-bg-current';

    useChatStore.getState().addMessageToThread(BG, {
      id: 'bg-earlier-seed',
      type: 'assistant',
      catId: 'codex',
      content: 'earlier background work-log',
      origin: 'stream',
      isStreaming: true,
      extra: { stream: { invocationId: PARENT } },
      timestamp: 900,
    });

    bg.dispatchBg(bgTool(PARENT));
    bg.dispatchBg(bgInvocationCreated(PARENT, TURN));
    bg.dispatchBg(bgText(PARENT, TURN));

    const streamBubbles = threadCodexStreamBubbles(BG);
    expect(streamBubbles).toHaveLength(2);

    const residue = streamBubbles.find((m) => m.id === 'bg-earlier-seed');
    expect(residue).toBeDefined();
    expect(residue!.content).toBe('earlier background work-log');
    expect(residue!.isStreaming).toBe(false);
    expect(residue!.toolEvents?.length ?? 0).toBe(0);

    const currentTurn = streamBubbles.find((m) => m.extra?.stream?.turnInvocationId === TURN);
    expect(currentTurn).toBeDefined();
    expect(currentTurn!.id).not.toBe('bg-earlier-seed');
    expect(currentTurn!.content).toContain('我来查');
    expect(currentTurn!.content).not.toContain('earlier background work-log');
    expect(currentTurn!.toolEvents?.length ?? 0).toBeGreaterThan(0);
  });

  it('[bg race + recovered background residue] does not reuse the recovered parent-only ref', () => {
    const PARENT = 'parent-bg-recovered';
    const TURN = 'turn-bg-current-recovered';
    const residueId = deriveBubbleId(PARENT, 'codex', () => 'unused');

    useChatStore.getState().addMessageToThread(BG, {
      id: residueId,
      type: 'assistant',
      catId: 'codex',
      content: 'recovered background work-log',
      origin: 'stream',
      isStreaming: true,
      extra: { stream: { invocationId: PARENT } },
      timestamp: 900,
    });
    bg.bgStreamRefs.set(`${BG}::codex`, {
      id: residueId,
      threadId: BG,
      catId: 'codex',
      seedSource: 'recovered',
    });

    bg.dispatchBg(bgTool(PARENT));
    bg.dispatchBg(bgInvocationCreated(PARENT, TURN));
    bg.dispatchBg(bgText(PARENT, TURN));

    const streamBubbles = threadCodexStreamBubbles(BG);
    expect(streamBubbles).toHaveLength(2);

    const residue = streamBubbles.find((m) => m.id === residueId);
    expect(residue).toBeDefined();
    expect(residue!.content).toBe('recovered background work-log');
    expect(residue!.isStreaming).toBe(false);
    expect(residue!.toolEvents?.length ?? 0).toBe(0);

    const currentTurn = streamBubbles.find((m) => m.extra?.stream?.turnInvocationId === TURN);
    expect(currentTurn).toBeDefined();
    expect(currentTurn!.id).not.toBe(residueId);
    expect(currentTurn!.content).toContain('我来查');
    expect(currentTurn!.content).not.toContain('recovered background work-log');
    expect(currentTurn!.toolEvents?.length ?? 0).toBeGreaterThan(0);
  });

  it('[bg invocation_created-first + stale fresh seed] requires current-boundary proof before upgrade', () => {
    const PARENT = 'parent-bg-stale-fresh';
    const TURN = 'turn-bg-current-fresh';
    const residueId = deriveBubbleId(PARENT, 'codex', () => 'unused');

    useChatStore.getState().addMessageToThread(BG, {
      id: residueId,
      type: 'assistant',
      catId: 'codex',
      content: 'stale fresh background work-log',
      origin: 'stream',
      isStreaming: true,
      extra: { stream: { invocationId: PARENT } },
      timestamp: 900,
    });
    bg.bgStreamRefs.set(`${BG}::codex`, {
      id: residueId,
      threadId: BG,
      catId: 'codex',
      seedSource: 'fresh-parent-seed',
    });

    bg.dispatchBg(bgInvocationCreated(PARENT, TURN));
    bg.dispatchBg(bgText(PARENT, TURN, 'current background text'));

    const streamBubbles = threadCodexStreamBubbles(BG);
    expect(streamBubbles).toHaveLength(2);

    const residue = streamBubbles.find((m) => m.id === residueId);
    expect(residue).toBeDefined();
    expect(residue!.content).toBe('stale fresh background work-log');
    expect(residue!.isStreaming).toBe(false);
    expect(residue!.extra?.stream?.turnInvocationId).toBeUndefined();

    const currentTurn = streamBubbles.find((m) => m.extra?.stream?.turnInvocationId === TURN);
    expect(currentTurn).toBeDefined();
    expect(currentTurn!.id).not.toBe(residueId);
    expect(currentTurn!.content).toContain('current background text');
    expect(currentTurn!.content).not.toContain('stale fresh background work-log');
  });
});
