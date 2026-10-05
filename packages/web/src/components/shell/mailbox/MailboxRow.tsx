import type { UnifiedAttentionItemV1 } from '@cat-cafe/shared';
import { useId, useSyncExternalStore } from 'react';
import { useCatNameResolver } from '@/hooks/useCatNameResolver';
import { APPROVAL_FEATURES } from '@/lib/approval-features';
import { approvalDisplayTitle } from '@/lib/approval-presentation';
import { formatRelativeTime } from '../../ThreadSidebar/thread-utils';
import { ShellCatAvatar } from '../ShellCatAvatar';
import { leadAndTitle } from './approval-heading';
import { isHostableApproval } from './approval-match';
import { describeReconcile } from './approval-reconcile';
import { type ApprovalSessions, sessionKey } from './approval-sessions';
import { HostedApprovalCard } from './HostedApprovalCard';
import { type OriginalPlace, resolveOriginalPlace } from './original-place';
import { PlaceAction } from './PlaceAction';
import type { ApprovalAddress } from './read-evidence';
import { readWorkDetail } from './work-detail';

export const KIND_LABEL: Record<UnifiedAttentionItemV1['kind'], string> = {
  approval: '审批',
  judgment: '等你判断',
  repair: '需要修复',
};

/** An id this build's catalog does not know (a newer producer) must not crash the panel: fall back to the raw id. */
function featureLabel(featureId: string): string {
  return (APPROVAL_FEATURES as Record<string, { label: string } | undefined>)[featureId]?.label ?? featureId;
}

function DetailLine({ testId, label, children }: { testId: string; label: string; children: string }) {
  return (
    <p className="m-0 text-sm" data-testid={testId}>
      <span className="font-medium">{label}</span>
      <span style={{ color: 'var(--shell-body)' }}> {children}</span>
    </p>
  );
}

function WorkDetails({ item }: { item: UnifiedAttentionItemV1 }) {
  const detail = readWorkDetail(item);
  return (
    <div className="flex flex-col gap-1.5">
      {detail.recommendation ? (
        <DetailLine testId="mailbox-detail-recommendation" label="建议">
          {detail.recommendation}
        </DetailLine>
      ) : null}
      {detail.goal ? (
        <DetailLine testId="mailbox-detail-goal" label="目标">
          {detail.goal}
        </DetailLine>
      ) : null}
      {detail.preparedWork ? (
        <DetailLine testId="mailbox-detail-prepared" label="成果">
          {detail.preparedWork}
        </DetailLine>
      ) : null}
    </div>
  );
}

interface RowText {
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
function useRowText(item: UnifiedAttentionItemV1): RowText {
  const resolveCatName = useCatNameResolver();
  const approval = item.approval;
  if (approval) {
    const { lead, title } = leadAndTitle(
      resolveCatName(approval.requesterCatId),
      approvalDisplayTitle(approval, { resolveCatName }),
    );
    return {
      catId: approval.requesterCatId,
      lead,
      title,
      source: featureLabel(approval.sourceFeatureId),
      time: formatRelativeTime(approval.createdAt),
    };
  }
  const { ownerCatId, workTitle } = readWorkDetail(item);
  const owner = ownerCatId ? resolveCatName(ownerCatId) : null;
  const work = workTitle ? `受托工作「${workTitle}」` : '受托工作';
  return {
    catId: ownerCatId,
    lead: null,
    title: item.summary,
    source: owner ? `${owner} 的${work}` : workTitle ? work : null,
    time: null,
  };
}

function Chevron({ open }: { open: boolean }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block"
      style={{
        color: 'var(--shell-muted)',
        transform: open ? 'rotate(90deg)' : undefined,
        transition: 'transform 120ms',
      }}
    >
      ›
    </span>
  );
}

type Hosted = { sessions: ApprovalSessions; ownerUserId: string };

function SessionLineText({ hosted, approval }: { hosted: Hosted; approval: ApprovalAddress }) {
  const { sessions, ownerUserId } = hosted;
  useSyncExternalStore(sessions.subscribe, sessions.getVersion, sessions.getVersion);
  const key = sessionKey(ownerUserId, approval);
  const session = sessions.get(key);
  const view = session ? describeReconcile(session.model.state) : null;
  if (!view?.line) return null;
  return (
    <div className="flex items-center gap-2 px-4 pb-3">
      <output
        className="m-0 block flex-1 text-xs font-medium"
        style={{ color: 'var(--shell-body)' }}
        data-testid="mailbox-row-session-line"
      >
        {view.line}
      </output>
      {view.canReread ? (
        <button
          type="button"
          data-testid="mailbox-row-reread"
          onClick={() => sessions.reread(key)}
          className="shell-nav-row shell-focusable flex-none rounded-lg px-2 py-1 text-xs"
        >
          重新读取
        </button>
      ) : null}
    </div>
  );
}

/**
 * Where a row's decision stands, when the row is closed or from the previous read. An in-flight write, an unknown or a result
 * is never shown as nothing; a row nobody has acted on says nothing here. An open row's card says it itself.
 */
function RowSessionLine({
  open,
  hosted,
  approval,
}: {
  open: boolean;
  hosted: Hosted | undefined;
  approval: ApprovalAddress | undefined;
}) {
  if (open || !hosted || !approval) return null;
  return <SessionLineText hosted={hosted} approval={approval} />;
}

/** The opened row: what the read carries about it, and either the original card (a decidable approval) or the one way to the place. */
function RowBody({
  item,
  id,
  heading,
  hosted,
  onOpen,
}: {
  item: UnifiedAttentionItemV1;
  id: string;
  heading: string;
  hosted: Hosted | undefined;
  onOpen: (place: OriginalPlace) => void;
}) {
  const place = resolveOriginalPlace(item);
  const hostable = hosted !== undefined && item.approval !== undefined && isHostableApproval(item.approval);
  return (
    <section
      id={id}
      aria-label={`${KIND_LABEL[item.kind]}：${heading}`}
      data-testid="mailbox-item-body"
      className="flex flex-col gap-3 px-3 pb-3 pt-1"
      style={{ color: 'var(--shell-ink)' }}
    >
      {item.approval ? null : <WorkDetails item={item} />}
      {hostable && hosted ? (
        <HostedApprovalCard
          item={item}
          ownerUserId={hosted.ownerUserId}
          sessions={hosted.sessions}
          place={place}
          onOpen={onOpen}
        />
      ) : (
        <PlaceAction place={place} onOpen={onOpen} />
      )}
    </section>
  );
}

/**
 * One 待办 item. Collapsed it is a line; expanded (one at a time) it says what the read carries and offers exactly one
 * way forward: open the place that owns the decision. A row from a previous read is never interactive.
 */
export function MailboxRow({
  item,
  rowKey,
  stale,
  expanded,
  onToggle,
  onOpen,
  hosted,
}: {
  item: UnifiedAttentionItemV1;
  rowKey: string;
  stale: boolean;
  expanded: boolean;
  onToggle: () => void;
  onOpen: (place: OriginalPlace) => void;
  /** Where decisions made on a row's original card are followed, and whose they are. Absent: the row only points to the place. */
  hosted?: Hosted;
}) {
  const bodyId = useId();
  const { catId, lead, title, source, time } = useRowText(item);
  const heading = lead ? `${lead} ${title}` : title;
  const open = expanded && !stale;
  return (
    <li
      data-testid="mailbox-item"
      data-kind-label={KIND_LABEL[item.kind]}
      data-row-key={rowKey}
      data-stale={stale ? 'true' : undefined}
      data-expanded={open ? 'true' : 'false'}
      className="rounded-[14px]"
      style={{
        opacity: stale ? 0.6 : undefined,
        border: `1px solid ${open ? 'var(--shell-hairline-strong)' : 'var(--shell-hairline)'}`,
        background: 'var(--shell-paper)',
      }}
    >
      <button
        type="button"
        data-testid="mailbox-item-toggle"
        aria-expanded={open}
        aria-controls={bodyId}
        disabled={stale}
        onClick={onToggle}
        className="shell-nav-row shell-focusable flex w-full flex-col gap-1.5 rounded-[14px] px-4 py-3 text-left text-sm"
      >
        <span className="flex w-full items-center gap-2">
          <span
            className="flex-none rounded px-1.5 text-micro"
            style={{ background: 'var(--shell-selected)', color: 'var(--shell-muted)' }}
          >
            {KIND_LABEL[item.kind]}
          </span>
          <span className="flex-1" />
          {time ? (
            <span className="text-xs" style={{ color: 'var(--shell-muted)' }}>
              {time}
            </span>
          ) : null}
          <Chevron open={open} />
        </span>
        <span className="flex w-full items-start gap-2">
          {catId ? (
            <span className="mt-px flex-none" data-testid="mailbox-item-avatar">
              <ShellCatAvatar catId={catId} size={24} />
            </span>
          ) : null}
          <span className={`${open ? 'block' : 'line-clamp-2 block'} min-w-0 flex-1`}>
            {lead ? <span className="font-semibold">{lead} </span> : null}
            {title}
          </span>
        </span>
        {source ? (
          <span className="block truncate text-xs" style={{ color: 'var(--shell-muted)' }}>
            {source}
          </span>
        ) : null}
      </button>
      <RowSessionLine open={open} hosted={hosted} approval={item.approval} />
      {open ? <RowBody item={item} id={bodyId} heading={heading} hosted={hosted} onOpen={onOpen} /> : null}
    </li>
  );
}
