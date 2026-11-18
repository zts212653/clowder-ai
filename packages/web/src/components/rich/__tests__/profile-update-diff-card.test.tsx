import type { RichCardBlock } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeShellLanguage } from '@/components/shell/shell-language';
import { ProfileUpdateCardContent, profileUpdateDiff } from '../ProfileUpdateCardContent';

describe('ProfileUpdateCardContent mechanical line diff', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal('React', React);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    writeShellLanguage('zh');
    vi.unstubAllGlobals();
  });

  const beforeCorpus = [
    '# 共享事实',
    ...Array.from({ length: 12 }, (_, i) => `- 既有条目 ${i + 1}`),
    '- 额度告急时先告知剩余比例，不要静默降档',
    ...Array.from({ length: 12 }, (_, i) => `- 中间条目 ${i + 1}`),
    '- 复杂概念先用分层图解把限定条件讲得更清楚',
  ].join('\n');

  const afterCorpus = [
    '# 共享事实',
    ...Array.from({ length: 12 }, (_, i) => `- 既有条目 ${i + 1}`),
    '- 额度告急时先告知剩余比例，不要静默降档的',
    ...Array.from({ length: 6 }, (_, i) => `- 中间条目 ${i + 1}`),
    '- 四支柱：everywhere / connect / grow / 主动',
    ...Array.from({ length: 6 }, (_, i) => `- 中间条目 ${i + 7}`),
    '- 复杂概念先用分层图解把限定条件讲清楚更清楚',
  ].join('\n');

  it('surfaces changed lines and intra-line character highlights on the first layer while keeping full content folded', async () => {
    const block: RichCardBlock = {
      id: 'profile-update-p1',
      kind: 'card',
      v: 1,
      title: '提议更新共享事实档案（corpus）',
      bodyMarkdown: [
        '补入四支柱原话',
        '',
        '**改动（+3 / -2 行）：**',
        '~~~diff',
        '@@ -14,1 +14,1 @@',
        '-- 额度告急时先告知剩余比例，不要静默降档',
        '+- 额度告急时先告知剩余比例，不要静默降档的',
        '~~~',
        '',
        '**当前内容：**',
        '```',
        beforeCorpus,
        '```',
        '',
        '**提议改为：**',
        '```',
        afterCorpus,
        '```',
      ].join('\n'),
      fields: [
        { label: '目标', value: 'corpus/shared-facts.md' },
        { label: '来源', value: 'cvo-instructed（You指示）' },
      ],
    };

    const parsed = profileUpdateDiff(block.bodyMarkdown ?? '');
    expect(parsed).toEqual({
      rationale: '补入四支柱原话',
      before: beforeCorpus,
      after: afterCorpus,
    });

    await act(async () => root.render(<ProfileUpdateCardContent block={block} />));

    const diffView = container.querySelector('[data-testid="profile-update-diff"]');
    expect(diffView).not.toBeNull();
    expect(diffView?.textContent).toContain('+3');
    expect(diffView?.textContent).toContain('2');
    expect(diffView?.textContent).toContain('四支柱：everywhere / connect / grow / 主动');

    // Unchanged distant lines do not appear in the visible diff view.
    expect(diffView?.textContent).not.toContain('既有条目 3');

    // Intra-line character changes ("的" and "得" -> "清楚") are explicitly marked with <del>/<ins>.
    const deletedSpans = [...(diffView?.querySelectorAll('del') ?? [])].map((el) => el.textContent);
    const insertedSpans = [...(diffView?.querySelectorAll('ins') ?? [])].map((el) => el.textContent);
    expect(deletedSpans).toContain('得');
    expect(insertedSpans).toContain('的');
    expect(insertedSpans).toContain('清楚');

    // Full before/after stays folded in original-approval-long-content.
    const disclosure = container.querySelector<HTMLDetailsElement>('[data-testid="original-approval-long-content"]');
    expect(disclosure).not.toBeNull();
    expect(disclosure?.open).toBe(false);
  });

  it('localizes diff chrome in English without leaking Chinese chrome labels on new cards', async () => {
    writeShellLanguage('en');
    const block: RichCardBlock = {
      id: 'profile-update-en',
      kind: 'card',
      v: 1,
      title: '提议更新共享事实档案（corpus）',
      bodyMarkdown: [
        'Add concise summary preference.',
        '',
        '**改动（+1 / -1 行）：**',
        '~~~diff',
        '@@ -1,1 +1,1 @@',
        '-Give background first.',
        '+State the result first.',
        '~~~',
        '',
        '**当前内容：**',
        '```',
        'Give background first.',
        '```',
        '',
        '**提议改为：**',
        '```',
        'State the result first.',
        '```',
      ].join('\n'),
      fields: [
        { label: '目标', value: 'corpus/shared-facts.md' },
        { label: '来源', value: 'cvo-instructed（You指示）' },
      ],
    };

    await act(async () => root.render(<ProfileUpdateCardContent block={block} />));
    expect(container.textContent).not.toMatch(/[\u3400-\u9fff]/u);
    const diffView = container.querySelector('[data-testid="profile-update-diff"]');
    expect(diffView?.textContent).toContain('Changes');
    expect(diffView?.textContent).toContain('Give background first.');
    expect(diffView?.textContent).toContain('State the result first.');
  });
});
