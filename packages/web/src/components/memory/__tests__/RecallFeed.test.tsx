import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RecallCard } from '../RecallFeed';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('F321 recall row facts', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  it('shows observed reads without internal tags or attributing silence as refusal', async () => {
    await act(async () =>
      root.render(
        <RecallCard
          event={{
            id: 'one',
            query: 'F321',
            timestamp: 1,
            source: 'pull',
            outcome: 'used',
            resultCount: 2,
            resultStatus: 'counted',
            results: [
              { title: '已读取的功能', anchor: 'F321', sourceType: 'feature', consumed: true, matchRank: 'high' },
              { title: '另一条', anchor: 'F322', sourceType: 'feature', consumed: false },
            ],
          }}
        />,
      ),
    );
    expect(container.textContent).toContain('命中 2 条 · 之后读了 1 条');
    await act(async () => container.querySelector('button')?.click());
    expect(container.textContent).toContain('功能');
    expect(container.textContent).toContain('之后读了');
    expect(container.textContent).toContain('之后没看到读取');
    expect(container.textContent).toContain('打开');
    expect(container.textContent).not.toMatch(/push|pull|used|ign\.|忽略|\[match:/);
  });
  it('preserves unknown result count and never invents zero', async () => {
    await act(async () =>
      root.render(
        <RecallCard
          event={{
            id: 'two',
            query: '未合并',
            timestamp: 2,
            resultStatus: 'result_unmerged',
          }}
        />,
      ),
    );
    expect(container.textContent).toContain('结果没有记录下来');
    expect(container.textContent).not.toContain('没有命中');
  });
  it('names a generic context delivery without exposing the pipeline', async () => {
    await act(async () =>
      root.render(
        <RecallCard
          event={{
            id: 'three',
            query: 'session_bootstrap',
            timestamp: 3,
            source: 'push',
            pushSurface: 'session_bootstrap',
          }}
        />,
      ),
    );
    expect(container.textContent).toContain('通用上下文递送');
    expect(container.textContent).not.toContain('session_bootstrap');
  });
  it('names a delivered memory and its actual resolver family', async () => {
    await act(async () =>
      root.render(
        <RecallCard
          event={{
            id: 'cue',
            query: 'F322',
            timestamp: 1,
            cueStatus: 'applied',
            resolverFamily: 'project_knowledge',
            source: 'push',
            results: [{ title: 'F322: Everyday Work Experience', anchor: 'F322', sourceType: 'feature' }],
          }}
        />,
      ),
    );
    expect(container.textContent).toContain('F322: Everyday Work Experience');
    expect(container.textContent).toContain('点名递送 · 功能');
    expect(container.textContent).not.toContain('品味点名递送');
  });
  it('shows a plan title with a real destination and distinguishes a read failure from absence', async () => {
    await act(async () =>
      root.render(
        <RecallCard
          event={{
            id: 'plan',
            query: '计划',
            timestamp: 1,
            results: [
              { title: '已记录的计划', anchor: 'doc:plan', sourceType: 'plan' },
              { title: '', sourceType: 'taste', titleStatus: 'unavailable', href: '/invalid' },
              { title: '', sourceType: 'plan', href: null },
            ],
          }}
        />,
      ),
    );
    await act(async () => container.querySelector('button')?.click());
    expect(container.textContent).toContain('品味 · 暂时读不到标题');
    expect(container.textContent).toContain('计划 · 标题没有记录下来');
    expect(container.querySelectorAll('a')).toHaveLength(1);
    expect(container.querySelector('a')?.getAttribute('href')).toBe('/memory/search?q=doc%3Aplan');
  });
  it('keeps a pending cue title observable without inventing absence or a destination', async () => {
    await act(async () =>
      root.render(
        <RecallCard
          event={{
            id: 'pending-cue',
            query: '',
            timestamp: 1,
            cueStatus: 'presented_unreported',
            resolverFamily: 'project_knowledge',
            source: 'push',
            results: [{ title: '', sourceType: 'feature', titleStatus: 'loading', href: '/unverified' }],
          }}
        />,
      ),
    );
    expect(container.textContent).toContain('功能 · 正在读取标题…');
    expect(container.textContent).not.toContain('标题没有记录下来');
    await act(async () => container.querySelector('button')?.click());
    expect(container.querySelectorAll('a')).toHaveLength(0);
  });
  it.each([
    ['person-memory:person_7148', 'person_entity', '人物'],
    ['thread-thread_msrtefy', 'thread', '对话'],
  ])('does not expose an unresolved internal anchor as a title or link (%s)', async (anchor, sourceType, label) => {
    await act(async () =>
      root.render(
        <RecallCard
          event={{ id: 'missing', query: 'lookup', timestamp: 1, results: [{ title: anchor, anchor, sourceType }] }}
        />,
      ),
    );
    await act(async () => container.querySelector('button')?.click());
    expect(container.textContent).toContain(`${label} · 标题没有记录下来`);
    expect(container.textContent).not.toContain(anchor);
    expect(container.querySelectorAll('a')).toHaveLength(0);
  });

  it.each([
    ['person_entity', '人物'],
    ['operational_precedent', '经验先例'],
    ['taste', '品味'],
    ['profile', '画像'],
    ['event', '事件'],
    ['decision', '决策'],
    ['project_knowledge', '功能'],
    ['cat_owned_seed', '猫自己的种子'],
    ['thread_overview', '线程概况'],
  ] as const)('labels the actual %s delivery family', async (resolverFamily, label) => {
    await act(async () =>
      root.render(
        <RecallCard
          event={{
            id: 'family',
            query: '',
            timestamp: 1,
            cueStatus: 'presented_unreported',
            resolverFamily,
            results: [{ title: '递送的记忆', sourceType: resolverFamily }],
          }}
        />,
      ),
    );
    expect(container.textContent).toContain(`点名递送 · ${label} · 已递送·未回报`);
    expect(container.textContent).toContain('递送的记忆');
  });
});
