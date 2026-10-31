import type { RichCardBlock } from '@cat-cafe/shared';
import type { ReactNode } from 'react';
import { MarkdownContent } from '@/components/MarkdownContent';
import { originalApprovalCopy } from '../shell/mailbox/original-approval.shell-copy';
import { useShellCopy } from '../shell/shell-copy';
import { useShellLanguage } from '../shell/shell-language';
import { ApprovalResultRow } from './ApprovalResultRow';

export function ProfileUpdateResult({
  block,
  status,
  actions,
  error,
}: {
  block: RichCardBlock;
  status: 'approved' | 'rejected';
  actions?: ReactNode;
  error: string | null;
}) {
  const original = useShellCopy(originalApprovalCopy);
  const label = status === 'approved' ? original.approvedProfile : original.rejectedProfile;
  return (
    <ApprovalResultRow status={status} label={label}>
      <h3 className="text-sm font-semibold">{original.profileTitle}</h3>
      <ProfileUpdateCardContent block={block} />
      {actions}
      {error ? <p role="alert">{error}</p> : null}
    </ApprovalResultRow>
  );
}

/** Decode only the producer's fenced before/after layout, never decision authority. Unrecognized content stays intact. */
export function profileUpdateDiff(body: string) {
  const match = body.match(
    /^([\s\S]*)\n\n\*\*当前内容：\*\*\n(`{3,})\n([\s\S]*?)\n\2\n\n\*\*提议改为：\*\*\n\2\n([\s\S]*?)\n\2$/,
  );
  return match ? { rationale: match[1], before: match[3], after: match[4] } : null;
}

export function ProfileUpdateCardContent({ block, settled = false }: { block: RichCardBlock; settled?: boolean }) {
  const t = useShellCopy(originalApprovalCopy);
  const language = useShellLanguage();
  const separator = language === 'en' ? ': ' : '：';
  const diff = profileUpdateDiff(block.bodyMarkdown ?? '');
  const rawSignal = block.fields?.find((field) => field.label === '来源')?.value.split('（')[0];
  const signal =
    rawSignal && Object.hasOwn(t.signalKinds, rawSignal)
      ? t.signalKinds[rawSignal as keyof typeof t.signalKinds]
      : t.signalUnavailable;
  const technicalLabels = new Map([
    ['目标', t.technicalTarget],
    ['来源', t.technicalSource],
  ]);
  return (
    <div className="mt-2 space-y-2 text-xs">
      {!settled && diff?.rationale ? (
        <MarkdownContent content={diff.rationale} className="!text-xs" disableCommandPrefix />
      ) : null}
      <dl className="space-y-1">
        <div>
          <dt className="inline text-[var(--shell-muted)]">
            {t.target}
            {separator}
          </dt>
          <dd className="inline">
            {block.fields?.some((field) => field.label === '目标' && field.value === 'capsule.md')
              ? t.openingCapsule
              : block.title.includes('（corpus）')
                ? t.sharedProfile
                : t.relationshipProfile}
          </dd>
        </div>
        <div>
          <dt className="inline text-[var(--shell-muted)]">
            {t.signal}
            {separator}
          </dt>
          <dd className="inline">{signal}</dd>
        </div>
      </dl>
      {!settled ? (
        <details
          data-testid="original-approval-long-content"
          className="rounded-lg border border-[var(--shell-hairline)] p-2"
        >
          <summary className="shell-focusable cursor-pointer font-medium">{t.profileDetails}</summary>
          <section
            aria-label={t.profileDetails}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: bounded original text supports keyboard scrolling
            tabIndex={0}
            className="mt-2 max-h-64 overflow-y-auto break-words space-y-3"
          >
            {diff ? (
              <>
                <section>
                  <h4 className="font-semibold">{t.before}</h4>
                  <MarkdownContent content={diff.before} className="!text-xs" disableCommandPrefix />
                </section>
                <section>
                  <h4 className="font-semibold">{t.after}</h4>
                  <MarkdownContent content={diff.after} className="!text-xs" disableCommandPrefix />
                </section>
              </>
            ) : (
              <MarkdownContent content={block.bodyMarkdown ?? ''} className="!text-xs" disableCommandPrefix />
            )}
          </section>
        </details>
      ) : null}
      {block.fields?.length ? (
        <details className="text-[var(--shell-muted)]">
          <summary className="shell-focusable cursor-pointer">{t.technical}</summary>
          <dl className="mt-1 space-y-1 break-all">
            {block.fields.map((field, index) => (
              <div key={`${field.label}-${index}`}>
                <dt className="inline">
                  {technicalLabels.get(field.label) ?? field.label}
                  {separator}
                </dt>
                <dd className="inline">
                  {language === 'en' && field.label === '来源' && rawSignal && Object.hasOwn(t.signalKinds, rawSignal)
                    ? `${rawSignal} (${signal})`
                    : field.value}
                </dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}
    </div>
  );
}
