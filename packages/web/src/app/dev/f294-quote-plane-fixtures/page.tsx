'use client';

import { useState } from 'react';
import { ChatMessageRow } from '@/components/ChatMessageRow';
import { MarkdownContent } from '@/components/MarkdownContent';
import { MessageActions } from '@/components/MessageActions';
import type { ChatMessage as ChatMessageData } from '@/stores/chat-types';

const DENSITY_MESSAGE: ChatMessageData = {
  id: 'f294-density-message',
  type: 'assistant',
  catId: 'codex-sol',
  content: '静止态不该为每条消息固定占一行动作条。',
  timestamp: 1_786_985_594_484,
  projectionSourceMessageIds: ['f294-density-message'],
};

/**
 * F294 quote-plane + resting-density fixtures.
 *
 * These live on their own page on purpose. The sibling
 * `/dev/f294-selection-toolbar-preview` hosts a deployment-admission probe whose
 * revision tracker is a per-document singleton, so any extra component mounted in
 * that document changes what the other guard observes. One guard, one document.
 */
export default function F294QuotePlaneFixtures() {
  const [selectionEnterCount, setSelectionEnterCount] = useState(0);

  return (
    <main className="min-h-screen bg-cafe-surface p-4" data-testid="f294-quote-plane-fixtures">
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
          timelineMessages={[DENSITY_MESSAGE]}
          getCatById={() => undefined}
          onEditCat={() => {}}
          onEditCoCreator={() => {}}
          selectionMode={false}
          selected={false}
          selectionEligible
          onEnterSelection={() => setSelectionEnterCount((count) => count + 1)}
          onToggleSelection={() => {}}
          forwardingDisabled={false}
          eager
        />
        <output data-testid="f294-density-enter-count">{selectionEnterCount}</output>
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
