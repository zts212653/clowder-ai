import { describe, expect, it } from 'vitest';
import { getActiveBubble } from '@/hooks/thread-runtime-ledger';
import { getThreadRuntimeLedger } from '@/hooks/thread-runtime-singleton';
import { useChatStore } from '@/stores/chatStore';
import { installActiveHarness, threadCodexStreamBubbles } from './useAgentMessages-codex-tool-text-convergence.helpers';

/**
 * F194 dual-path thread-switch regression — codex live bubble split (saga round 17 root cause).
 *
 * Real operator devtools sample (2026-06-17): a single codex A2A reply in thread Y
 * split into TWO bubbles because the operator's `currentThreadId` switched away
 * (Y → X) mid-reply. `handleAgentMessage` reads `currentThreadId` fresh per
 * message: events while viewing Y take the ACTIVE path; events after switching
 * away take the BACKGROUND path. codex tool/work-log events carry NO
 * `msg.turnInvocationId` (only `invocation_created` does), so the two paths
 * resolve the bubble's turn id from DIFFERENT sources:
 *   - active path binds the bubble to the live turn and records it in the
 *     per-thread runtime ledger keyed (threadId, codex).
 *   - background path `ensureBackgroundAssistantMessage` resolves the turn from
 *     `getThreadState(threadId).catInvocations[codex].turnInvocationId` ONLY. After
 *     the reply finalizes and a NEW codex invocation context lands a DIFFERENT
 *     (shadow) turn there, the late tool events derive a DIFFERENT bubble id →
 *     a second, empty work-log-only bubble → SPLIT.
 *
 * Reproduced end-state matches the real sample exactly:
 *   bubble A (active): id `msg-<persistedTurn>-codex`, the reply text, finalized.
 *   bubble B (background): id `msg-<shadowTurn>-codex`, EMPTY content, tool events,
 *     still streaming.
 * Both live in threadStates[Y].messages. F5 re-projects from the single persisted
 * record → self-heals to one, proving it is a live-reducer-only split.
 *
 * Z3 redline: the fix only aligns the fallback SOURCE when msg.turnInvocationId is
 * ABSENT (codex tool events). Genuinely different invocation_created turns keep
 * distinct ledger bubbles → distinct turns → stay separate.
 */
const THREAD_Y = 'thread-1'; // the reply thread (active harness default current thread)
const THREAD_X = 'thread-other'; // the thread the operator switches to mid-reply

const PARENT = 'ff1d8e85-50e8-4355-bb5f-b830f4bd59d5'; // shared parent invocationId (real sample)
const TURN = '1ba442cb-persisted'; // active/persisted turn id (matches the persisted record)
const SHADOW = 'ac378b26-shadow'; // live-only shadow turn that contaminated catInvocations

function toolY(ts: number, command: string, turn?: string) {
  return {
    type: 'tool_use' as const,
    catId: 'codex' as const,
    threadId: THREAD_Y,
    toolName: 'shell',
    toolInput: { command },
    invocationId: PARENT,
    ...(turn ? { turnInvocationId: turn } : {}),
    timestamp: ts,
  };
}

function textY(content: string, ts: number, turn?: string) {
  return {
    type: 'text' as const,
    catId: 'codex' as const,
    threadId: THREAD_Y,
    content,
    origin: 'stream' as const,
    invocationId: PARENT,
    ...(turn ? { turnInvocationId: turn } : {}),
    timestamp: ts,
  };
}

function invocationCreatedY(turn: string, ts: number) {
  return {
    type: 'system_info' as const,
    catId: 'codex' as const,
    threadId: THREAD_Y,
    content: JSON.stringify({ type: 'invocation_created', invocationId: turn, catId: 'codex' }),
    invocationId: PARENT,
    timestamp: ts,
  };
}

function doneY(ts: number, turn: string) {
  return {
    type: 'done' as const,
    catId: 'codex' as const,
    threadId: THREAD_Y,
    invocationId: PARENT,
    turnInvocationId: turn,
    timestamp: ts,
  };
}

/** Contaminate thread Y's per-thread catInvocations with a turn id (mimics a new codex invocation context). */
function setThreadYTurn(turn: string) {
  const state = useChatStore.getState();
  useChatStore.setState({
    threadStates: {
      ...state.threadStates,
      [THREAD_Y]: {
        ...state.getThreadState(THREAD_Y),
        catInvocations: { codex: { invocationId: PARENT, turnInvocationId: turn } },
      },
    },
  });
}

describe('Codex dual-path thread switch — one reply must stay ONE bubble', () => {
  const harness = installActiveHarness();

  it('[mid-reply thread switch] active bubble + streaming background tool events converge to ONE bubble', () => {
    // Live turn context for thread Y: catInvocations binds codex to PARENT/TURN.
    useChatStore.setState({
      catInvocations: { codex: { invocationId: PARENT, turnInvocationId: TURN } },
    });

    harness.render();

    // ── Phase 1: operator is VIEWING thread Y (active path) ──
    // codex streams text + a tool batch; active path binds them to TURN and records
    // the bound bubble in the per-thread runtime ledger keyed (Y, codex).
    harness.send(textY('我来查 OKF，不靠记忆猜。这里是这次回复的正文……', 1100, TURN));
    harness.send(toolY(1200, 'rg -n "OKF" packages/', TURN));

    expect(threadCodexStreamBubbles(THREAD_Y)).toHaveLength(1);
    expect(getActiveBubble(getThreadRuntimeLedger(), THREAD_Y, 'codex')).toMatchObject({
      messageId: `msg-${TURN}-codex`,
    });

    // ── Phase 2: operator SWITCHES away to thread X (mid codex reply) ──
    useChatStore.getState().setCurrentThread(THREAD_X);
    expect(useChatStore.getState().currentThreadId).toBe(THREAD_X);

    // ── Phase 3: the rest of the reply streams via the BACKGROUND path ──
    // A trailing stream chunk binds the background ref to the existing bubble.
    // The active runtime ledger for Y stays bound only while the bubble is still
    // streaming; `done` must clear it so later turns cannot inherit stale state.
    harness.send(textY(' 继续补充结论。', 1230, TURN));
    expect(getActiveBubble(getThreadRuntimeLedger(), THREAD_Y, 'codex')).toMatchObject({
      messageId: `msg-${TURN}-codex`,
    });

    // ── Phase 4: a NEW codex invocation context contaminates Y's per-thread turn ──
    // The background path reads getThreadState(Y).catInvocations — now a DIFFERENT
    // (shadow) turn, exactly the live-only id the real sample's split bubble carried.
    setThreadYTurn(SHADOW);

    // ── Phase 5: late tool events for the SAME Y reply arrive (background path) ──
    // codex tool events carry NO turnInvocationId. The background path must recover
    // the bound turn from the Y ledger; if it falls back to the per-thread shadow
    // turn instead, it derives msg-<SHADOW>-codex → a second, empty work-log bubble.
    harness.send(toolY(1300, "sed -n '1,220p' packages/web/foo.ts"));
    harness.send(toolY(1400, 'rg -n "split" packages/web/'));

    // The same codex reply must remain ONE bubble in thread Y, not split into a
    // separate shadow-turn work-log bubble.
    const bubblesY = threadCodexStreamBubbles(THREAD_Y);
    expect(bubblesY.map((m) => m.id)).not.toContain(`msg-${SHADOW}-codex`);
    expect(bubblesY).toHaveLength(1);
    expect(bubblesY[0]?.content).toContain('我来查 OKF');
    expect(bubblesY[0]?.toolEvents?.length).toBeGreaterThan(0);

    harness.send(doneY(1450, TURN));
    expect(getActiveBubble(getThreadRuntimeLedger(), THREAD_Y, 'codex')).toBeUndefined();
  });

  it('[background invocation_created] upgrades the active parent-only seed before late background tools arrive', () => {
    harness.render();

    // R18 recurrence: text/tool events create a parent-only seed while the operator
    // is viewing thread Y. Then the operator switches away BEFORE invocation_created
    // arrives, so invocation_created is handled by the BACKGROUND path. The old
    // #2349 guard only let later background tool events read the active ledger; it
    // did not let background invocation_created upgrade that active parent-only seed.
    harness.send(textY('第一段长回复正文，已经是用户可见内容。', 1100));
    harness.send(toolY(1110, 'rg -n "F194" packages/web'));

    let bubblesY = threadCodexStreamBubbles(THREAD_Y);
    expect(bubblesY).toHaveLength(1);
    expect(bubblesY[0]?.id).toBe(`msg-${PARENT}-codex`);
    expect(bubblesY[0]?.extra?.stream?.turnInvocationId).toBeUndefined();

    useChatStore.getState().setCurrentThread(THREAD_X);
    const TURN_BG = '8ac44fbc-background-turn';
    harness.send(invocationCreatedY(TURN_BG, 1120));

    bubblesY = threadCodexStreamBubbles(THREAD_Y);
    expect(bubblesY).toHaveLength(1);
    expect(bubblesY[0]?.content).toContain('第一段长回复正文');
    expect(bubblesY[0]?.id).toBe(`msg-${TURN_BG}-codex`);
    expect(bubblesY[0]?.extra?.stream?.turnInvocationId).toBe(TURN_BG);

    // A no-turn tool event that arrives while the bubble is still streaming should
    // still converge onto TURN_BG. If background invocation_created failed to
    // bridge the active ledger, catInvocations can drift to a shadow turn and this
    // creates the empty CLI-only split bubble seen in the screenshot.
    setThreadYTurn(SHADOW);
    harness.send(toolY(1140, 'sed -n "1,120p" packages/web/src/hooks/useAgentMessages.ts'));

    bubblesY = threadCodexStreamBubbles(THREAD_Y);
    expect(bubblesY.map((m) => m.id)).not.toContain(`msg-${SHADOW}-codex`);
    expect(bubblesY).toHaveLength(1);
    expect(bubblesY[0]?.toolEvents?.length ?? 0).toBeGreaterThan(1);

    harness.send(doneY(1150, TURN_BG));
    expect(getActiveBubble(getThreadRuntimeLedger(), THREAD_Y, 'codex')).toBeUndefined();
  });

  it('[ledger lifecycle] background done clears bound ledger entry before next-turn no-turn tools', () => {
    harness.render();

    harness.send(textY('streaming parent seed that will be upgraded. ', 1100));
    harness.send(toolY(1110, 'rg -n "F194" packages/web'));

    useChatStore.getState().setCurrentThread(THREAD_X);
    const TURN_BG = '8ac44fbc-background-turn';
    const TURN_NEXT = 'c8d2a1f9-next-turn';

    harness.send(invocationCreatedY(TURN_BG, 1120));

    let bubblesY = threadCodexStreamBubbles(THREAD_Y);
    expect(bubblesY).toHaveLength(1);
    expect(bubblesY[0]?.id).toBe(`msg-${TURN_BG}-codex`);
    expect(getActiveBubble(getThreadRuntimeLedger(), THREAD_Y, 'codex')).toMatchObject({
      messageId: `msg-${TURN_BG}-codex`,
    });

    harness.send(doneY(1130, TURN_BG));
    expect(getActiveBubble(getThreadRuntimeLedger(), THREAD_Y, 'codex')).toBeUndefined();

    setThreadYTurn(TURN_NEXT);
    harness.send(toolY(1140, 'rg -n "next turn without explicit turn" packages/web'));

    bubblesY = threadCodexStreamBubbles(THREAD_Y);
    expect(bubblesY.map((message) => message.id).sort()).toEqual(
      [`msg-${TURN_BG}-codex`, `msg-${TURN_NEXT}-codex`].sort(),
    );
    expect(bubblesY.find((message) => message.id === `msg-${TURN_BG}-codex`)?.isStreaming).toBe(false);
    expect(bubblesY.find((message) => message.id === `msg-${TURN_NEXT}-codex`)?.toolEvents).toHaveLength(1);
  });

  it('[background invocation_created] preserves the active parent seed when the turn bubble already exists', () => {
    harness.render();

    harness.send(textY('parent seed content that must survive. ', 1100));
    harness.send(toolY(1110, 'rg -n "F194" packages/web'));

    useChatStore.getState().setCurrentThread(THREAD_X);
    const TURN_BG = '8ac44fbc-background-turn';

    // A turn-stamped background chunk can create msg-<turn>-codex before the
    // delayed invocation_created event upgrades the active parent-only seed.
    harness.send(textY('turn bubble content that arrived first.', 1115, TURN_BG));

    let bubblesY = threadCodexStreamBubbles(THREAD_Y);
    expect(bubblesY.map((m) => m.id).sort()).toEqual([`msg-${PARENT}-codex`, `msg-${TURN_BG}-codex`].sort());

    harness.send(invocationCreatedY(TURN_BG, 1120));

    bubblesY = threadCodexStreamBubbles(THREAD_Y);
    expect(bubblesY).toHaveLength(1);
    expect(bubblesY[0]?.id).toBe(`msg-${TURN_BG}-codex`);
    expect(bubblesY[0]?.content).toContain('parent seed content that must survive');
    expect(bubblesY[0]?.content).toContain('turn bubble content that arrived first');
    expect(bubblesY[0]?.toolEvents?.length ?? 0).toBeGreaterThan(0);
  });

  it('[background invocation_created] preserves substring seed chunks during collision merge', () => {
    harness.render();

    harness.send(textY('OK', 1100));

    useChatStore.getState().setCurrentThread(THREAD_X);
    const TURN_BG = '8ac44fbc-background-turn';

    harness.send(textY('F says OK later.', 1115, TURN_BG));
    harness.send(invocationCreatedY(TURN_BG, 1120));

    const bubblesY = threadCodexStreamBubbles(THREAD_Y);
    expect(bubblesY).toHaveLength(1);
    expect(bubblesY[0]?.id).toBe(`msg-${TURN_BG}-codex`);
    expect(bubblesY[0]?.content).toBe('OKF says OK later.');
  });

  it('[background invocation_created] preserves replace-mode target text during collision merge', () => {
    harness.render();

    harness.send(textY('draft stale text', 1100));

    useChatStore.getState().setCurrentThread(THREAD_X);
    const TURN_BG = '8ac44fbc-background-turn';

    harness.send({
      ...textY('final answer', 1115, TURN_BG),
      textMode: 'replace' as const,
    });
    harness.send(invocationCreatedY(TURN_BG, 1120));

    const bubblesY = threadCodexStreamBubbles(THREAD_Y);
    expect(bubblesY).toHaveLength(1);
    expect(bubblesY[0]?.id).toBe(`msg-${TURN_BG}-codex`);
    expect(bubblesY[0]?.content).toBe('final answer');
  });

  it('[background invocation_created] keeps an existing finalized turn bubble finalized', () => {
    harness.render();

    harness.send(textY('parent seed content that must merge without reopening streaming. ', 1100));
    harness.send(toolY(1110, 'rg -n "F194" packages/web'));

    useChatStore.getState().setCurrentThread(THREAD_X);
    const TURN_BG = '8ac44fbc-background-turn';

    harness.send(textY('turn bubble content that finalized first.', 1115, TURN_BG));
    harness.send(doneY(1118, TURN_BG));

    let bubblesY = threadCodexStreamBubbles(THREAD_Y);
    const finalizedTurnBubble = bubblesY.find((message) => message.id === `msg-${TURN_BG}-codex`);
    expect(finalizedTurnBubble?.isStreaming).toBe(false);

    harness.send(invocationCreatedY(TURN_BG, 1120));

    bubblesY = threadCodexStreamBubbles(THREAD_Y);
    expect(bubblesY).toHaveLength(1);
    expect(bubblesY[0]?.id).toBe(`msg-${TURN_BG}-codex`);
    expect(bubblesY[0]?.content).toContain('parent seed content that must merge');
    expect(bubblesY[0]?.content).toContain('turn bubble content that finalized first');
    expect(bubblesY[0]?.isStreaming).toBe(false);
  });

  it('[background invocation_created] does not leave a finalized collision ref for later turns', () => {
    harness.render();

    harness.send(textY('parent seed content that merges into a finalized turn. ', 1100));
    harness.send(toolY(1110, 'rg -n "F194" packages/web'));

    useChatStore.getState().setCurrentThread(THREAD_X);
    const TURN_BG = '8ac44fbc-background-turn';
    const TURN_NEXT = 'c8d2a1f9-next-turn';

    harness.send(textY('turn bubble content that finalized first.', 1115, TURN_BG));
    harness.send(doneY(1118, TURN_BG));
    harness.send(invocationCreatedY(TURN_BG, 1120));

    let bubblesY = threadCodexStreamBubbles(THREAD_Y);
    expect(bubblesY).toHaveLength(1);
    expect(bubblesY[0]?.id).toBe(`msg-${TURN_BG}-codex`);
    expect(bubblesY[0]?.isStreaming).toBe(false);

    harness.send(toolY(1130, 'rg -n "next turn" packages/web', TURN_NEXT));

    bubblesY = threadCodexStreamBubbles(THREAD_Y);
    expect(bubblesY.map((message) => message.id).sort()).toEqual(
      [`msg-${TURN_BG}-codex`, `msg-${TURN_NEXT}-codex`].sort(),
    );
  });

  it('[background invocation_created] clears finalized collision active ledger before no-turn later tools', () => {
    harness.render();

    harness.send(textY('parent seed content that merges into a finalized turn. ', 1100));
    harness.send(toolY(1110, 'rg -n "F194" packages/web'));

    useChatStore.getState().setCurrentThread(THREAD_X);
    const TURN_BG = '8ac44fbc-background-turn';
    const TURN_NEXT = 'c8d2a1f9-next-turn';

    harness.send(textY('turn bubble content that finalized first.', 1115, TURN_BG));
    harness.send(doneY(1118, TURN_BG));
    harness.send(invocationCreatedY(TURN_BG, 1120));

    expect(getActiveBubble(getThreadRuntimeLedger(), THREAD_Y, 'codex')).toBeUndefined();

    setThreadYTurn(TURN_NEXT);
    harness.send(toolY(1130, 'rg -n "next turn without explicit turn" packages/web'));

    const bubblesY = threadCodexStreamBubbles(THREAD_Y);
    expect(bubblesY.map((message) => message.id).sort()).toEqual(
      [`msg-${TURN_BG}-codex`, `msg-${TURN_NEXT}-codex`].sort(),
    );
    expect(bubblesY.find((message) => message.id === `msg-${TURN_BG}-codex`)?.isStreaming).toBe(false);
    const nextTurnBubble = bubblesY.find((message) => message.id === `msg-${TURN_NEXT}-codex`);
    expect(nextTurnBubble?.toolEvents).toHaveLength(1);
  });

  it('[Z3 redline] genuinely different turns (each with its own invocation_created) stay SEPARATE', () => {
    // Two distinct codex turns on the SAME parent chain in thread Y. Each turn
    // carries its OWN explicit turnInvocationId on its events (real backend stamps
    // turn ids on text/invocation_created). The ledger-fallback fix must NOT
    // collapse them: distinct turns → distinct bound ledger bubbles → 2 bubbles.
    const TURN_A = '1ba442cb-turn-a';
    const TURN_B = '7c91ddee-turn-b';

    useChatStore.setState({
      catInvocations: { codex: { invocationId: PARENT, turnInvocationId: TURN_A } },
    });

    harness.render();

    // Turn A streams + finalizes while viewing Y (active path), bound to TURN_A.
    harness.send(textY('第一轮回复正文。', 1100, TURN_A));
    harness.send(toolY(1200, 'rg -n "first" packages/', TURN_A));
    harness.send({
      type: 'done' as const,
      catId: 'codex' as const,
      threadId: THREAD_Y,
      invocationId: PARENT,
      turnInvocationId: TURN_A,
      timestamp: 1250,
    });

    // A genuinely new turn B starts on the same parent — catInvocations advances.
    useChatStore.setState({
      catInvocations: { codex: { invocationId: PARENT, turnInvocationId: TURN_B } },
    });

    // Operator switches away; turn B's events arrive on the background path. Its
    // tool events carry TURN_B explicitly (msg.turnInvocationId wins — the fix's
    // ledger fallback only applies when the turn is ABSENT). Turn B must seed its
    // OWN bubble, NOT merge into turn A's finalized bubble.
    useChatStore.getState().setCurrentThread(THREAD_X);
    harness.send(toolY(1300, 'rg -n "second" packages/', TURN_B));
    harness.send(textY('第二轮回复正文。', 1400, TURN_B));

    const bubblesY = threadCodexStreamBubbles(THREAD_Y);
    expect(bubblesY).toHaveLength(2);
    const turnIds = bubblesY.map((m) => m.extra?.stream?.turnInvocationId).sort();
    expect(turnIds).toEqual([TURN_A, TURN_B].sort());
  });
});
