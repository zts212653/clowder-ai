import type { ProviderSubexecutionSemanticEvent as ChildEvent } from '@cat-cafe/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  installReplyLayersActEnvironment,
  ReplyLayersHarness,
  streamReply,
  tool,
  uninstallReplyLayersActEnvironment,
} from '../../__tests__/ChatMessage-reply-layers.harness';
import { SHELL_LANGUAGE_STORAGE_KEY } from '../../shell/shell-language';

function event(id: string, overrides: Partial<ChildEvent> = {}): ChildEvent {
  return {
    v: 1,
    kind: 'subexecution',
    id,
    stage: 'started',
    occurredAt: 1000,
    subexecutionId: 'child-a',
    rootExecutionId: 'root',
    parentExecutionId: 'root',
    rootTurnId: 'root-turn',
    parentTurnId: 'root-turn',
    turnId: 'child-turn',
    agentPath: '/root/video_schema',
    nickname: 'Hooke',
    depth: 1,
    provenance: { provider: 'codex', carrier: 'app_server', nativeType: 'subAgentActivity' },
    ...overrides,
  };
}

const started = event('start');
const progress = event('progress', {
  stage: 'message',
  occurredAt: 2000,
  messagePhase: 'commentary',
  content: '核对模型字段。',
});
const latest = event('latest', {
  stage: 'message',
  occurredAt: 3000,
  messagePhase: 'commentary',
  content: '正在核对视频合同。',
});
const final = event('final', {
  stage: 'message',
  occurredAt: 4000,
  messagePhase: 'final_answer',
  content: '合同与回放一致。',
});
const done = event('done', { stage: 'completed', occurredAt: 5000 });

describe('accepted v2 subagents live in their mother reply record', () => {
  let h: ReplyLayersHarness;
  beforeAll(installReplyLayersActEnvironment);
  afterAll(uninstallReplyLayersActEnvironment);
  beforeEach(() => {
    h = new ReplyLayersHarness();
    h.enableV2();
  });
  afterEach(() => h.dispose());
  const render = (events: ChildEvent[], streaming = false, toolEvents = [tool('read', 'Read')]) => {
    const reply = streamReply({
      catId: 'codex-astra',
      isStreaming: streaming,
      toolEvents,
      metadata: { provider: 'openai', model: 'gpt-6-astra', subexecutionEvents: events },
    });
    h.render(reply);
    return reply;
  };
  const row = () => h.container.querySelector('[data-subexecution-id="child-a"]');

  it('leaves no subagent controls when there are no child events', () => {
    render([]);
    h.click('reply-record-toggle');
    expect(h.q('reply-subexecutions')).toBeNull();
    expect(h.q('reply-subexecution-summary')).toBeNull();
  });

  it('hides child content until the mother record is opened and removes the v2 root badge', () => {
    const reply = render([started, progress, latest], true);
    expect(h.container.querySelector('[data-agent-role="root"]')).toBeNull();
    expect(h.q('subexecution-activity')).toBeNull();
    expect(h.q('reply-subexecution-summary')?.getAttribute('data-full-summary')).toBe('子代理 1 · 1 个运行中');
    expect(h.q('reply-status')?.textContent).toBe('正在读文件');
    expect(row()).toBeNull();
    h.click('reply-record-toggle');
    expect(h.q('reply-record')?.contains(h.q('reply-subexecutions'))).toBe(true);
    expect(h.q('reply-subexecutions')?.getAttribute('data-quote-exclude')).toBe('true');
    expect(h.q('reply-subexecutions')?.textContent).not.toMatch(/\/root\/|depth |主 agent|子 agent/);
    h.run(() => row()?.querySelector<HTMLButtonElement>('button')?.click());
    expect(row()?.textContent).toContain('最新进展');
    expect(row()?.textContent).toContain(latest.content);
    expect(row()?.textContent).not.toContain(progress.content);
    expect(row()?.textContent).toContain('之前的 1 条进展');
    expect(reply.content).toBe('改好了登录页，截图见下。');
    expect(reply.metadata?.subexecutionEvents).toEqual([started, progress, latest]);
  });

  it('prioritizes the native final for completed work and restores all earlier entries', () => {
    const history = Array.from({ length: 12 }, (_, i) =>
      event(`history-${i}`, {
        stage: 'message',
        occurredAt: 1500 + i * 100,
        messagePhase: 'commentary',
        content: `原进展 ${i}`,
      }),
    );
    render([done, ...history.reverse(), final, started, final]);
    expect(h.q('reply-subexecution-summary')?.getAttribute('data-full-summary')).toBe('子代理 1 · 都完成了');
    h.click('reply-record-toggle');
    h.run(() => row()?.querySelector<HTMLButtonElement>('button')?.click());
    expect(row()?.textContent).toContain('最终回报');
    expect(row()?.textContent).toContain(final.content);
    expect(row()?.textContent).toContain('之前的 12 条进展');
    expect(row()?.textContent).not.toContain('原进展 0');
    h.run(() => row()?.querySelector<HTMLButtonElement>('[data-subexecution-history-toggle]')?.click());
    for (let i = 0; i < 12; i++) expect(row()?.textContent).toContain(`原进展 ${i}`);
    expect(row()?.querySelectorAll('[data-subexecution-message-phase="final_answer"]')).toHaveLength(1);
  });

  it('does not promote unknown-phase text to final or invent missing duration evidence', () => {
    render([event('unknown', { stage: 'message', messagePhase: 'unknown', content: '原消息阶段未知。' })]);
    h.click('reply-record-toggle');
    h.run(() => row()?.querySelector<HTMLButtonElement>('button')?.click());
    expect(row()?.textContent).toContain('消息阶段未确认');
    expect(row()?.textContent).not.toContain('最终回报');
    expect(row()?.querySelector('[data-subexecution-duration]')?.textContent).toBe('—');
  });

  it('uses real parent identity for nesting and aggregates running, failed and interrupted', () => {
    const b = event('child-b-start', {
      subexecutionId: 'child-b',
      parentExecutionId: 'child-a',
      agentPath: '/root/video_schema/bounds',
      nickname: 'Halley',
      depth: 2,
    });
    const failed = event('child-failed', {
      subexecutionId: 'child-c',
      stage: 'failed',
      agentPath: '/root/assets',
      nickname: 'Curie',
    });
    const interrupted = event('child-stopped', {
      subexecutionId: 'child-d',
      stage: 'interrupted',
      agentPath: '/root/export',
      nickname: 'Kepler',
    });
    render([failed, interrupted, b, done, started]);
    h.click('reply-record-toggle');
    const group = h.q('reply-subexecutions');
    expect(group?.textContent).toContain('子代理 4 · 1 个运行中 · 1 个失败 · 1 个已中断');
    const nested = group?.querySelector('[data-subexecution-id="child-b"]');
    expect(row()?.parentElement?.contains(nested ?? null)).toBe(true);
    expect(group?.textContent).not.toContain('都完成了');
    expect(group?.textContent).not.toMatch(/已取消|depth |\/root\//);
  });

  it('does not change the mother action to waiting merely because a child is running', () => {
    render([started], true, [tool('search', 'Grep', 'secret query')]);
    expect(h.q('reply-status')?.textContent).toBe('正在搜索');
    expect(h.q('reply-last-line')?.textContent).not.toContain('secret query');
    render([started], true, [tool('wait', 'wait_agent')]);
    expect(h.q('reply-status')?.textContent).toBe('正在等子代理');
  });

  it('localizes child groups and keeps classic rendering intact', () => {
    window.localStorage.setItem(SHELL_LANGUAGE_STORAGE_KEY, 'en');
    render([started, done]);
    expect(h.q('reply-subexecution-summary')?.getAttribute('data-full-summary')).toBe('Subagents 1 · All finished');
    h.dispose();
    h = new ReplyLayersHarness();
    render([started, progress, final, done]);
    expect(h.q('reply-layers')).toBeNull();
    expect(h.q('subexecution-activity')).not.toBeNull();
    expect(h.container.querySelector('[data-agent-role="root"]')).not.toBeNull();
  });
});
