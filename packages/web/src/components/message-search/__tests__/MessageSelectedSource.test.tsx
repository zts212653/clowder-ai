import type { MessageSearchResult, MessageSourceSelection } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ChatReferenceScope } from '../../chat-references/ChatReferenceScope';
import { MessageSelectedSource } from '../MessageSelectedSource';

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function renderSelection(text: string, quote: string, patch: Partial<MessageSourceSelection> = {}) {
  const start = text.lastIndexOf(quote);
  const selection: MessageSourceSelection = {
    v: 1,
    quote,
    reason: '这句保留了执行条件',
    part: { kind: 'body' },
    range: { start, end: start + quote.length },
    sourceDigest: 'a'.repeat(64),
    headingPath: [],
    context: {
      text,
      start: 0,
      end: text.length,
      quoteStart: start,
      quoteEnd: start + quote.length,
      truncatedBefore: false,
      truncatedAfter: false,
    },
    ...patch,
  };
  const result: MessageSearchResult = {
    threadId: 'sources',
    messageId: 'source',
    threadTitle: '设计现场',
    speaker: 'user',
    timestamp: 1000,
    timelineOrderAt: 1000,
    snippet: { text: quote, start, end: start + quote.length, source: 'body' },
    highlights: [],
    match: 'selected',
    contentRevision: 'revision',
    publiclyQuotable: true,
    selection,
  };
  await act(async () =>
    root.render(
      <ChatReferenceScope value="enclosing-answer-thread">
        <MessageSelectedSource result={result} speaker="co-creator" resolveSpeaker={(id) => id} />
      </ChatReferenceScope>,
    ),
  );
}

it('shows only the hit paragraph of a long context and renders emphasis and inline code with the selected range highlighted', async () => {
  const quote = '只有 **全部通过** 才运行 `pnpm gate`';
  await renderSelection(
    `工具过程。${'无关日志。'.repeat(100)}\n\n建议${quote}，暂时不要发布。\n\n之后的过程。${'无关后续。'.repeat(100)}`,
    quote,
  );
  expect(host.textContent).toContain('建议只有 全部通过 才运行 pnpm gate，暂时不要发布。');
  expect(host.textContent).not.toMatch(/无关日志|工具过程|无关后续|之后的过程|\*\*|`/);
  expect(host.querySelector('strong')?.textContent).toBe('全部通过');
  expect(host.querySelector('code')?.textContent).toBe('pnpm gate');
  expect([...host.querySelectorAll('mark')].map((mark) => mark.textContent).join('')).toBe(
    '只有 全部通过 才运行 pnpm gate',
  );
});

it('cuts distant sentences while preserving the same-sentence condition and negation', async () => {
  await renderSelection(
    `${'很远的旧句。'.repeat(40)}建议只在测试全部通过后，才下线判官，不要提前发布。${'很远的后句。'.repeat(40)}`,
    '下线判官',
  );
  expect(host.textContent).toBe('…建议只在测试全部通过后，才下线判官，不要提前发布。…');
});

it('keeps every paragraph crossed by the selection and highlights the selected occurrence only', async () => {
  await renderSelection('前段不展示。\n\n同句。另一句同句。\n\n跨段终点。\n\n后段不展示。', '同句。\n\n跨段终点');
  expect(host.textContent).not.toMatch(/前段不展示|后段不展示/);
  expect([...host.querySelectorAll('mark')].map((mark) => mark.textContent).join('')).toBe('同句。跨段终点');
});

it('keeps exact highlight offsets after Markdown math normalization, escapes, entities and inline code', async () => {
  await renderSelection('公式 \\(x+1\\)；已转义 \\*星号\\* &amp; 表情🐾。重点 **只标这里**。', '只标这里');
  expect([...host.querySelectorAll('mark')].map((mark) => mark.textContent).join('')).toBe('只标这里');
  await renderSelection('同一段内，转义 \\*星号\\* &amp; 表情🐾，只标 `pnpm gate` 中间。', 'gate');
  expect(host.querySelector('code mark')?.textContent).toBe('gate');
  expect(host.textContent).toContain('只标 pnpm gate 中间');
  await renderSelection('到 `docs/config.md` 查看原话。', 'config');
  expect(host.querySelector('code mark')?.textContent).toBe('config');
  expect(host.querySelector('code')?.textContent).toBe('docs/config.md');
});

it('labels a selected publisher comment without spreading its unselected quoted material on the card', async () => {
  await renderSelection('这版还不能发布，等测试通过。', '还不能发布', {
    part: { kind: 'comment', blockIndex: 0 },
    quotation: { text: '不相关的整段引用材料。'.repeat(80), truncated: false },
  });
  expect(host.textContent).toContain('co-creator 当条批注：');
  expect(host.textContent).toContain('未核实原出处作者');
  expect(host.textContent).not.toContain('不相关的整段引用材料');
  expect(host.querySelector('mark')?.textContent).toBe('还不能发布');
});
