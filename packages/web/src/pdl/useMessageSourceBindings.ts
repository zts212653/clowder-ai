'use client';
import {
  isValidRichBlock,
  type MatterPage,
  type MessageSearchAnswerView,
  type MessageSearchResponse,
  messageSearchAnswerRefSchema,
  messageSearchResponseSchema,
  REMEMBER_TARGETS,
  type RememberGroupRow,
  type RichCardBlock,
  type ThreadArtifactDTO,
  workReferenceSchema,
} from '@cat-cafe/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { z } from 'zod';
import { createQuoteContextAttachment } from '@/components/chat-context-reference';
import { workspaceFileSourceFromUrl } from '@/components/content-review/file-source';
import { recoveryPending } from '@/components/managed-job/recovery-projection';
import { isPersonDetail, type PersonDetail } from '@/components/memory/page/people-types';
import { isApprovalItemBatchDecidable } from '@/lib/approval-features';
import { useApprovalHubStore } from '@/stores/approvalHubStore';
import { useChatStore } from '@/stores/chatStore';
import { apiSessionIdentity } from '@/utils/api-session-identity';
import type { ChatData } from './chat-models';
import { guessAndRenderCardType } from './message-cards';
import { request, write } from './owner-api';
import {
  decideProposal,
  type ProposalBinding,
  proposalRecoveryState,
  readProposal,
  recheckProposal,
} from './proposal-models';

const groupSchema = z.object({
  v: z.literal(1),
  groupId: z.string().min(1),
  rows: z
    .array(
      z.object({
        itemId: z.string().min(1),
        target: z.enum(REMEMBER_TARGETS),
        statusCode: z.number().int(),
        proposalId: z.string().optional(),
        messageId: z.string().optional(),
        resultRef: z.string().optional(),
        personId: z.string().optional(),
        status: z.string().optional(),
        error: z.string().optional(),
      }),
    )
    .min(1)
    .max(4),
});
interface GroupRead {
  rows: {
    row: RememberGroupRow;
    matter?: MatterPage;
    person?: PersonDetail;
    original?: { block: RichCardBlock; coordinate: { threadId: string; messageId: string; messageRevision: string } };
    error?: string;
  }[];
  error?: string;
}
async function readMemoryGroup(block: RichCardBlock, threadId: string): Promise<GroupRead> {
  const group = groupSchema.parse(block.meta!.memoryGroup);
  const producers: Partial<Record<RememberGroupRow['target'], string>> = {
    profile: 'F231',
    taste: 'F221',
    person: 'F276',
    entity: 'F260',
    event_correction: 'F321',
  };
  const wanted = group.rows.filter(
    (row) => row.statusCode < 400 && !row.error && row.proposalId && producers[row.target],
  );
  const originals: Record<string, NonNullable<GroupRead['rows'][number]['original']>> = {};
  let before: string | undefined;
  while (wanted.some((row) => !originals[row.itemId])) {
    const page = await request<{
      messages: (import('@/stores/chat-types').ChatMessage & { deletedAt?: number; _tombstone?: boolean })[];
      hasMore: boolean;
    }>('/api/messages?' + new URLSearchParams({ threadId, limit: '50', ...(before ? { before } : {}) }));
    for (const row of wanted.filter((row) => !originals[row.itemId]))
      for (const message of page.messages) {
        if (
          (row.messageId && row.messageId !== message.id) ||
          message.deletedAt ||
          message._tombstone ||
          typeof message.timestamp !== 'number'
        )
          continue;
        const original = message.extra?.rich?.blocks
          .filter(isValidRichBlock)
          .find((candidate): candidate is RichCardBlock => {
            if (candidate.kind !== 'card') return false;
            const stamp = candidate.meta?.approval;
            return (
              !!stamp &&
              typeof stamp === 'object' &&
              'producerId' in stamp &&
              stamp.producerId === producers[row.target] &&
              'canonicalProposalId' in stamp &&
              stamp.canonicalProposalId === row.proposalId
            );
          });
        if (original) {
          originals[row.itemId] = {
            block: original,
            coordinate: { threadId, messageId: message.id, messageRevision: String(message.timestamp) },
          };
          break;
        }
      }
    const oldest = page.messages[0],
      next = page.hasMore && oldest ? `${oldest.timestamp}:${oldest.id}` : undefined;
    if (!next || next === before) break;
    before = next;
  }
  return {
    rows: await Promise.all(
      group.rows.map(async (row) => {
        if (row.statusCode >= 400 || row.error) return { row };
        try {
          if (row.target === 'matter' && row.resultRef) {
            const matter = await request<MatterPage>(
              `/api/memory/matters/${encodeURIComponent(row.resultRef)}?limit=3`,
            );
            if (matter.matter.matterId !== row.resultRef) throw new Error('source_changed');
            return { row, matter };
          }
          if (row.target === 'person_revision' && row.personId && row.resultRef) {
            const person = await request<PersonDetail>(`/api/memory/people/${encodeURIComponent(row.personId)}`);
            if (!isPersonDetail(person) || person.personId !== row.personId) throw new Error('source_changed');
            return { row, person };
          }
          return { row, original: originals[row.itemId] };
        } catch (error) {
          return { row, error: (error as Error).message };
        }
      }),
    ),
  };
}
interface HoldRead {
  taskId?: string;
  recovery?: unknown;
  job?: { state: string; recovery?: unknown };
}
interface Generation {
  messageIds: string[];
  hasAppendedInputs: boolean;
  complete: boolean;
}
interface Source {
  mid: string;
  blockId: string;
  kind: 'evidence' | 'work' | 'generation' | 'memory_group';
  block?: RichCardBlock;
  query: Record<string, string>;
  reference?: unknown;
}

/** Message metadata supplies locators; the original owners supply all displayed evidence and work versions. */
export function useMessageSourceBindings(data: ChatData, needed: boolean | number = false) {
  const records = useRef<{
    evidence: Record<string, { blockId: string; view: MessageSearchAnswerView & { response: MessageSearchResponse } }>;
    works: Record<string, ThreadArtifactDTO>;
    generations: Record<string, Generation>;
    holds?: Record<string, HoldRead>;
    memoryGroups?: Record<string, GroupRead>;
  }>({ evidence: {}, works: {}, generations: {}, holds: {} });
  const inboxProposals = useRef<Record<string, ProposalBinding>>({});
  const failure = useRef<unknown>(null);
  const [groupRevision, refreshGroup] = useState(0);
  const [holdBusy, setHoldBusy] = useState<Record<string, boolean>>({});
  const [holdRevision, recheckHold] = useState(0);
  const holdIds = JSON.stringify([
    ...new Set(
      data.messages.flatMap((m) =>
        m.source?.connector === 'hold-ball' && typeof m.source.meta?.taskId === 'string' ? [m.source.meta.taskId] : [],
      ),
    ),
  ]);

  const [revision, changed] = useState(0);
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
      if (block.kind === 'card' && block.meta?.kind === 'memory_group')
        return [{ mid: message.id, blockId: block.id, kind: 'memory_group', query: {}, block }];
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
    records.current = { ...records.current, evidence: {}, works: {}, generations: {} };
    failure.current = null;
    void Promise.all(
      sources.map(async (source) => {
        if (source.kind === 'memory_group') {
          let value: GroupRead;
          try {
            value = await readMemoryGroup(source.block!, data.threadId);
          } catch (error) {
            value = { rows: [], error: (error as Error).message };
          }
          if (active)
            records.current = {
              ...records.current,
              memoryGroups: { ...records.current.memoryGroups, [source.mid + ':' + source.blockId]: value },
            };
          return;
        }
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
          records.current = { ...records.current, evidence: {}, works: {}, generations: {} };
          failure.current = error;
          changed((n) => n + 1);
        }
      },
    );
    return () => {
      active = false;
    };
  }, [needed, identity, groupRevision]);
  useEffect(() => {
    if (!needed) return;
    const ids = JSON.parse(holdIds) as string[];
    if (!ids.length) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      clearTimeout(timer);
      if (document.hidden) return;
      const values = await Promise.all(
        ids.map(
          async (id) =>
            [
              id,
              await request<HoldRead>(`/api/callbacks/hold-ball/${encodeURIComponent(id)}/status`, {
                signal: abort.signal,
              }),
            ] as const,
        ),
      );
      if (abort.signal.aborted) return;
      records.current = { ...records.current, holds: Object.fromEntries(values) };
      changed((n) => n + 1);
      if (
        values.some(
          ([, value]) =>
            recoveryPending(value.recovery) ||
            recoveryPending(value.job?.recovery) ||
            (value.job && ['queued', 'running', 'cancelling'].includes(value.job.state)),
        )
      )
        timer = setTimeout(poll, 2000);
    };
    const poll = () => {
      void read().catch(() => {
        if (!abort.signal.aborted) {
          records.current = { ...records.current, holds: {} };
          changed((n) => n + 1);
        }
      });
    };
    poll();
    document.addEventListener('visibilitychange', poll);
    return () => {
      abort.abort();
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', poll);
    };
  }, [needed, holdIds, holdRevision]);
  const rawData = useMemo<{
    records: typeof records.current;
    error: unknown;
    holdBusy?: Record<string, boolean>;
    inboxRecoveries?: Record<string, ProposalBinding['recovery']>;
  }>(
    () => ({
      records: records.current,
      error: failure.current,
      holdBusy,
      inboxRecoveries: Object.fromEntries(
        Object.entries(inboxProposals.current).map(([id, binding]) => [id, proposalRecoveryState(binding.target)]),
      ),
    }),
    [records.current, failure.current, holdBusy, revision],
  );
  return {
    data: rawData,
    action: async (name: string, args: Record<string, string>) => {
      if (name === 'memoryGroupRefresh') {
        refreshGroup((n) => n + 1);
        return true;
      }
      if (name === 'memoryGroupChange') {
        const original = records.current.memoryGroups?.[args.key]?.rows.find(
          (row) => row.row.itemId === args.itemId,
        )?.original;
        if (!original || data.readonly || data.contexts.length >= 12) throw new Error(args.blocked);
        const state = useChatStore.getState(),
          queued = state.pendingChatInsert;
        if (queued && queued.threadId !== original.coordinate.threadId) throw new Error(args.blocked);
        state.setPendingChatInsert({
          ...queued,
          threadId: original.coordinate.threadId,
          text: [queued?.text, args.prompt].filter(Boolean).join('\n'),
          contextAttachments: [
            ...(queued?.contextAttachments ?? []),
            createQuoteContextAttachment(original.block.title, {
              kind: 'message',
              threadId: original.coordinate.threadId,
              messageId: original.coordinate.messageId,
            }),
          ],
        });
        return original.coordinate;
      }
      if (name === 'holdRecoveryRecheck') {
        setHoldBusy((s) => ({ ...s, [args.taskId]: true }));
        try {
          await write(`/api/callbacks/hold-ball/${encodeURIComponent(args.taskId)}/recheck`, {});
          recheckHold((n) => n + 1);
          return true;
        } finally {
          setHoldBusy((s) => ({ ...s, [args.taskId]: false }));
        }
      }
      if (name === 'inboxReadback') {
        const binding = inboxProposals.current[args.id];
        if (!binding || binding.owner !== apiSessionIdentity.getSnapshot().ownerUserId)
          throw new Error('proposalRecovery.blocked');
        await recheckProposal(binding);
        return true;
      }
      if (name !== 'inboxDecide') return false;
      await useApprovalHubStore.getState().ensurePending(args.owner);
      const store = useApprovalHubStore.getState(),
        item = store.items.find((item) => item.proposalId === args.id);
      if (!item || item.ownerUserId !== args.owner || !isApprovalItemBatchDecidable(item))
        throw new Error('请重新读取提议');
      if (item.sourceFeatureId === 'F128') {
        if (item.navigation.state !== 'anchored' || item.ownerUserId !== apiSessionIdentity.getSnapshot().ownerUserId)
          throw new Error('proposalRecovery.blocked');
        const ref = item.navigation.approvalCardRef;
        const target = {
          feature: 'F128' as const,
          id: item.proposalId,
          threadId: ref.threadId,
          mid: ref.messageId,
          blockId: '',
        };
        const binding: ProposalBinding = {
          target,
          owner: item.ownerUserId,
          current: true,
          record: await readProposal(target, undefined, true),
          refresh: async () => {
            binding.record = await readProposal(target, undefined, true);
            changed((n) => n + 1);
          },
          notify: () => changed((n) => n + 1),
        };
        inboxProposals.current[item.proposalId] = binding;
        await decideProposal(binding, args.res === 'accept' ? 'approve' : 'reject');
        return true;
      }
      if (args.res === 'accept')
        await store.approveProposal(
          args.id,
          typeof item.detail.decisionDigest === 'string' ? item.detail.decisionDigest : undefined,
        );
      else await store.rejectProposal(args.id);
      const attempt = useApprovalHubStore.getState().decisionAttempts[args.id]?.state;
      if (attempt?.phase !== 'response_received' || !attempt.ok)
        throw new Error(useApprovalHubStore.getState().error ?? '请重新读取提议');
      return true;
    },
  };
}
