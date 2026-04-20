import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RightStatusPanel, type RightStatusPanelProps } from '@/components/RightStatusPanel';

function render(props: RightStatusPanelProps): string {
  return renderToStaticMarkup(React.createElement(RightStatusPanel, props));
}

describe('RightStatusPanel', () => {
  it('renders status title, mode, and active cats', () => {
    const html = render({
      intentMode: 'execute',
      targetCats: ['opus', 'codex'],
      catStatuses: {
        opus: 'streaming',
        codex: 'done',
      },
      catInvocations: {},
      threadId: 'test-thread',
      messageSummary: {
        total: 12,
        assistant: 7,
        system: 3,
        evidence: 2,
        followup: 1,
      },
    });

    expect(html).toContain('状态栏');
    expect(html).toContain('当前模式');
    expect(html).toContain('执行');
    expect(html).toContain('当前调用');
    expect(html).toContain('消息统计');
    expect(html).toContain('布偶猫');
    expect(html).toContain('缅因猫');
    expect(html).toContain('12');
  });

  it('prefers activeInvocations over stale targetCats when provided by ChatContainer', () => {
    const html = render({
      intentMode: 'execute',
      targetCats: ['codex'],
      catStatuses: { codex: 'pending', dare: 'streaming' },
      catInvocations: {},
      activeInvocations: {
        'inv-dare-1': { catId: 'dare', mode: 'execute' },
      },
      hasActiveInvocation: true,
      threadId: 'thread-slot-priority',
      messageSummary: {
        total: 2,
        assistant: 1,
        system: 1,
        evidence: 0,
        followup: 0,
      },
    });

    expect(html).toContain('dare');
    expect(html).not.toContain('缅因猫');
  });

  it('shows "空闲" when no target cats', () => {
    const html = render({
      intentMode: null,
      targetCats: [],
      catStatuses: {},
      catInvocations: {},
      threadId: 'test-thread',
      messageSummary: {
        total: 0,
        assistant: 0,
        system: 0,
        evidence: 0,
        followup: 0,
      },
    });

    expect(html).toContain('空闲');
  });

  it('renders copyable invocation and session ids in active cats', () => {
    const invocationId = 'inv-1234567890abcdef';
    const sessionId = 'sess-1234567890abcdef';
    const html = render({
      intentMode: 'execute',
      targetCats: ['codex'],
      catStatuses: { codex: 'streaming' },
      catInvocations: {
        codex: {
          invocationId,
          sessionId,
          startedAt: Date.now(),
        },
      },
      threadId: 'thread-123',
      messageSummary: {
        total: 1,
        assistant: 1,
        system: 0,
        evidence: 0,
        followup: 0,
      },
    });

    expect(html).toContain('当前调用');
    // IDs are now behind a collapsible toggle (default collapsed in SSR)
    expect(html).toContain('▸ IDs');
    // The cat name and invocation section still render
    expect(html).toContain('缅因猫');
  });

  it('shows history cats that are not in current targetCats', () => {
    const html = render({
      intentMode: 'execute',
      targetCats: ['opus'],
      catStatuses: { opus: 'streaming' },
      catInvocations: {
        opus: { startedAt: Date.now() },
        codex: { startedAt: Date.now() - 60000, durationMs: 5000 },
      },
      threadId: 'thread-456',
      messageSummary: {
        total: 5,
        assistant: 3,
        system: 2,
        evidence: 0,
        followup: 0,
      },
    });

    expect(html).toContain('当前调用');
    expect(html).toContain('历史参与');
    expect(html).toContain('布偶猫');
  });

  it('shows non-target cat in 当前调用 when it has task progress', () => {
    const html = render({
      intentMode: 'execute',
      targetCats: ['opus'],
      catStatuses: { opus: 'streaming', codex: 'pending' },
      catInvocations: {
        opus: { startedAt: Date.now() },
        codex: {
          startedAt: Date.now() - 120000,
          taskProgress: {
            tasks: [{ id: 'c-1', subject: 'Review PR', status: 'in_progress', activeForm: 'Reviewing PR' }],
            lastUpdate: Date.now(),
            snapshotStatus: 'running',
          },
        },
      },
      threadId: 'thread-codex-plan',
      messageSummary: {
        total: 8,
        assistant: 5,
        system: 3,
        evidence: 0,
        followup: 0,
      },
    });

    expect(html).toContain('当前调用');
    expect(html).toContain('缅因猫');
    // F055: task progress now in 猫猫祟祟 panel, not in 当前调用
    expect(html).toContain('猫猫祟祟');
    expect(html).toContain('Reviewing PR');
  });

  it('keeps completed snapshots out of 当前调用', () => {
    const html = render({
      intentMode: 'execute',
      targetCats: ['opus'],
      catStatuses: { opus: 'streaming', codex: 'done' },
      catInvocations: {
        opus: { startedAt: Date.now() },
        codex: {
          startedAt: Date.now() - 120000,
          taskProgress: {
            tasks: [{ id: 'c-1', subject: 'Review PR', status: 'completed' }],
            lastUpdate: Date.now(),
            snapshotStatus: 'completed',
          },
        },
      },
      threadId: 'thread-codex-completed',
      messageSummary: {
        total: 8,
        assistant: 5,
        system: 3,
        evidence: 0,
        followup: 0,
      },
    });

    expect(html).toContain('当前调用');
    expect(html).toContain('布偶猫');
    // F055: completed plan folds in 猫猫祟祟
    expect(html).toContain('猫猫祟祟');
    expect(html).toContain('已完成 (1)');
  });

  it('keeps interrupted snapshots in 猫猫祟祟 with continue action', () => {
    const html = render({
      intentMode: 'execute',
      targetCats: ['opus'],
      catStatuses: { opus: 'streaming', codex: 'done' },
      catInvocations: {
        opus: { startedAt: Date.now() },
        codex: {
          startedAt: Date.now() - 120000,
          taskProgress: {
            tasks: [{ id: 'c-1', subject: 'Review PR', status: 'in_progress', activeForm: 'Reviewing PR' }],
            lastUpdate: Date.now(),
            snapshotStatus: 'interrupted',
          },
        },
      },
      threadId: 'thread-codex-interrupted',
      messageSummary: {
        total: 8,
        assistant: 5,
        system: 3,
        evidence: 0,
        followup: 0,
      },
    });

    expect(html).toContain('猫猫祟祟');
    expect(html).toContain('缅因猫');
    expect(html).toContain('已中断');
    expect(html).toContain('继续');
  });

  it('renders task progress in 猫猫祟祟 panel', () => {
    const html = render({
      intentMode: 'execute',
      targetCats: ['opus'],
      catStatuses: { opus: 'streaming' },
      catInvocations: {
        opus: {
          startedAt: Date.now(),
          taskProgress: {
            tasks: [
              { id: 'task-0', subject: 'Fix auth bug', status: 'completed' },
              { id: 'task-1', subject: 'Add caching', status: 'in_progress', activeForm: 'Adding caching' },
              { id: 'task-2', subject: 'Write tests', status: 'pending' },
            ],
            lastUpdate: Date.now(),
          },
        },
      },
      threadId: 'thread-789',
      messageSummary: {
        total: 3,
        assistant: 2,
        system: 1,
        evidence: 0,
        followup: 0,
      },
    });

    expect(html).toContain('猫猫祟祟');
    expect(html).toContain('1/3');
    expect(html).toContain('Fix auth bug');
    expect(html).toContain('Adding caching');
    expect(html).toContain('Write tests');
  });

  // clowder-ai#28: resize width prop regression tests
  it('renders with custom width via style attribute', () => {
    const html = render({
      intentMode: null,
      targetCats: [],
      catStatuses: {},
      catInvocations: {},
      threadId: 'test-thread',
      messageSummary: { total: 0, assistant: 0, system: 0, evidence: 0, followup: 0 },
      width: 350,
    });

    expect(html).toContain('width:350px');
  });

  it('falls back to 288px when width is omitted', () => {
    const html = render({
      intentMode: null,
      targetCats: [],
      catStatuses: {},
      catInvocations: {},
      threadId: 'test-thread',
      messageSummary: { total: 0, assistant: 0, system: 0, evidence: 0, followup: 0 },
    });

    expect(html).toContain('width:288px');
  });
});
