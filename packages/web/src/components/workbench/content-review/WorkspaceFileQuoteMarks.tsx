import type { WorkspaceFileQuoteReference } from '@cat-cafe/shared';
import Image from 'next/image';
import { type RefObject, useEffect, useRef, useState } from 'react';
import { openExactPlace } from '@/components/shell/mailbox/open-exact-place';
import { useShellCopy } from '@/components/shell/shell-copy';
import { useShellPresentation } from '@/components/shell/shell-presentation';
import { useCatData } from '@/hooks/useCatData';
import { useCoCreatorConfig } from '@/hooks/useCoCreatorConfig';
import { resolveCatDisplayName } from '@/lib/cat-display-name';
import { useChatStore } from '@/stores/chatStore';
import { useF307ExperienceWorkbenchStore } from '../experience-workbench-store';
import { observeWorkspaceQuoteLayout } from './observe-workspace-quote-layout';
import { useWorkspaceFileQuotes } from './useWorkspaceFileQuotes';
import { workspaceFileQuotesCopy } from './workspace-file-quotes.shell-copy';

const keyOf = (quote: WorkspaceFileQuoteReference) => `${quote.threadId}:${quote.messageId}:${quote.attachment.id}`;

function locatedLeaf(nodes: readonly HTMLElement[], text: string, quote: WorkspaceFileQuoteReference) {
  if (quote.state !== 'current' || !quote.anchor) return undefined;
  const line = text.slice(0, quote.anchor.start).split('\n').length;
  const node = nodes.filter((candidate) => Number(candidate.dataset.sourceLine) <= line).at(-1);
  return node ? { node, line } : undefined;
}

/** Authored messages stay with their owner. Only precisely located, current quotes get a mark beside the text. */
export function WorkspaceFileQuoteMarks({
  locator,
  revision,
  text,
  container,
  visible,
}: {
  locator: { worktreeId: string; path: string };
  revision: string;
  text: string;
  container: RefObject<HTMLDivElement | null>;
  visible: boolean;
}) {
  const read = useWorkspaceFileQuotes(locator, revision, visible);
  const t = useShellCopy(workspaceFileQuotesCopy);
  const isV2 = useShellPresentation() === 'v2';
  const { getCatById } = useCatData({ fetch: false });
  const human = useCoCreatorConfig();
  const list = useRef<HTMLDetailsElement>(null);
  const [positions, setPositions] = useState<readonly { line: string; keys: readonly string[]; top: number }[]>([]);
  useEffect(() => {
    const paper = container.current,
      parent = paper?.parentElement;
    if (!paper || !parent || !visible) {
      setPositions([]);
      return;
    }
    const measure = () => {
      const paperRect = paper.getBoundingClientRect(),
        parentRect = parent.getBoundingClientRect();
      const nodes = [...paper.querySelectorAll<HTMLElement>('[data-source-line]')];
      const groups = new Map<string, { line: string; keys: string[]; top: number }>();
      for (const quote of read.quotes) {
        const located = locatedLeaf(nodes, text, quote);
        if (!located) continue;
        const { node, line } = located;
        const rect = node.getBoundingClientRect();
        if (rect.bottom <= paperRect.top || rect.top >= paperRect.bottom) continue;
        const groupKey = node.dataset.sourceLine ?? String(line);
        const group = groups.get(groupKey) ?? {
          line: groupKey,
          keys: [],
          top: Math.max(paperRect.top, rect.top) - parentRect.top,
        };
        group.keys.push(keyOf(quote));
        groups.set(groupKey, group);
      }
      const next = [...groups.values()];
      setPositions((previous) => (JSON.stringify(previous) === JSON.stringify(next) ? previous : next));
    };
    measure();
    return observeWorkspaceQuoteLayout(paper, parent, measure);
  }, [container, read.quotes, text, visible]);
  const nameOf = (quote: WorkspaceFileQuoteReference) =>
    quote.authorCatId ? resolveCatDisplayName(quote.authorCatId, getCatById) : human.name;
  const avatar = (quote: WorkspaceFileQuoteReference) => {
    const src = quote.authorCatId
      ? (getCatById(quote.authorCatId)?.avatar ?? `/avatars/${encodeURIComponent(quote.authorCatId)}.png`)
      : human.avatar;
    return src ? (
      <Image unoptimized src={src} width={20} height={20} alt={nameOf(quote)} className="shrink-0 rounded-full" />
    ) : (
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-cafe-surface-sunken text-micro">
        {nameOf(quote).slice(0, 1)}
      </span>
    );
  };
  const open = (quote: WorkspaceFileQuoteReference) => {
    useF307ExperienceWorkbenchStore.getState().exitMainAreaAttention();
    useChatStore.getState().closeRightPanel();
    openExactPlace(`message:${quote.threadId}:${quote.messageId}`, window.location.pathname);
  };
  if (!visible) return null;
  const error =
    read.state === 'changed'
      ? t.changed
      : read.state === 'hidden'
        ? t.unavailable
        : read.state === 'failed'
          ? t.failed
          : null;
  const messageCount = new Set(read.quotes.map((quote) => `${quote.threadId}:${quote.messageId}`)).size;
  if (isV2 && !error && read.state === 'ready' && messageCount === 0) return null;
  return (
    <>
      <section
        className="shrink-0 border-b border-cafe-subtle px-3 py-2 text-xs text-cafe-secondary"
        aria-label={t.count(messageCount)}
      >
        {error ? (
          <output>
            {error}{' '}
            <button type="button" className="underline" onClick={() => void read.reload()}>
              {t.reload}
            </button>
          </output>
        ) : (
          <details ref={list}>
            <summary className="cursor-pointer">
              {t.count(messageCount)}
              {read.state === 'loading' ? ` · ${t.loading}` : ''}
              {read.nextCursor ? ` · ${t.unread}` : ''}
            </summary>
            <div className="mt-2 space-y-2">
              {read.quotes.map((quote) => (
                <button
                  key={keyOf(quote)}
                  type="button"
                  data-file-quote-reference={quote.attachment.id}
                  data-file-quote-key={keyOf(quote)}
                  data-file-quote-state={quote.state}
                  aria-label={t.open(nameOf(quote), quote.quoteNumber)}
                  onClick={() => open(quote)}
                  className="flex w-full min-w-0 items-start gap-2 text-left"
                >
                  {avatar(quote)}
                  <span className="min-w-0">
                    <span>
                      {nameOf(quote)} · {t.place(quote.quoteNumber)}
                    </span>
                    <span className="block line-clamp-2 whitespace-pre-wrap">{quote.attachment.text}</span>
                    {quote.state !== 'current' ? (
                      <span className="block">{quote.state === 'changed' ? t.sourceChanged : t.unlocated}</span>
                    ) : null}
                  </span>
                </button>
              ))}
              {read.nextCursor ? (
                <button
                  type="button"
                  disabled={read.state === 'loading'}
                  onClick={() => void read.loadMore()}
                  className="underline"
                >
                  {isV2 ? t.earlier : t.more}
                </button>
              ) : null}
            </div>
          </details>
        )}
        {!isV2 && !error ? (
          <button
            type="button"
            disabled={read.state === 'loading'}
            className="mt-1 underline"
            onClick={() => void read.reload()}
          >
            {t.reload}
          </button>
        ) : null}
      </section>
      {positions.map((position) => {
        const quote = read.quotes.find((item) => keyOf(item) === position.keys[0]);
        const label = quote
          ? position.keys.length === 1
            ? t.open(nameOf(quote), quote.quoteNumber)
            : t.group(position.keys.length)
          : '';
        return quote ? (
          <button
            key={position.line}
            type="button"
            data-file-quote-mark={quote.attachment.id}
            aria-label={label}
            title={label}
            onClick={() => {
              if (position.keys.length === 1) open(quote);
              else if (list.current) {
                list.current.open = true;
                [...list.current.querySelectorAll<HTMLButtonElement>('[data-file-quote-reference]')]
                  .find((button) => button.dataset.fileQuoteKey === position.keys[0])
                  ?.focus();
              }
            }}
            className="absolute right-2 z-10 flex items-center gap-1 rounded bg-cafe-surface-elevated p-1 text-micro text-cafe-secondary"
            style={{ top: position.top }}
          >
            {avatar(quote)}
            <span>{position.keys.length === 1 ? quote.quoteNumber : position.keys.length}</span>
          </button>
        ) : null;
      })}
    </>
  );
}
