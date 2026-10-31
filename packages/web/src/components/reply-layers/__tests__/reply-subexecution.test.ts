import type { ProviderSubexecutionSemanticEvent as Event } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
import { projectReplySubexecutions } from '../reply-subexecution';

function event(id: string, patch: Partial<Event> = {}): Event {
  return {
    v: 1,
    kind: 'subexecution',
    id,
    stage: 'started',
    occurredAt: 100,
    subexecutionId: 'child',
    rootExecutionId: 'root',
    parentExecutionId: 'root',
    rootTurnId: 'root-turn',
    parentTurnId: 'root-turn',
    agentPath: '/root/original_task_id',
    depth: 1,
    provenance: { provider: 'codex', carrier: 'app_server', nativeType: 'subAgentActivity' },
    ...patch,
  };
}

describe('existing child identity and native phases drive the reply projection', () => {
  it('keeps carrier order for successive commentary with the same millisecond timestamp', () => {
    const projected = projectReplySubexecutions([
      event('start'),
      event('z-earlier', {
        stage: 'message',
        turnId: 'turn-a',
        occurredAt: 200,
        content: 'Earlier',
        messagePhase: 'commentary',
      }),
      event('a-latest', {
        stage: 'message',
        turnId: 'turn-a',
        occurredAt: 200,
        content: 'Latest',
        messagePhase: 'commentary',
      }),
    ]);
    expect(projected.roots[0]?.primary?.content).toBe('Latest');
    expect(projected.roots[0]?.earlier.map((entry) => entry.content)).toEqual(['Earlier']);
  });

  it('reopens a native turn appended after a terminal in the same millisecond', () => {
    const projected = projectReplySubexecutions([
      event('start'),
      event('terminal:child', { stage: 'completed', turnId: 'turn-a', occurredAt: 200 }),
      event('message:child', {
        stage: 'message',
        turnId: 'turn-b',
        occurredAt: 200,
        content: 'Resumed',
        messagePhase: 'commentary',
      }),
    ]);
    expect(projected.running).toBe(1);
    expect(projected.completed).toBe(0);
    expect(projected.roots[0]?.primary?.content).toBe('Resumed');
  });

  it('retains a terminal within its turn despite later-arriving messages, without mutating inputs', () => {
    const events = [
      event('end', { stage: 'completed', turnId: 'turn-a', occurredAt: 200 }),
      event('late', {
        stage: 'message',
        turnId: 'turn-a',
        occurredAt: 300,
        content: 'Original late progress',
        messagePhase: 'commentary',
      }),
      event('start'),
      event('end', { stage: 'completed', turnId: 'turn-a', occurredAt: 200 }),
    ];
    const snapshot = JSON.stringify(events);
    const projected = projectReplySubexecutions(events);
    expect(projected.completed).toBe(1);
    expect(projected.roots[0]?.messages).toHaveLength(1);
    expect(projected.roots[0]?.durationMs).toBe(100);
    expect(JSON.stringify(events)).toBe(snapshot);
  });

  it('reopens a completed child only when a different real child turn supplies new activity', () => {
    const events = [
      event('start'),
      event('final-a', {
        stage: 'message',
        turnId: 'turn-a',
        occurredAt: 150,
        content: 'Old final',
        messagePhase: 'final_answer',
      }),
      event('done-a', { stage: 'completed', turnId: 'turn-a', occurredAt: 200 }),
      event('progress-b', {
        stage: 'message',
        turnId: 'turn-b',
        occurredAt: 300,
        content: 'New progress',
        messagePhase: 'commentary',
      }),
    ];
    const projected = projectReplySubexecutions(events.reverse());
    expect(projected.running).toBe(1);
    expect(projected.completed).toBe(0);
    expect(projected.roots[0]?.primary?.content).toBe('New progress');
    expect(projected.roots[0]?.earlier.map((e) => e.content)).toEqual(['Old final']);
    expect(projected.roots[0]?.durationMs).toBe(200);
  });

  it('uses parent execution and root scope, never path or claimed depth, to establish nesting', () => {
    const projected = projectReplySubexecutions([
      event('parent', { subexecutionId: 'parent' }),
      event('child', { parentExecutionId: 'parent', depth: 0, agentPath: '/unrelated/path' }),
      event('foreign', {
        subexecutionId: 'foreign',
        rootTurnId: 'another-root-turn',
        parentExecutionId: 'parent',
        depth: 2,
      }),
      event('orphan', {
        subexecutionId: 'orphan',
        parentExecutionId: 'absent',
        agentPath: '/root/original_task_id/nested',
        depth: 32,
      }),
    ]);
    expect(projected.total).toBe(4);
    expect(projected.roots.map((g) => g.id)).toEqual(['parent', 'foreign', 'orphan']);
    expect(projected.roots.find((g) => g.id === 'parent')?.children.map((g) => g.id)).toEqual(['child']);
  });

  it('keeps cyclic identities visible without recursive rendering', () => {
    const projected = projectReplySubexecutions([
      event('a', { subexecutionId: 'a', parentExecutionId: 'b' }),
      event('b', { subexecutionId: 'b', parentExecutionId: 'a' }),
      event('self', { subexecutionId: 'self', parentExecutionId: 'self' }),
    ]);
    expect(projected.roots).toHaveLength(3);
    expect(projected.roots.every((g) => g.children.length === 0)).toBe(true);
  });

  it('does not borrow a previous final for an unknown-phase completed turn or invent a duration', () => {
    const projected = projectReplySubexecutions([
      event('old', { stage: 'message', turnId: 'old', content: 'Old final', messagePhase: 'final_answer' }),
      event('new', {
        stage: 'message',
        turnId: 'new',
        occurredAt: 200,
        content: 'Unconfirmed report',
        messagePhase: 'unknown',
      }),
      event('end', { stage: 'completed', turnId: 'new', occurredAt: 300 }),
    ]);
    expect(projected.roots[0]?.primary?.content).toBe('Unconfirmed report');
    expect(projected.roots[0]?.primary?.messagePhase).toBe('unknown');
    expect(projected.roots[0]?.durationMs).toBeNull();
    expect(projectReplySubexecutions([]).total).toBe(0);
  });
});
