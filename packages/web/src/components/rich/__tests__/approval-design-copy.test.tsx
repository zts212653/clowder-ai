import type { RichCardBlock } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { writeShellLanguage } from '@/components/shell/shell-language';
import { decisionResultCopy } from '../decision-result.shell-copy';
import { HandoffResultRow } from '../HandoffResultRow';
import { PersonMemoryOriginal, personMemoryOriginalBody } from '../PersonMemoryOriginal';
import { ProfileUpdateResult } from '../ProfileUpdateCardContent';
import { personMemoryCopy } from '../person-memory.shell-copy';
import { personMemoryResultLabel, personMemorySnapshotResult } from '../person-memory-result';
import { CLASSIC_RUNTIME_INTERACTION_COPY } from '../RuntimeInteractionCopy';
import { RuntimeInteractionRequestDetails } from '../RuntimeInteractionRequestDetails';
import { runtimeDecisionResult } from '../runtime-decision-result';
import { approvalRequest, record } from './runtime-interaction-test-fixtures';

let root: Root, container: HTMLDivElement;
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
const block: RichCardBlock = {
  kind: 'card',
  v: 1,
  id: 'original',
  title: 'Original',
  fields: [{ label: '下一步', value: 'Keep the original draft' }],
};

for (const language of ['zh', 'en'] as const) {
  it(`${language} profile technical fields translate producer labels and preserve the exact proposed text`, async () => {
    writeShellLanguage(language);
    const profile = {
      ...block,
      fields: [
        { label: '目标', value: 'profile/primer.md' },
        { label: '来源', value: 'cat-declared（猫主动声明）' },
      ],
      bodyMarkdown: 'Because\n\n**当前内容：**\n```\n保持这句原文\n```\n\n**提议改为：**\n```\n提议里的中文\n```',
    };
    await act(async () => root.render(<ProfileUpdateResult block={profile} status="rejected" error={null} />));
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-expanded=false]')?.click());
    const technical = container.querySelector('details:not([data-testid])');
    const labels = [...(technical?.querySelectorAll('dt') ?? [])].map((element) => element.textContent);
    expect(labels).toEqual(language === 'en' ? ['Target path: ', 'Source: '] : ['目标路径：', '来源：']);
    expect(technical?.textContent).toContain(
      language === 'en' ? 'cat-declared (Proposed by the cat)' : 'cat-declared（猫主动声明）',
    );
    expect(container.textContent).toContain('保持这句原文');
    expect(container.textContent).toContain('提议里的中文');
    expect(container.querySelectorAll('form,input,textarea,select')).toHaveLength(0);
  });
  it(`${language} original person-memory labels follow the interface without rewriting the person's quotation`, async () => {
    writeShellLanguage(language);
    const original = {
      ...block,
      bodyMarkdown:
        '1. **Lin enjoys hiking**\n   类型：事实 · 来源：You 明确陈述\n   原话：“类型 / 来源 / 原话 / 范围 / 写入”',
      fields: [
        { label: '范围', value: '仅你的私人记忆' },
        { label: '写入', value: '在 Approval Hub 逐项勾选后自动完成' },
      ],
    };
    await act(async () => root.render(<PersonMemoryOriginal block={original} />));
    expect(container.textContent).toContain('类型 / 来源 / 原话 / 范围 / 写入');
    expect(container.textContent).not.toContain('Approval Hub');
    expect([...container.querySelectorAll('dt')].map((element) => element.textContent)).toEqual(
      language === 'en' ? ['Scope: ', 'Writing: '] : ['范围：', '写入：'],
    );
    expect(container.textContent).toContain(
      language === 'en' ? 'Type: Fact · Source: You explicitly stated' : '类型：事实 · 来源：You 明确陈述',
    );
    expect(container.querySelectorAll('form,button,input,select,textarea')).toHaveLength(0);
  });
  it.each([
    ['approved', '已同意 · 接力已发起', 'Approved · handoff started'],
    ['rejected', '已拒绝 · 当前会话继续', 'Declined · the current session continues'],
    ['profile', '已同意 · 已写入档案', 'Approved · written to your profile'],
  ] as const)(`${language} %s uses one truthful result and no duplicate in original details`, async (kind, zh, en) => {
    writeShellLanguage(language);
    await act(async () =>
      root.render(
        kind === 'profile' ? (
          <ProfileUpdateResult block={block} status="approved" error={null} />
        ) : (
          <HandoffResultRow block={block} status={kind} title="Original" error={null} />
        ),
      ),
    );
    const label = container.querySelector('[data-testid=decision-result-label]');
    expect(label?.textContent).toBe(language === 'zh' ? zh : en);
    expect(label?.classList.contains('truncate')).toBe(false);
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-expanded=false]')?.click());
    expect(container.querySelector('[data-testid=decision-result-details]')?.textContent).not.toContain(
      language === 'zh' ? zh : en,
    );
    expect(container.textContent).toContain('Keep the original draft');
    expect(container.querySelectorAll('input,select,textarea,form')).toHaveLength(0);
  });
  it(`${language} selection states only the canonical choice`, () => {
    const choice = record(approvalRequest(), 'answered', {
      status: 'answered',
      reasonCode: 'answered',
      settledAt: 2000,
      response: { kind: 'decision', decisionId: 'accept' },
    });
    expect(runtimeDecisionResult(choice, decisionResultCopy[language], CLASSIC_RUNTIME_INTERACTION_COPY).label).toBe(
      language === 'zh' ? '已选「Allow once」' : 'Chose “Allow once”',
    );
  });
  it(`${language} partial writes remain visibly successful after remaining drafts are declined`, () => {
    const snapshot = {
      proposalId: 'candidate',
      status: 'rejected',
      publicationState: 'anchored',
      approvalCardMessageId: 'm',
      hasRetainedWrites: true,
    } as const;
    expect(personMemorySnapshotResult(snapshot).status).toBe('approved');
    expect(
      personMemoryResultLabel('rejected', 'Lin', personMemoryCopy[language], decisionResultCopy[language], true, 2),
    ).toContain(language === 'zh' ? '已写入 2 条 · 其余没写' : 'Wrote 2 · rest declined');
  });
}
it('expanded provider choices are a read-only list with the actual choice marked', async () => {
  const terminal = {
    status: 'answered',
    reasonCode: 'answered',
    settledAt: 2000,
    response: { kind: 'decision', decisionId: 'accept' },
  } as const;
  await act(async () =>
    root.render(<RuntimeInteractionRequestDetails request={approvalRequest()} terminal={terminal} />),
  );
  expect(container.querySelectorAll('button,input,select,textarea,form')).toHaveLength(0);
  expect(container.querySelector('[data-selected=true]')?.textContent).toContain('Allow once');
  expect(container.querySelector('[data-selected=true]')?.textContent).toContain('✓');
  expect(container.textContent).toContain('Decline');
});

it('localizes the default owner label while preserving multiline source quotations', () => {
  const quote = 'Lin said:\n   类型：我的原话 · 来源：我的朋友\nKeep this exact.';
  const body = `1. **Draft**\n   类型：co-creator 判断 · 来源：co-creator 明确陈述\n   原话：“${quote}”`;
  const translated = personMemoryOriginalBody(body, true);
  expect(translated).toContain('Type: Owner assessment · Source: Owner explicitly stated');
  expect(translated).toContain(`Original words: “${quote}”`);
});
