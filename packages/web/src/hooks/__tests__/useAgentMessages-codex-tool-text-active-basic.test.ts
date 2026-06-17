import { describe, expect, it } from 'vitest';
import { deriveBubbleId } from '@/debug/bubbleIdentity';
import { getActiveBubble } from '@/hooks/thread-runtime-ledger';
import { getThreadRuntimeLedger } from '@/hooks/thread-runtime-singleton';
import { useChatStore } from '@/stores/chatStore';
import { flatCodexStreamBubbles, installActiveHarness } from './useAgentMessages-codex-tool-text-convergence.helpers';

const THREAD = 'thread-1';

function tool(parent: string, ts: number, turn?: string) {
  return {
    type: 'tool_use' as const,
    catId: 'codex' as const,
    threadId: THREAD,
    toolName: 'shell',
    toolInput: { command: 'rg --files' },
    invocationId: parent,
    ...(turn ? { turnInvocationId: turn } : {}),
    timestamp: ts,
  };
}

function text(parent: string, content: string, ts: number, turn?: string) {
  return {
    type: 'text' as const,
    catId: 'codex' as const,
    threadId: THREAD,
    content,
    origin: 'stream' as const,
    invocationId: parent,
    ...(turn ? { turnInvocationId: turn } : {}),
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

describe('Codex active path — tool work-log + text converge', () => {
  const harness = installActiveHarness();

  it('[real shape] tool_use + text both carrying turn id stay ONE stream bubble', () => {
    const PARENT = 'parent-inv-a2a';
    const TURN = 'turn-inv-codex';

    useChatStore.setState({
      catInvocations: { codex: { invocationId: PARENT, turnInvocationId: TURN } },
    });

    harness.render();
    harness.send(tool(PARENT, 1000, TURN));
    harness.send(text(PARENT, '我来查，不靠记忆猜。', 1100, TURN));

    const streamBubbles = flatCodexStreamBubbles();
    expect(streamBubbles).toHaveLength(1);
    expect(streamBubbles[0]!.content).toContain('我来查');
    expect(streamBubbles[0]!.toolEvents?.length ?? 0).toBeGreaterThan(0);
  });

  it('[multi-round-trip] two tool+text round-trips on one turn stay ONE stream bubble', () => {
    const PARENT = 'parent-inv-a2a';
    const TURN = 'turn-inv-codex';

    useChatStore.setState({
      catInvocations: { codex: { invocationId: PARENT, turnInvocationId: TURN } },
    });

    harness.render();
    harness.send(tool(PARENT, 1000, TURN));
    harness.send(text(PARENT, '先看一下。', 1050, TURN));
    harness.send({
      ...tool(PARENT, 1100, TURN),
      toolInput: { command: 'cat foo' },
    });
    harness.send(text(PARENT, '结论是这样的，详细说明……', 1150, TURN));

    const streamBubbles = flatCodexStreamBubbles();
    expect(streamBubbles).toHaveLength(1);
    expect(streamBubbles[0]!.content).toContain('先看一下');
    expect(streamBubbles[0]!.content).toContain('结论是这样的');
  });

  it('[race] tool_use before turn id resolvable + later text(turn) converge to ONE bubble', () => {
    const PARENT = 'parent-inv-a2a';
    const TURN = 'turn-inv-codex';

    harness.render();
    harness.send(tool(PARENT, 1000));
    harness.send(invocationCreated(PARENT, TURN));
    harness.send(text(PARENT, '我来查，不靠记忆猜。', 1100, TURN));

    const streamBubbles = flatCodexStreamBubbles();
    expect(streamBubbles).toHaveLength(1);
    expect(streamBubbles[0]!.content).toContain('我来查');
    expect(streamBubbles[0]!.toolEvents?.length ?? 0).toBeGreaterThan(0);
  });

  it('[race + immediate usage] writes usage to the turn-rebound work-log bubble', () => {
    const PARENT = 'parent-inv-a2a';
    const TURN = 'turn-current-usage';

    harness.render();
    harness.send(tool(PARENT, 1000));
    harness.send(invocationCreated(PARENT, TURN));

    expect(getActiveBubble(getThreadRuntimeLedger(), THREAD, 'codex')).toMatchObject({
      messageId: deriveBubbleId(TURN, 'codex', () => 'unused'),
      invocationId: PARENT,
      seedSource: 'bound',
    });

    harness.send({
      type: 'system_info' as const,
      catId: 'codex' as const,
      threadId: THREAD,
      content: JSON.stringify({
        type: 'invocation_usage',
        usage: { inputTokens: 123, outputTokens: 7, cacheReadTokens: 99 },
        model: 'gpt-5.5',
        provider: 'openai',
      }),
      invocationId: PARENT,
      turnInvocationId: TURN,
      timestamp: 1060,
    });

    const currentTurn = useChatStore
      .getState()
      .messages.find((m) => m.type === 'assistant' && m.extra?.stream?.turnInvocationId === TURN);

    expect(currentTurn).toBeDefined();
    expect(currentTurn!.metadata).toMatchObject({
      model: 'gpt-5.5',
      provider: 'openai',
      usage: { inputTokens: 123, outputTokens: 7, cacheReadTokens: 99 },
    });
  });

  it('[text-first race] text-created parent-only seed stays fresh for later tool events', () => {
    const PARENT = 'parent-text-first';
    const TURN = 'turn-text-first';

    harness.render();
    harness.send(text(PARENT, '先说一句。', 1000));
    harness.send(tool(PARENT, 1010));
    harness.send(invocationCreated(PARENT, TURN));
    harness.send(text(PARENT, '继续补充。', 1100, TURN));

    const streamBubbles = flatCodexStreamBubbles();
    expect(streamBubbles).toHaveLength(1);
    expect(streamBubbles[0]!.content).toContain('先说一句');
    expect(streamBubbles[0]!.content).toContain('继续补充');
    expect(streamBubbles[0]!.toolEvents?.length ?? 0).toBeGreaterThan(0);
    expect(streamBubbles[0]!.extra?.stream?.turnInvocationId).toBe(TURN);
  });
});
