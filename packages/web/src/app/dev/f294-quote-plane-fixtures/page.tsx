'use client';

import { useEffect, useState } from 'react';
import { ChatMessageRow } from '@/components/ChatMessageRow';
import { CliOutputBlock } from '@/components/cli-output/CliOutputBlock';
import { MarkdownContent } from '@/components/MarkdownContent';
import { MessageActions } from '@/components/MessageActions';
import { RichBlocks } from '@/components/rich/RichBlocks';
import type { CatData } from '@/hooks/useCatData';
import type { ChatMessage as ChatMessageData } from '@/stores/chat-types';

const DENSITY_CAT: CatData = {
  id: 'codex-sol',
  displayName: '缅因猫 Sol',
  variantLabel: 'GPT-5.6 Sol',
  color: { primary: '#6b8f34', secondary: '#c8d8b5' },
  mentionPatterns: ['codex-sol'],
  clientId: 'openai',
  defaultModel: 'gpt-5.6-sol',
  avatar: '/avatars/codex.png',
  roleDescription: '小太阳型攻坚猫',
  personality: 'warm',
};

const DENSITY_MESSAGE: ChatMessageData = {
  id: 'f294-density-message',
  type: 'assistant',
  catId: 'codex-sol',
  content: '静止态不该为每条消息固定占一行动作条。[正文链接](https://example.com/f294-body-control)',
  timestamp: 1_786_985_594_484,
  projectionSourceMessageIds: ['f294-density-message'],
  metadata: { model: 'gpt-5.6-sol', provider: 'openai' },
  extra: {
    turnExecution: {
      invocationId: 'f294-density-invocation',
      parentInvocationId: 'f294-density-parent',
      executionKind: 'ordinary',
    },
  },
};

const DENSITY_FOLLOWUP_MESSAGE: ChatMessageData = {
  id: 'f294-density-followup-message',
  type: 'assistant',
  catId: 'codex-sol',
  content: '下一条长消息在 hover 时也不能把动作条倒着压到上一条消息的模型元数据。',
  timestamp: 1_786_985_954_484,
  projectionSourceMessageIds: ['f294-density-followup-message'],
  metadata: { model: 'gpt-5.6-sol', provider: 'openai' },
  extra: {
    turnExecution: {
      invocationId: 'f294-density-followup-invocation',
      parentInvocationId: 'f294-density-followup-parent',
      executionKind: 'ordinary',
    },
  },
};

const CLI_MARKDOWN_TABLE = [
  '| Surface | Status | Meaning |',
  '| --- | --- | --- |',
  '| Hub Browser Preview | `no_matching_client` | 不属于本 thread 的修复责任 |',
].join('\n');

/**
 * F294 quote-plane + resting-density fixtures.
 *
 * These live on their own page on purpose. The sibling
 * `/dev/f294-selection-toolbar-preview` hosts a deployment-admission probe whose
 * revision tracker is a per-document singleton, so any extra component mounted in
 * that document changes what the other guard observes. One guard, one document.
 */
export default function F294QuotePlaneFixtures() {
  const [hydrated, setHydrated] = useState(false);
  const [selectionEnterCount, setSelectionEnterCount] = useState(0);
  const [selectionEnterMessageId, setSelectionEnterMessageId] = useState('');

  useEffect(() => {
    setHydrated(true);
  }, []);

  return (
    <main
      className="min-h-screen bg-cafe-surface p-4"
      data-hydrated={hydrated ? 'true' : 'false'}
      data-testid="f294-quote-plane-fixtures"
    >
      {/* Collision fixture: the projection of this source keeps the leading blank lines, so the
          FIRST "foo" sits at 4..7 — exactly where Chromium reports a selection of the SECOND
          paragraph. The browser test measures those offsets so the API fixture stays a fact. */}
      <section data-testid="f294-quote-collision" data-context-quote-source="message">
        <MarkdownContent content={'\n\n\n\nfoo\n\nfoo'} />
      </section>

      {/* Canonical-bubble fixture: two persisted rows are rendered as two paragraphs inside one
          real MessageActions quote root. A selection may cross their block boundary and still
          needs the ordinary “转发…” affordance. */}
      <MessageActions
        message={{
          id: 'f294-cross-row-anchor',
          type: 'assistant',
          catId: 'codex-sol',
          content: 'foo\n\nfoo',
          timestamp: 1_786_985_594_485,
          projectionSourceMessageIds: ['f294-cross-row-anchor', 'f294-cross-row-sibling'],
        }}
        threadId="f294-quote-plane-fixtures"
      >
        <div data-testid="f294-cross-row-bubble">
          <p>foo</p>
          <p>foo</p>
        </div>
      </MessageActions>

      {/* Production CLI stdout is rendered as Markdown rather than raw preformatted text. The
          browser therefore selects visible table cells while durable evidence must explicitly
          name the readable projection instead of pretending those offsets belong to raw pipes. */}
      <MessageActions
        message={{
          id: 'f294-cli-markdown-message',
          type: 'assistant',
          catId: 'codex-sol',
          content: CLI_MARKDOWN_TABLE,
          timestamp: 1_786_985_594_487,
          projectionSourceMessageIds: ['f294-cli-markdown-message'],
        }}
        threadId="f294-quote-plane-fixtures"
      >
        <div data-testid="f294-cli-markdown-bubble">
          <CliOutputBlock
            events={[
              {
                id: 'f294-cli-markdown-text',
                kind: 'text',
                timestamp: 1_786_985_594_487,
                content: CLI_MARKDOWN_TABLE,
              },
            ]}
            status="done"
            defaultExpanded
          />
        </div>
      </MessageActions>

      {/* Regression fixture: RichBlocks appends its own excluded forwarding dock after the card.
          Selecting the card's final paragraph must not be mistaken for selecting that sibling UI. */}
      <MessageActions
        message={{
          id: 'f294-rich-last-line-message',
          type: 'assistant',
          catId: 'codex-sol',
          content: '卡片正文第一段\n\n已执行：最后一行仍然可以引用。',
          timestamp: 1_786_985_594_486,
          projectionSourceMessageIds: ['f294-rich-last-line-message'],
        }}
        threadId="f294-quote-plane-fixtures"
      >
        <div data-testid="f294-rich-last-line-bubble">
          <RichBlocks
            blocks={[
              {
                id: 'f294-rich-last-line-card',
                kind: 'card',
                v: 1,
                title: '最后一行引用回归',
                bodyMarkdown: '卡片正文第一段\n\n已执行：最后一行仍然可以引用。',
              },
            ]}
            messageId="f294-rich-last-line-message"
            sourceThreadId="f294-quote-plane-fixtures"
            sourceMessageIds={['f294-rich-last-line-message']}
          />
        </div>
      </MessageActions>

      {/* Character-reference fixture: the renderer decodes &copy;, so a reader sees TWO identical
          © glyphs. The projection must carry both or it reports a false uniqueness. */}
      <section data-testid="f294-entity-collision" data-context-quote-source="message">
        <MarkdownContent content={'&copy;\n\n©'} />
      </section>

      {/* Grammar fixtures: each source renders the SAME visible text twice, and each one is a
          case an approximation of Markdown grammar gets wrong. The browser guard asserts the
          production renderer really shows both occurrences. */}
      <section data-testid="f294-delimiter-collision" data-context-quote-source="message">
        <MarkdownContent content={'--\n\n`--`'} />
      </section>

      <section data-testid="f294-pipe-row-collision" data-context-quote-source="message">
        <MarkdownContent content={'a | b | c\n| --- |\n\n`| --- |`'} />
      </section>

      <section data-testid="f294-invalid-reference-collision" data-context-quote-source="message">
        <MarkdownContent content={'&#128;\n\n\ufffd'} />
      </section>

      {/* Generated-text fixture: the renderer numbers the footnote label itself, so `1` appears
          on screen twice while the Markdown source contains it once. Quoting is refused for
          such messages rather than anchored against a projection that cannot see the label. */}
      <section data-testid="f294-generated-text" data-context-quote-source="message">
        <MarkdownContent content={'正文[^a]\n\n[^a]: 脚注内容\n\n`1`'} />
      </section>

      <section data-testid="f294-density-source">
        <ChatMessageRow
          message={DENSITY_MESSAGE}
          threadId="f294-quote-plane-fixtures"
          timelineMessages={[DENSITY_MESSAGE, DENSITY_FOLLOWUP_MESSAGE]}
          getCatById={(id) => (id === DENSITY_CAT.id ? DENSITY_CAT : undefined)}
          onEditCat={() => {}}
          onEditCoCreator={() => {}}
          selectionMode={false}
          selected={false}
          selectionEligible
          onEnterSelection={(messageId) => {
            setSelectionEnterCount((count) => count + 1);
            setSelectionEnterMessageId(messageId);
          }}
          onToggleSelection={() => {}}
          forwardingDisabled={false}
          eager
        />
        <ChatMessageRow
          message={DENSITY_FOLLOWUP_MESSAGE}
          threadId="f294-quote-plane-fixtures"
          timelineMessages={[DENSITY_MESSAGE, DENSITY_FOLLOWUP_MESSAGE]}
          getCatById={(id) => (id === DENSITY_CAT.id ? DENSITY_CAT : undefined)}
          onEditCat={() => {}}
          onEditCoCreator={() => {}}
          selectionMode={false}
          selected={false}
          selectionEligible
          onEnterSelection={(messageId) => {
            setSelectionEnterCount((count) => count + 1);
            setSelectionEnterMessageId(messageId);
          }}
          onToggleSelection={() => {}}
          forwardingDisabled={false}
          eager
        />
        <output data-testid="f294-density-enter-count">{selectionEnterCount}</output>
        <output data-testid="f294-density-enter-message">{selectionEnterMessageId}</output>
      </section>

      <MessageActions
        message={{
          id: 'f294-chrome-message',
          type: 'assistant',
          catId: 'codex-sol',
          content: '正在渲染 Mermaid 图表...',
          timestamp: 1_786_985_594_483,
          projectionSourceMessageIds: ['f294-chrome-message'],
        }}
        threadId="f294-quote-plane-fixtures"
      >
        {/* Interface chrome painted inside the source root: a component's own state text.
            It must never become quotable evidence. */}
        <span data-quote-exclude data-testid="f294-chrome-text">
          正在渲染 Mermaid 图表...
        </span>
      </MessageActions>
    </main>
  );
}
