import type { MessageSearchResponse, MessageSearchResult } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageSearchResults } from '../MessageSearchResults';

vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    cats: [
      { id: 'codex61-sol', displayName: '小太阳', avatar: '', color: { primary: '#58885d', secondary: '#c7dbcb' } },
    ],
    getCatById: (id: string) =>
      id === 'codex61-sol'
        ? { id, displayName: '小太阳', avatar: '', color: { primary: '#58885d', secondary: '#c7dbcb' } }
        : undefined,
  }),
}));

function hit(messageId: string, patch: Partial<MessageSearchResult> = {}): MessageSearchResult {
  return {
    threadId: 'current',
    messageId,
    threadTitle: '当前标题',
    speaker: 'codex61-sol',
    timestamp: 1790860800000,
    timelineOrderAt: 1790860800000,
    snippet: { text: '先讨论琴键。然后说阅读位置。第三句保留在原文。', start: 0, end: 28, source: 'body' },
    highlights: [{ start: 3, end: 5 }],
    match: 'lexical',
    contentRevision: 'revision',
    publiclyQuotable: true,
    ...patch,
  };
}
function answer(results = [hit('first'), hit('second')]): MessageSearchResponse {
  return {
    searchId: 'search-original',
    query: '琴键',
    results,
    meta: {
      scope: 'global',
      sort: 'time',
      requestedMode: 'hybrid',
      effectiveMode: 'lexical',
      degraded: true,
      degradeReason: 'embedding_unavailable',
      partial: false,
      hasMore: true,
      candidateLimit: 2000,
      semanticCandidatesLimited: false,
      sourceCoverage: 'unknown',
      freshness: 'unknown',
      response: { budgetChars: 24000, serializedChars: 1000, truncated: false, continuation: 'unavailable' },
    },
  };
}

describe('shared message results', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });
  const open = async (props: Partial<Parameters<typeof MessageSearchResults>[0]> = {}) => {
    const navigate = vi.fn();
    await act(async () =>
      root.render(
        <MessageSearchResults
          currentThreadId="current"
          status="ready"
          response={answer()}
          onNavigate={navigate}
          {...props}
        />,
      ),
    );
    return navigate;
  };

  it('keeps distinct messages in one thread and only navigates on an explicit click', async () => {
    const response = answer();
    const navigate = await open({ response });
    const buttons = [...host.querySelectorAll('button')].filter((b) => b.textContent?.includes('跳过去'));
    expect(buttons).toHaveLength(2);
    expect(navigate).not.toHaveBeenCalled();
    act(() => buttons[1].click());
    expect(navigate).toHaveBeenCalledExactlyOnceWith(response.results[1], response);
  });
  it('uses the same theme-driven cat nameplate as chat without inventing a cat for an unknown speaker', async () => {
    await open({ resolveSpeaker: () => '小太阳·砚砚' });
    const plate = host.querySelector<HTMLElement>('[data-testid="cat-nameplate"]');
    expect(plate?.dataset.catId).toBe('codex61-sol');
    expect(plate?.textContent).toContain('小太阳·砚砚');
    expect(plate?.style.backgroundImage).toContain('linear-gradient');
    expect(plate?.style.backgroundImage).toContain('var(--color-');
    await open({ response: answer([hit('unknown', { speaker: 'unknown-member' })]) });
    expect(host.querySelector('[data-testid="cat-nameplate"]')).toBeNull();
    expect(host.textContent).toContain('unknown-member');
  });
  it('labels system notices neutrally and never attributes them to the co-creator', async () => {
    await open({
      response: answer([
        hit('wake', {
          speaker: 'system',
          snippet: { text: '[定时任务] 持球唤醒。', start: 0, end: 12, source: 'body' },
        }),
      ]),
      resolveSpeaker: (speaker) => (speaker === 'user' ? 'You' : speaker),
    });
    expect(host.textContent).toContain('系统通知');
    expect(host.textContent).not.toContain('You');
    expect(host.querySelector('[data-testid="message-result-human-nameplate"]')).toBeNull();
    expect(host.querySelector('[data-testid="cat-nameplate"]')).toBeNull();
    expect(host.querySelector('button[aria-label="跳过去：系统通知 · 第1处"]')).not.toBeNull();
    await open({ response: answer([hit('human', { speaker: 'user' })]), resolveSpeaker: () => 'You' });
    expect(host.querySelector('[data-testid="message-result-human-nameplate"]')?.textContent).toBe('You');
  });
  it('keeps connector source and sender outside human and cat nameplates', async () => {
    await open({
      response: answer([
        hit('external', { speaker: 'connector', speakerLabel: 'Alpha Connector · Acceptance source' }),
      ]),
      resolveSpeaker: () => 'You',
    });
    expect(host.textContent).toContain('Alpha Connector · Acceptance source');
    expect(host.textContent).not.toContain('You');
    expect(host.querySelector('[data-testid="message-result-human-nameplate"]')).toBeNull();
    expect(host.querySelector('[data-testid="cat-nameplate"]')).toBeNull();
    expect(
      host.querySelector('button[aria-label="跳过去：Alpha Connector · Acceptance source · 第1处"]'),
    ).not.toBeNull();
    await open({ response: answer([hit('legacy', { speaker: 'connector' })]), resolveSpeaker: () => 'You' });
    expect(host.textContent).toContain('外部来源');
    expect(host.textContent).not.toContain('You');
  });
  it('preserves the complete canonical snippet and valid highlights as text', async () => {
    await open({ resolveSpeaker: () => '砚砚' });
    expect(host.textContent).toContain('砚砚');
    expect(host.querySelector('mark')?.textContent).toBe('琴键');
    expect(host.textContent).toContain('第三句保留在原文。');
    expect(host.textContent).toContain('然后说阅读位置。');
    const payload = '<img src=x onerror=alert(1)>原文。';
    await open({
      response: answer([
        hit('html', { snippet: { text: payload, start: 0, end: payload.length, source: 'body' }, highlights: [] }),
      ]),
    });
    expect(host.querySelector('[data-message-search-result] p img')).toBeNull();
    expect(host.querySelector('img[src="x"]')).toBeNull();
    expect(host.textContent).toContain(payload);
  });
  it.each([
    'closure.state 是 cancelled，先保留旧上下文。现在请点击右侧的确认完成按钮。',
    '先记录交接背景。再记录上一班安排。接班人会在夜间负责巡查。',
  ])('keeps late qualification evidence in a semantic snippet: %s', async (text) => {
    await open({
      response: answer([
        hit('qualified', {
          snippet: { text, start: 240, end: 240 + text.length, source: 'body' },
          match: 'semantic',
          highlights: [],
        }),
      ]),
    });
    expect(host.querySelector('[data-message-search-result] p')?.textContent).toBe(text);
    expect(host.querySelectorAll('mark')).toHaveLength(0);
  });
  it('keeps snippet-relative highlights after preceding sentence boundaries', async () => {
    const text = '版本 v2.7 已记录。前两句只提供背景。最后出现琴键证据。';
    const start = text.indexOf('琴键');
    const response = answer([
      hit('late-highlight', {
        snippet: { text, start: 300, end: 300 + text.length, source: 'body' },
        highlights: [{ start, end: start + 2 }],
      }),
    ]);
    const original = structuredClone(response);
    await open({ response });
    expect(host.querySelector('[data-message-search-result] p')?.textContent).toBe(text);
    expect(host.querySelector('mark')?.textContent).toBe('琴键');
    expect(response).toEqual(original);
  });
  it('does not manufacture lexical highlights for a semantic match', async () => {
    await open({ response: answer([hit('meaning', { match: 'semantic', highlights: [] })]) });
    expect(host.querySelectorAll('mark')).toHaveLength(0);
  });
  it('reports limited coverage and unknown freshness without claiming first in all history', async () => {
    await open();
    expect(host.textContent).toContain('本次结果中最早');
    expect(host.textContent).toContain('仅列出部分命中');
    expect(host.textContent).toContain('索引覆盖范围尚未确认');
    expect(host.textContent).toContain('最近消息可能尚未入索引');
    expect(host.textContent).toContain('当前使用关键词检索');
    expect(host.textContent).not.toContain('第一次');
    expect(host.textContent).not.toContain('全部搜了');
  });
  it('shows global provenance but omits per-row current scope repetition', async () => {
    const response = answer([hit('a'), hit('b', { threadId: 'elsewhere', threadTitle: '原设计对话' })]);
    await open({ response });
    expect(host.textContent).toContain('当前对话');
    expect(host.textContent).toContain('原设计对话');
    await open({
      response: { ...response, results: [hit('a')], meta: { ...response.meta, scope: 'thread', threadId: 'current' } },
    });
    expect(host.querySelector('[data-message-search-result]')?.textContent).not.toContain('当前对话');
  });
  it('sort controls request a new server query without changing navigation', async () => {
    const sort = vi.fn();
    const navigate = await open({ onSortChange: sort });
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent === '按相关')!;
    act(() => button.click());
    expect(sort).toHaveBeenCalledExactlyOnceWith('relevance');
    expect(navigate).not.toHaveBeenCalled();
  });
  it('forwarded readonly results expose no navigation or query actions', async () => {
    await open({ readonly: true, onSortChange: vi.fn(), resolveSpeaker: () => '砚砚' });
    expect(host.querySelectorAll('button')).toHaveLength(0);
    expect(host.textContent).toContain('砚砚');
  });
  it('keeps loading, empty, failed and inaccessible states separate', async () => {
    await open({ status: 'loading' });
    expect(host.textContent).toContain('正在搜索');
    expect(host.querySelector('[data-message-search-result]')).toBeNull();
    await open({ response: answer([]) });
    expect(host.textContent).toContain('本次检索未找到');
    const retry = vi.fn();
    await open({ status: 'error', onRetry: retry });
    expect(host.textContent).toContain('检索暂不可用');
    act(() => host.querySelector('button')!.click());
    expect(retry).toHaveBeenCalledOnce();
    await open({ status: 'forbidden' });
    expect(host.textContent).toContain('无法访问此检索范围');
    expect(host.textContent).not.toContain('未找到');
  });
  it('does not describe unfinished qualification as a completed empty search', async () => {
    const response = answer([]);
    response.meta.qualification = {
      status: 'partial',
      examined: 8,
      supported: 0,
      rejected: 2,
      indeterminate: 1,
      unassessed: 5,
    };
    await open({ response });
    expect(host.textContent).toContain('部分候选尚未核对完');
    expect(host.textContent).not.toContain('本次检索未找到相关消息');
  });
  it('reports unassessed candidates even when some qualified results are visible', async () => {
    const response = answer();
    response.meta.qualification = {
      status: 'partial',
      examined: 8,
      supported: 2,
      rejected: 0,
      indeterminate: 1,
      unassessed: 5,
    };
    await open({ response });
    expect(host.textContent).toContain('6 条候选尚未核对出结论');
  });
});
