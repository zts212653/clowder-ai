'use client';

import type { ThreadProposal } from '@cat-cafe/shared';
import { useEffect, useState } from 'react';
import { ProposalCard } from '@/components/rich/ProposalCard';
import { writeShellLanguage } from '@/components/shell/shell-language';
import { ShellPresentationContext, writeShellPresentation } from '@/components/shell/shell-presentation';
import { ThreadSidebar } from '@/components/ThreadSidebar/ThreadSidebar';
import type { RichCardBlock } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';

type Feed = { sourceThreadId?: string; cards: { proposal: ThreadProposal; messageId: string; block: RichCardBlock }[] };

/** Development-only placement of the actual Sidebar and owner-read Chat cards against an isolated API. */
export function ProposalJourneyPreview() {
  const [feed, setFeed] = useState<Feed>({ cards: [] });
  useEffect(() => {
    writeShellPresentation('v2');
    writeShellLanguage('zh');
    document.documentElement.dataset.shell = 'v2';
    let alive = true;
    let previous = '';
    const read = async () => {
      const response = await apiFetch('/__test/proposal-cards');
      if (!response.ok) return;
      const next = (await response.json()) as Feed;
      if (!alive) return;
      const revision = JSON.stringify(
        next.cards.map(({ proposal }) => [proposal.proposalId, proposal.status, proposal.revisionRequest?.queuedAt]),
      );
      if (revision === previous) return;
      previous = revision;
      setFeed(next);
      if (next.sourceThreadId) useChatStore.setState({ currentThreadId: next.sourceThreadId });
      for (const { proposal } of next.cards)
        window.dispatchEvent(
          new CustomEvent('cat-cafe:proposal-updated', { detail: { proposalId: proposal.proposalId } }),
        );
    };
    void read();
    const timer = window.setInterval(() => void read(), 700);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);
  return (
    <ShellPresentationContext.Provider value="v2">
      <main className="cafe-presentation flex h-dvh min-w-0 bg-[var(--shell-work)] text-[var(--shell-body)]">
        <ThreadSidebar routeThreadId={feed.sourceThreadId ?? 'default'} className="w-[300px] max-w-full shrink-0" />
        <section className="hidden min-w-0 flex-1 overflow-y-auto sm:block px-8 py-5 max-sm:px-3">
          <h1 className="mb-6 border-b border-[var(--shell-hairline)] pb-3 text-[15px] font-semibold">
            每日漫谈与守望
          </h1>
          <div className="mx-auto max-w-[760px] space-y-4">
            <p className="text-[13px] text-[var(--shell-muted)]">宪宪 · 10/23 15:40</p>
            {feed.cards.map(({ proposal, messageId, block }) => (
              <ProposalCard
                key={proposal.proposalId}
                block={block}
                messageId={messageId}
                coordinate={{
                  threadId: proposal.sourceThreadId,
                  messageId,
                  messageRevision: String(proposal.createdAt),
                }}
              />
            ))}
          </div>
        </section>
      </main>
    </ShellPresentationContext.Provider>
  );
}
