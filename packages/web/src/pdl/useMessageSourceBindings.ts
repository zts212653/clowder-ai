'use client';
import {
  type MessageSearchAnswerView,
  type MessageSearchResponse,
  messageSearchAnswerRefSchema,
  messageSearchResponseSchema,
  type ThreadArtifactDTO,
  workReferenceSchema,
} from '@cat-cafe/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { workspaceFileSourceFromUrl } from '@/components/content-review/file-source';
import { isApprovalItemBatchDecidable } from '@/lib/approval-features';
import { useApprovalHubStore } from '@/stores/approvalHubStore';
import type { ChatData } from './chat-models';
import { guessAndRenderCardType } from './message-cards';
import { request } from './owner-api';

interface Generation {
  messageIds: string[];
  hasAppendedInputs: boolean;
  complete: boolean;
}
interface Source {
  mid: string;
  blockId: string;
  kind: 'evidence' | 'work' | 'generation';
  query: Record<string, string>;
  reference?: unknown;
}

/** Message metadata supplies locators; the original owners supply all displayed evidence and work versions. */
export function useMessageSourceBindings(data: ChatData, needed: boolean | number = false) {
  const records = useRef<{
    evidence: Record<string, { blockId: string; view: MessageSearchAnswerView & { response: MessageSearchResponse } }>;
    works: Record<string, ThreadArtifactDTO>;
    generations: Record<string, Generation>;
  }>({ evidence: {}, works: {}, generations: {} });
  const failure = useRef<unknown>(null);
  const [, changed] = useState(0);
  const sources = data.messages.flatMap((message) => [
    ...guessAndRenderCardType(message, data.threadId).flatMap<Source>((card) =>
      card.type === 'evidence'
        ? [
            {
              mid: card.mid,
              blockId: card.blockId,
              kind: 'evidence' as const,
              query: { messageId: card.mid, blockId: card.blockId },
            },
          ]
        : card.type === 'work'
          ? [
              {
                mid: card.mid,
                blockId: card.blockId,
                kind: 'work' as const,
                query: { threadId: data.threadId },
                reference: card.block.meta!.reference,
              },
            ]
          : [],
    ),
    ...(message.extra?.rich?.blocks ?? []).flatMap<Source>((block) => {
      if (block.kind === 'file') {
        const source = workspaceFileSourceFromUrl(block.url);
        if (source && /\.mp4$/i.test(source.path))
          return [
            {
              mid: message.id,
              blockId: block.id,
              kind: 'work' as const,
              query: { threadId: data.threadId, worktreeId: source.worktreeId, path: source.path },
            },
          ];
      }
      return [];
    }),
  ]);
  for (const message of data.messages)
    if (message.lifecycle?.kind === 'response')
      sources.push({ mid: message.id, blockId: '', kind: 'generation', query: {} });
  const identity = JSON.stringify([sources, data.messages.map((m) => [m.id, m.lifecycle])]);
  useEffect(() => {
    if (!needed) return;
    let active = true;
    records.current = { evidence: {}, works: {}, generations: {} };
    failure.current = null;
    void Promise.all(
      sources.map(async (source) => {
        if (source.kind === 'generation') {
          const result = await request<Generation>(
            '/api/threads/' +
              encodeURIComponent(data.threadId) +
              '/messages/' +
              encodeURIComponent(source.mid) +
              '/generation-messages',
          );
          if (active)
            records.current = {
              ...records.current,
              generations: { ...records.current.generations!, [source.mid]: result },
            };
          return;
        }
        if (source.kind === 'evidence') {
          const result = await request<MessageSearchAnswerView>(
            '/api/evidence/answer?' + new URLSearchParams(source.query),
          );
          if (active && result.status === 'available')
            records.current = {
              ...records.current,
              evidence: {
                ...records.current.evidence!,
                [source.mid]: {
                  blockId: source.blockId,
                  view: {
                    ...result,
                    response: messageSearchResponseSchema.parse(result.response),
                    publicationRef: messageSearchAnswerRefSchema.parse(result.publicationRef),
                  },
                },
              },
            };
        } else {
          const reference = source.reference === undefined ? null : workReferenceSchema.parse(source.reference);
          const query = reference
            ? { ...source.query, contentRef: reference.contentRef, ownerRevision: String(reference.ownerRevision) }
            : source.query;
          const result = await request<{ artifact: ThreadArtifactDTO | null }>(
            '/api/works/resolve-file?' + new URLSearchParams(query),
          );
          if (active && result.artifact)
            records.current = {
              ...records.current,
              works: { ...records.current.works!, [source.mid + ':' + source.blockId]: result.artifact },
            };
        }
      }),
    ).then(
      () => {
        if (active) changed((n) => n + 1);
      },
      (error) => {
        if (active) {
          records.current = { evidence: {}, works: {}, generations: {} };
          failure.current = error;
          changed((n) => n + 1);
        }
      },
    );
    return () => {
      active = false;
    };
  }, [needed, identity]);
  const rawData = useMemo(
    () => ({ records: records.current, error: failure.current }),
    [records.current, failure.current],
  );
  return {
    data: rawData,
    action: async (name: string, args: Record<string, string>) => {
      if (name !== 'inboxDecide') return false;
      await useApprovalHubStore.getState().ensurePending(args.owner);
      const store = useApprovalHubStore.getState(),
        item = store.items.find((item) => item.proposalId === args.id);
      if (!item || item.ownerUserId !== args.owner || !isApprovalItemBatchDecidable(item))
        throw new Error('请重新读取提议');
      if (args.res === 'accept') await store.approveProposal(args.id);
      else await store.rejectProposal(args.id);
      const attempt = useApprovalHubStore.getState().decisionAttempts[args.id]?.state;
      if (attempt?.phase !== 'response_received' || !attempt.ok)
        throw new Error(useApprovalHubStore.getState().error ?? '请重新读取提议');
      return true;
    },
  };
}
