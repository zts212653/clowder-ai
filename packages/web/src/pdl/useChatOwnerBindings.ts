'use client';
import type { CustodyOfferV1, FrustrationIssue, HydratedMessageBundle, PawFeelInboxPage } from '@cat-cafe/shared';
import { useEffect, useState } from 'react';
import { reconcileThreadWithServer } from '@/hooks/queue-reconciliation';
import type { ChatData } from './chat-models';
import { guessAndRenderCardType } from './message-cards';
import { request, write } from './owner-api';

interface Read<T> {
  load: string;
  value?: T;
  error?: string;
}
interface ProposalOwner {
  offer?: CustodyOfferV1 | null;
  sourceMessageRevision?: string;
  issue?: FrustrationIssue;
}
interface QueueTargets {
  cats: {
    participants: { catId: string }[];
    routableNow: { catId: string }[];
    routableNotJoined: { catId: string }[];
  };
  source: { sourceRecordId: string; targets: { targetCatId: string; actionable: boolean }[] };
}
interface OnboardingReceipt {
  status: string;
  autoEligible?: boolean;
}
interface ChatOwnerData {
  vote: {
    threadId: string;
    value: { question: string; votes: Record<string, string>; voteCount?: number; status: 'active' | 'closed' } | null;
  };
  proposals: Record<string, Read<ProposalOwner>>;
  bundles: Record<string, Read<HydratedMessageBundle>>;
  queueTargets: Record<string, Read<QueueTargets>>;
  delivery: Record<string, Record<string, Read<{ status: string }>>>;
  repeatReceipts: Record<string, Record<string, unknown>>;
  deliveryErrors: Record<string, Record<string, string>>;
  proposalErrors: Record<string, string>;
  onboarding?: { demo: OnboardingReceipt; entry: OnboardingReceipt };
  pawSource?: { messageId: string; page: PawFeelInboxPage | { error: string } };
}

/** Source-owner responses are pushed as data; all cards, dialogs and popovers project in the app. */
export function useChatOwnerBindings(
  data: ChatData,
  needed: boolean | number = false,
  voteNeeded: boolean | number = false,
) {
  const [read, setRead] = useState<ChatOwnerData>({
    vote: { threadId: data.threadId, value: null },
    proposals: {},
    bundles: {},
    queueTargets: {},
    delivery: {},
    repeatReceipts: {},
    deliveryErrors: {},
    proposalErrors: {},
  });
  useEffect(() => {
    if (!voteNeeded) return;
    const abort = new AbortController(),
      threadId = data.threadId;
    const load = async (afterCurrentGet = false) => {
      try {
        const result = await request<{ vote: ChatOwnerData['vote']['value'] }>(
          `/api/threads/${encodeURIComponent(threadId)}/vote`,
          { signal: abort.signal },
          { afterCurrentGet },
        );
        if (!abort.signal.aborted) {
          setRead((current) => ({ ...current, vote: { threadId, value: result.vote } }));
          window.clowderChat.dataOk('vote');
        }
      } catch (error) {
        if (!abort.signal.aborted) {
          setRead((current) => ({ ...current, vote: { threadId, value: null } }));
          window.clowderChat.dataError('vote', error);
        }
      }
    };
    void load();
    const changed = (event: Event) => {
      if ((event as CustomEvent<{ threadId: string }>).detail.threadId === threadId) void load(true);
    };
    window.addEventListener('cat-cafe:vote-updated', changed);
    return () => {
      abort.abort();
      window.removeEventListener('cat-cafe:vote-updated', changed);
    };
  }, [voteNeeded, data.threadId]);
  const proposalTargets = data.messages.flatMap((message) => {
    const cards = guessAndRenderCardType(message, data.threadId),
      frustration = cards.find((c) => c.type === 'frustration'),
      custody = cards.find((c) => c.type === 'custody');
    return frustration || custody
      ? [
          {
            mid: message.id,
            issueId: frustration?.type === 'frustration' ? frustration.issueId : null,
            revision: custody?.type === 'custody' ? custody.revision : undefined,
          },
        ]
      : [];
  });
  const identity = JSON.stringify(proposalTargets);
  const loadProposal = async (mid: string, signal?: AbortSignal) => {
    const target = proposalTargets.find((t) => t.mid === mid)!;
    let result: Read<ProposalOwner>;
    try {
      const value = await request<ProposalOwner>(
        target.issueId
          ? `/api/frustration-issues/${encodeURIComponent(target.issueId)}/status`
          : `/api/messages/${encodeURIComponent(mid)}/custody-offer`,
        { signal },
      );
      result = { load: '', value };
    } catch (error) {
      if (signal?.aborted) return;
      result = { load: 'error', error: (error as Error).message };
    }
    setRead((s) => ({ ...s, proposals: { ...s.proposals, [mid]: result } }));
  };
  useEffect(() => {
    if (!needed) return;
    const abort = new AbortController();
    void Promise.all(proposalTargets.map((t) => loadProposal(t.mid, abort.signal)));
    return () => abort.abort();
  }, [needed, identity]);

  const action = async (name: string, args: Record<string, string>) => {
    switch (name) {
      case 'cafeVoteEnd':
        await write(`/api/threads/${encodeURIComponent(data.threadId)}/vote`, {}, 'DELETE');
        setRead((current) => ({ ...current, vote: { threadId: data.threadId, value: null } }));
        return true;
      case 'cafeQueueOrder':
        await write(
          `/api/threads/${encodeURIComponent(data.threadId)}/queue/reorder`,
          {
            positions: (JSON.parse(args.keys) as string[]).map((entryId, position) => ({ entryId, position })),
          },
          'PATCH',
        );
        await reconcileThreadWithServer(data.threadId, () => false, 'PdlQueueOrder');
        return true;
      case 'cafeReveal':
        await write(`/api/threads/${encodeURIComponent(args.id)}/reveal`, {}, 'PATCH');
        await reconcileThreadWithServer(args.id, () => false, 'PdlReveal');
        return true;
      case 'queueTargetsRead': {
        const key = JSON.stringify([args.threadId, args.entryId]);
        setRead((s) => ({ ...s, queueTargets: { ...s.queueTargets, [key]: { load: 'loading' } } }));
        let result: Read<QueueTargets>;
        try {
          const [cats, source] = await Promise.all([
            request<QueueTargets['cats']>(`/api/threads/${encodeURIComponent(args.threadId)}/cats`),
            request<QueueTargets['source']>(
              `/api/threads/${encodeURIComponent(args.threadId)}/queue/${encodeURIComponent(args.entryId)}/targets`,
            ),
          ]);
          result = { load: '', value: { cats, source } };
        } catch (error) {
          result = { load: 'error', error: (error as Error).message };
        }
        setRead((s) => ({ ...s, queueTargets: { ...s.queueTargets, [key]: result } }));
        return result;
      }
      case 'queueTargetsSave':
        await write(
          `/api/threads/${encodeURIComponent(args.threadId)}/queue/${encodeURIComponent(args.entryId)}/targets`,
          JSON.parse(args.value),
        );
        await reconcileThreadWithServer(args.threadId, () => false, 'PdlQueueTargets');
        return true;
      case 'messageBundleOpen': {
        setRead((s) => ({ ...s, bundles: { ...s.bundles, [args.id]: { load: 'loading' } } }));
        let result: Read<HydratedMessageBundle>;
        try {
          result = {
            load: '',
            value: await request<HydratedMessageBundle>(`/api/message-bundles/${encodeURIComponent(args.id)}`),
          };
        } catch (error) {
          result = { load: 'error', error: (error as Error).message };
        }
        setRead((s) => ({ ...s, bundles: { ...s.bundles, [args.id]: result } }));
        return true;
      }
      case 'proposalOwnerRefresh':
        setRead((s) => ({ ...s, proposalErrors: { ...s.proposalErrors, [args.mid]: '' } }));
        await loadProposal(args.mid);
        return true;
      case 'proposalOwnerDecide': {
        const target = proposalTargets.find((t) => t.mid === args.mid)!;
        try {
          if (target.issueId)
            await write(
              `/api/frustration-issues/${encodeURIComponent(target.issueId)}/${args.op}`,
              args.op === 'confirm' ? { userDescription: args.v || '' } : {},
            );
          else
            await write(`/api/messages/${encodeURIComponent(args.mid)}/custody-offer/${args.op}`, {
              offerId: args.offerId,
              sourceMessageRevision: args.sourceMessageRevision,
              ...(args.op === 'refuse' ? { disposition: 'declined' } : {}),
            });
        } catch (error) {
          setRead((s) => ({ ...s, proposalErrors: { ...s.proposalErrors, [args.mid]: (error as Error).message } }));
          return { ok: false };
        }
        setRead((s) => ({ ...s, proposalErrors: { ...s.proposalErrors, [args.mid]: '' } }));
        await loadProposal(args.mid);
        return { ok: true };
      }
      case 'cafeDeliveryRead': {
        const key = JSON.stringify([args.threadId, args.sourceMessageId]);
        const targets = JSON.parse(args.targets) as string[];
        const values = await Promise.all(
          targets.map(async (target) => {
            try {
              return [
                target,
                {
                  load: '',
                  value: await request<{ status: string }>(
                    `/api/threads/${encodeURIComponent(args.threadId)}/messages/${encodeURIComponent(args.sourceMessageId)}/routing-targets/${encodeURIComponent(target)}`,
                  ),
                },
              ] as const;
            } catch (error) {
              return [target, { load: 'error', error: (error as Error).message }] as const;
            }
          }),
        );
        setRead((s) => ({ ...s, delivery: { ...s.delivery, [key]: Object.fromEntries(values) } }));
        return true;
      }
      case 'cafeDeliveryRecover': {
        const key = JSON.stringify([args.threadId, args.sourceMessageId]);
        let receipt;
        try {
          receipt = await write(
            `/api/threads/${encodeURIComponent(args.threadId)}/messages/${encodeURIComponent(args.sourceMessageId)}/routing-targets/${encodeURIComponent(args.targetCatId)}/${args.op}`,
            {},
          );
        } catch (error) {
          setRead((s) => ({
            ...s,
            deliveryErrors: {
              ...s.deliveryErrors,
              [key]: { ...s.deliveryErrors[key], [args.targetCatId]: (error as Error).message },
            },
          }));
          return { ok: false };
        }
        setRead((s) => ({
          ...s,
          deliveryErrors: { ...s.deliveryErrors, [key]: { ...s.deliveryErrors[key], [args.targetCatId]: '' } },
          repeatReceipts:
            args.op === 'repeat'
              ? { ...s.repeatReceipts, [key]: { ...s.repeatReceipts[key], [args.targetCatId]: receipt } }
              : s.repeatReceipts,
        }));
        await reconcileThreadWithServer(args.threadId, () => false, 'PdlDeliveryRecover');
        return { ok: true };
      }
      case 'cbAuthHideSimilar': {
        const message = data.messages.find((m) => m.id === args.mid)!;
        const card = guessAndRenderCardType(message, data.threadId).find((c) => c.type === 'cbauth')!;
        const meta = card.type === 'cbauth' ? card.block.meta! : {};
        await write('/api/debug/callback-auth/hide-similar', {
          reason: meta.reason,
          tool: meta.tool,
          catId: meta.catId,
          threadId: meta.threadId,
          userId: meta.userId,
        });
        return true;
      }
      case 'cbAuthViewed': {
        const snapshot = await request<{ startedAt: number; uptimeMs: number }>('/api/debug/callback-auth');
        await write('/api/debug/callback-auth/mark-viewed', { viewedUpTo: snapshot.startedAt + snapshot.uptimeMs });
        return true;
      }
      case 'inboxIgnore':
        await write('/api/config/ignored-items', JSON.parse(args.value), 'PATCH');
        return true;
      case 'guideAdmission': {
        const [demo, entry] = await Promise.all([
          request<OnboardingReceipt>('/api/config/onboarding'),
          request<OnboardingReceipt>('/api/config/onboarding/entry'),
        ]);
        setRead((s) => ({ ...s, onboarding: { demo, entry } }));
        return { demo, entry };
      }
      case 'guideDismiss':
      case 'guideNext':
      case 'guideEntryDismiss':
      case 'guideEntryComplete': {
        const demo = name === 'guideDismiss' || name === 'guideNext';
        const status = name === 'guideDismiss' || name === 'guideEntryDismiss' ? 'dismissed' : 'completed';
        const receipt = await write<OnboardingReceipt>(
          `/api/config/onboarding${demo ? '' : '/entry'}`,
          { status },
          'PUT',
        );
        const entry =
          name === 'guideNext'
            ? await write<OnboardingReceipt>('/api/config/onboarding/entry', { status: 'pending' }, 'PUT')
            : demo
              ? read.onboarding?.entry
              : receipt;
        setRead((s) =>
          s.onboarding
            ? {
                ...s,
                onboarding: {
                  demo: demo ? receipt : s.onboarding.demo,
                  entry: entry!,
                },
              }
            : s,
        );
        return name === 'guideNext' ? entry : receipt;
      }
      case 'msgDisposition': {
        let page: PawFeelInboxPage | { error: string };
        try {
          page = await request<PawFeelInboxPage>(`/api/paw-feel/source/${encodeURIComponent(args.mid)}`);
        } catch (error) {
          page = { error: (error as Error).message };
        }
        setRead((s) => ({ ...s, pawSource: { messageId: args.mid, page } }));
        return { messageId: args.mid, page };
      }
      default:
        return false;
    }
  };
  return { data: read, action };
}
