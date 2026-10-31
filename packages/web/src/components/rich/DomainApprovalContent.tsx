import type { ApprovalHubItem } from '@cat-cafe/shared';
import type { ReactNode } from 'react';
import { MarkdownContent } from '@/components/MarkdownContent';
import { useShellCopy } from '@/components/shell/shell-copy';
import { useThreadDisplayInfo } from '@/hooks/useThreadDisplayInfo';
import { approvalOriginThreadId } from '@/lib/approval-navigation';
import { ApprovalMember } from './ApprovalMember';
import { domainApprovalCopy } from './domain-approval.shell-copy';

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <dt className="text-[var(--shell-muted)]">{label}:</dt>
      <dd className="m-0 min-w-0 break-words">{children}</dd>
    </div>
  );
}
function ThreadName({ id }: { id: string }) {
  const { currentThread } = useThreadDisplayInfo(id);
  const t = useShellCopy(domainApprovalCopy);
  return <>{currentThread?.title || t.unknownThread}</>;
}
function OriginalText({ label, children }: { label: string; children: ReactNode }) {
  return (
    <details className="rounded-lg border border-[var(--shell-hairline)] px-3 py-2">
      <summary className="shell-focusable cursor-pointer font-medium">{label}</summary>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: bounded original text supports keyboard scrolling */}
      <section aria-label={label} className="mt-2 max-h-64 overflow-y-auto break-words" tabIndex={0}>
        {children}
      </section>
    </details>
  );
}

export function DispatchApprovalContent({ item }: { item: ApprovalHubItem }) {
  const t = useShellCopy(domainApprovalCopy);
  const source = approvalOriginThreadId(item.navigation),
    target = text(item.detail.targetThreadId);
  const criterion = item.detail.terminalPredicate;
  const kind = criterion && typeof criterion === 'object' && 'kind' in criterion ? criterion.kind : null;
  const completion =
    typeof kind === 'string' && Object.hasOwn(t.completions, kind)
      ? t.completions[kind as keyof typeof t.completions]
      : t.unknownCompletion;
  return (
    <>
      <dl className="m-0 space-y-2">
        <Fact label={t.from}>{source ? <ThreadName id={source} /> : t.unknownThread}</Fact>
        <Fact label={t.to}>{target ? <ThreadName id={target} /> : t.unknownThread}</Fact>
        <Fact label={t.assigned}>
          {strings(item.detail.targetCats).map((catId) => (
            <ApprovalMember key={catId} catId={catId} />
          ))}
        </Fact>
        <Fact label={t.completion}>{completion}</Fact>
      </dl>
      <OriginalText label={t.request}>
        <MarkdownContent content={text(item.detail.content)} disableCommandPrefix />
      </OriginalText>
    </>
  );
}

export function TasteApprovalContent({ item }: { item: ApprovalHubItem }) {
  const t = useShellCopy(domainApprovalCopy);
  const dimension = text(item.detail.dimension);
  const correction = item.detail.correction;
  const patch =
    correction && typeof correction === 'object' && 'suggestedPatch' in correction ? correction.suggestedPatch : null;
  return (
    <>
      {text(item.detail.takeaway) ? (
        <MarkdownContent content={text(item.detail.takeaway)} disableCommandPrefix />
      ) : null}
      <dl className="m-0 space-y-2">
        <Fact label={t.scene}>{text(item.detail.scene)}</Fact>
        <Fact label={t.dimension}>
          {Object.hasOwn(t.dimensions, dimension) ? t.dimensions[dimension as keyof typeof t.dimensions] : t.unknown}
        </Fact>
        <Fact label={t.tags}>{strings(item.detail.tags).join(' · ')}</Fact>
        <Fact label={t.privacy}>
          {item.detail.privacy === 'sensitive'
            ? t.sensitive
            : item.detail.privacy === 'public'
              ? t.public
              : t.privacyUnknown}
        </Fact>
      </dl>
      <OriginalText label={t.original}>
        <blockquote className="m-0 border-l-2 border-[var(--shell-hairline)] pl-3">
          <MarkdownContent content={text(item.detail.quote)} disableCommandPrefix />
        </blockquote>
        {correction && typeof correction === 'object' && 'reason' in correction ? (
          <p>
            {Object.hasOwn(t.corrections, text(correction.reason))
              ? t.corrections[text(correction.reason) as keyof typeof t.corrections]
              : t.unknown}
          </p>
        ) : null}
        {patch && typeof patch === 'object'
          ? ['takeaway', 'scene', 'quotes', 'tags', 'dimension'].map((key) =>
              key in patch ? (
                <MarkdownContent
                  key={key}
                  content={
                    Array.isArray((patch as Record<string, unknown>)[key])
                      ? strings((patch as Record<string, unknown>)[key]).join('\n\n')
                      : key === 'dimension' &&
                          Object.hasOwn(t.dimensions, text((patch as Record<string, unknown>)[key]))
                        ? t.dimensions[text((patch as Record<string, unknown>)[key]) as keyof typeof t.dimensions]
                        : text((patch as Record<string, unknown>)[key])
                  }
                  disableCommandPrefix
                />
              ) : null,
            )
          : null}
      </OriginalText>
    </>
  );
}

export function EntityApprovalContent({ item }: { item: ApprovalHubItem }) {
  const t = useShellCopy(domainApprovalCopy);
  const types: Record<string, string> = {
    concept: t.concept,
    person: t.person,
    cat: t.cat,
    feature: t.feature,
    external: t.external,
  };
  const stances: Record<string, string> = {
    endorsed: t.endorsed,
    rejected: t.rejected,
    critique_target: t.critique_target,
    deliverable_only: t.deliverable_only,
    unknown: t.stanceUnknown,
  };
  return (
    <>
      <h3 className="m-0 break-words text-sm font-semibold">{text(item.detail.canonicalName) || t.unknown}</h3>
      <dl className="m-0 space-y-2">
        <Fact label={t.type}>{types[text(item.detail.entityType)] ?? t.unknown}</Fact>
        <Fact label={t.aliases}>{strings(item.detail.aliases).join(' · ')}</Fact>
        <Fact label={t.stance}>{stances[text(item.detail.stance)] ?? t.unknown}</Fact>
      </dl>
      <OriginalText label={t.rationale}>
        <MarkdownContent content={text(item.detail.rationale)} disableCommandPrefix />
      </OriginalText>
      <details className="text-xs text-[var(--shell-muted)]" data-testid="entity-proposal-identity">
        <summary className="shell-focusable cursor-pointer">{t.identity}</summary>
        <p className="break-all">
          {t.proposalId}: {item.proposalId}
        </p>
        <p className="break-all">
          {t.entityId}: {text(item.detail.entityId)}
        </p>
      </details>
    </>
  );
}
