import type { UnifiedAttentionItemV1 } from '@cat-cafe/shared';
import { useCatNameResolver } from '@/hooks/useCatNameResolver';
import { APPROVAL_FEATURES } from '@/lib/approval-features';
import { approvalDisplayTitle } from '@/lib/approval-presentation';
import { formatRelativeTime } from '../../ThreadSidebar/thread-utils';
import { useShellCopy } from '../shell-copy';
import { useShellLanguage } from '../shell-language';
import { leadAndTitle } from './approval-heading';
import { mailboxEntryCopy } from './mailbox-entry.shell-copy';
import { readWorkDetail, readWorkSystemRecommendation } from './work-detail';

/** An id this build's catalog does not know (a newer producer) must not crash the panel: fall back to the raw id. */
function featureLabel(featureId: string, language: 'zh' | 'en'): string {
  const entry = (APPROVAL_FEATURES as Record<string, { label: string; badgeLabel: string } | undefined>)[featureId];
  return (language === 'en' ? entry?.badgeLabel : entry?.label) ?? featureId;
}

export interface MailboxRowText {
  /** The cat this row is about, for the avatar. Absent when the contract does not name one. */
  catId: string | null;
  /** Bold lead-in before the rest of the title: an approval is "who proposed what". */
  lead: string | null;
  title: string;
  source: string | null;
  time: string | null;
}

/**
 * What the header says. An approval is "who proposed what", from which feature, and when. A work row knows whose
 * entrusted work it is (the owning cat) and which work — named as such, not passed off as the feature that raised the
 * decision — and the contract has no time for it. Whatever the contract does not name is left out, not guessed.
 */
export function useMailboxRowText(item: UnifiedAttentionItemV1): MailboxRowText {
  const resolveCatName = useCatNameResolver();
  const language = useShellLanguage();
  const t = useShellCopy(mailboxEntryCopy);
  const time = (value: number) =>
    language === 'zh'
      ? formatRelativeTime(value)
      : new Intl.DateTimeFormat('en-US', {
          month: 'numeric',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        }).format(value);
  const approval = item.approval;
  const accountability = item.collectiveAccountabilityRequest;
  if (item.userMention) {
    const request = item.userMention;
    return {
      catId: request.catId,
      lead: null,
      title: request.threadTitle || request.threadId,
      source: resolveCatName(request.catId),
      time: time(request.timestamp),
    };
  }
  if (item.runtimeInteraction) {
    const runtime = item.runtimeInteraction;
    return {
      catId: runtime.requesterCatId,
      lead: null,
      title: runtime.title,
      source: t.choice,
      time: time(runtime.createdAt),
    };
  }
  if (item.choiceRequest) {
    const choice = item.choiceRequest;
    return {
      catId: choice.requesterCatId,
      lead: resolveCatName(choice.requesterCatId),
      title: choice.title,
      source: t.choice,
      time: time(choice.createdAt),
    };
  }
  if (accountability) {
    const requestedAt = Date.parse(accountability.requestedAt);
    return {
      catId: null,
      lead: t.accountabilityLead(accountability.requestedByDisplayName),
      title: accountability.workTitle,
      source: t.accountabilitySource(accountability.projectTitle),
      time: Number.isFinite(requestedAt) ? time(requestedAt) : null,
    };
  }
  if (approval) {
    const { lead, title } = leadAndTitle(
      resolveCatName(approval.requesterCatId),
      approvalDisplayTitle(approval, { resolveCatName }),
    );
    return {
      catId: approval.requesterCatId,
      lead,
      title,
      source: featureLabel(approval.sourceFeatureId, language),
      time: time(approval.createdAt),
    };
  }
  const { ownerCatId, workTitle } = readWorkDetail(item);
  const owner = ownerCatId ? resolveCatName(ownerCatId) : null;
  const work = workTitle ? t.workTitle(workTitle) : t.work;
  return {
    catId: ownerCatId,
    lead: null,
    title: readWorkSystemRecommendation(item) === 'collective_result_ready' ? t.collectiveResultReady : item.summary,
    source: owner ? t.ownerWork(owner, work) : workTitle ? work : null,
    time: null,
  };
}
