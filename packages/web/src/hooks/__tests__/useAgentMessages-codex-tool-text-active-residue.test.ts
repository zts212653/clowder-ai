import { describe, expect, it } from 'vitest';
import { deriveBubbleId } from '@/debug/bubbleIdentity';
import { setActiveBubble } from '@/hooks/thread-runtime-ledger';
import { getThreadRuntimeLedger } from '@/hooks/thread-runtime-singleton';
import { useChatStore } from '@/stores/chatStore';
import { flatCodexStreamBubbles, installActiveHarness } from './useAgentMessages-codex-tool-text-convergence.helpers';

const THREAD = 'thread-1';

function tool(parent: string, ts: number) {
  return {
    type: 'tool_use' as const,
    catId: 'codex' as const,
    threadId: THREAD,
    toolName: 'shell',
    toolInput: { command: 'rg --files' },
    invocationId: parent,
    timestamp: ts,
  };
}

function text(parent: string, turn: string, content = '我来查，不靠记忆猜。', ts = 1100) {
  return {
    type: 'text' as const,
    catId: 'codex' as const,
    threadId: THREAD,
    content,
    origin: 'stream' as const,
    invocationId: parent,
    turnInvocationId: turn,
    timestamp: ts,
  };
}

function invocationCreated(parent: string, turn: string, ts = 1050) {
  return {
    type: 'system_info' as const,
    catId: 'codex' as const,
    threadId: THREAD,
    content: JSON.stringify({ type: 'invocation_created', catId: 'codex', invocationId: turn }),
    invocationId: parent,
    turnInvocationId: turn,
    timestamp: ts,
  };
}

describe('Codex active path — parent-only residue isolation', () => {
  const harness = installActiveHarness();

  it('[race + same-parent earlier seed] isolates the residue; current turn seeds its OWN bubble', () => {
    const PARENT = 'parent-shared';
    const TURN = 'turn-current';

    useChatStore.setState({
      messages: [
        {
          id: 'earlier-seed',
          type: 'assistant',
          catId: 'codex',
          content: 'earlier work-log',
          origin: 'stream',
          isStreaming: true,
          extra: { stream: { invocationId: PARENT } },
          timestamp: 900,
        },
      ],
    });

    harness.render();
    harness.send(tool(PARENT, 1000));
    harness.send(invocationCreated(PARENT, TURN));
    harness.send(text(PARENT, TURN));

    const streamBubbles = flatCodexStreamBubbles();
    expect(streamBubbles).toHaveLength(2);

    const residue = streamBubbles.find((m) => m.id === 'earlier-seed');
    expect(residue).toBeDefined();
    expect(residue!.content).toBe('earlier work-log');
    expect(residue!.isStreaming).toBe(false);
    expect(residue!.toolEvents?.length ?? 0).toBe(0);

    const currentTurn = streamBubbles.find((m) => m.extra?.stream?.turnInvocationId === TURN);
    expect(currentTurn).toBeDefined();
    expect(currentTurn!.id).not.toBe('earlier-seed');
    expect(currentTurn!.content).toContain('我来查');
    expect(currentTurn!.content).not.toContain('earlier work-log');
    expect(currentTurn!.toolEvents?.length ?? 0).toBeGreaterThan(0);
    expect(currentTurn!.isStreaming).toBe(true);
  });

  it('[race + recovered active residue] does not reuse the recovered parent-only ref', () => {
    const PARENT = 'parent-recovered-active';
    const TURN = 'turn-current-active';
    const residueId = deriveBubbleId(PARENT, 'codex', () => 'unused');

    useChatStore.setState({
      messages: [
        {
          id: residueId,
          type: 'assistant',
          catId: 'codex',
          content: 'recovered old work-log',
          origin: 'stream',
          isStreaming: true,
          extra: { stream: { invocationId: PARENT } },
          timestamp: 900,
        },
      ],
    });
    setActiveBubble(getThreadRuntimeLedger(), THREAD, 'codex', {
      messageId: residueId,
      invocationId: PARENT,
      seedSource: 'recovered',
    });

    harness.render();
    harness.send(tool(PARENT, 1000));
    harness.send(invocationCreated(PARENT, TURN));
    harness.send(text(PARENT, TURN));

    const streamBubbles = flatCodexStreamBubbles();
    expect(streamBubbles).toHaveLength(2);

    const residue = streamBubbles.find((m) => m.id === residueId);
    expect(residue).toBeDefined();
    expect(residue!.content).toBe('recovered old work-log');
    expect(residue!.isStreaming).toBe(false);
    expect(residue!.toolEvents?.length ?? 0).toBe(0);

    const currentTurn = streamBubbles.find((m) => m.extra?.stream?.turnInvocationId === TURN);
    expect(currentTurn).toBeDefined();
    expect(currentTurn!.id).not.toBe(residueId);
    expect(currentTurn!.content).toContain('我来查');
    expect(currentTurn!.content).not.toContain('recovered old work-log');
    expect(currentTurn!.toolEvents?.length ?? 0).toBeGreaterThan(0);
  });

  it('[invocation_created-first + recovered active residue] finalizes residue instead of upgrading it', () => {
    const PARENT = 'parent-created-first-recovered';
    const TURN = 'turn-created-first-current';
    const residueId = deriveBubbleId(PARENT, 'codex', () => 'unused');

    useChatStore.setState({
      messages: [
        {
          id: residueId,
          type: 'assistant',
          catId: 'codex',
          content: 'old active residue',
          origin: 'stream',
          isStreaming: true,
          extra: { stream: { invocationId: PARENT } },
          timestamp: 900,
        },
      ],
    });
    setActiveBubble(getThreadRuntimeLedger(), THREAD, 'codex', {
      messageId: residueId,
      invocationId: PARENT,
      seedSource: 'recovered',
    });

    harness.render();
    harness.send(invocationCreated(PARENT, TURN));
    harness.send(text(PARENT, TURN, 'current turn text'));

    const streamBubbles = flatCodexStreamBubbles();
    expect(streamBubbles).toHaveLength(2);

    const residue = streamBubbles.find((m) => m.id === residueId);
    expect(residue).toBeDefined();
    expect(residue!.content).toBe('old active residue');
    expect(residue!.isStreaming).toBe(false);
    expect(residue!.extra?.stream?.turnInvocationId).toBeUndefined();

    const currentTurn = streamBubbles.find((m) => m.extra?.stream?.turnInvocationId === TURN);
    expect(currentTurn).toBeDefined();
    expect(currentTurn!.id).not.toBe(residueId);
    expect(currentTurn!.content).toContain('current turn text');
    expect(currentTurn!.content).not.toContain('old active residue');
  });

  it('[invocation_created-first + stale fresh active seed] requires current-boundary proof before upgrade', () => {
    const PARENT = 'parent-created-first-stale-fresh';
    const TURN = 'turn-created-first-current-fresh';
    const residueId = deriveBubbleId(PARENT, 'codex', () => 'unused');

    useChatStore.setState({
      messages: [
        {
          id: residueId,
          type: 'assistant',
          catId: 'codex',
          content: 'old fresh active seed',
          origin: 'stream',
          isStreaming: true,
          extra: { stream: { invocationId: PARENT } },
          timestamp: 900,
        },
      ],
    });
    setActiveBubble(getThreadRuntimeLedger(), THREAD, 'codex', {
      messageId: residueId,
      invocationId: PARENT,
      seedSource: 'fresh-parent-seed',
    });

    harness.render();
    harness.send(invocationCreated(PARENT, TURN));
    harness.send(text(PARENT, TURN, 'current turn text'));

    const streamBubbles = flatCodexStreamBubbles();
    expect(streamBubbles).toHaveLength(2);

    const residue = streamBubbles.find((m) => m.id === residueId);
    expect(residue).toBeDefined();
    expect(residue!.content).toBe('old fresh active seed');
    expect(residue!.isStreaming).toBe(false);
    expect(residue!.extra?.stream?.turnInvocationId).toBeUndefined();

    const currentTurn = streamBubbles.find((m) => m.extra?.stream?.turnInvocationId === TURN);
    expect(currentTurn).toBeDefined();
    expect(currentTurn!.id).not.toBe(residueId);
    expect(currentTurn!.content).toContain('current turn text');
    expect(currentTurn!.content).not.toContain('old fresh active seed');
  });
});
