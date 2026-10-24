import type { RichCardBlock } from '@cat-cafe/shared';
import type { ReactNode } from 'react';
import { MarkdownContent } from '../MarkdownContent';
import { originalApprovalCopy } from '../shell/mailbox/original-approval.shell-copy';
import { useShellCopy } from '../shell/shell-copy';
import { ApprovalResultRow } from './ApprovalResultRow';
import { HandoffCardContent } from './HandoffCardContent';

export function HandoffResultRow({
  status,
  block,
  title,
  body,
  error,
  actions,
}: {
  status: 'approved' | 'rejected' | 'expired';
  block: RichCardBlock;
  title: string;
  body?: string;
  error: string | null;
  actions?: ReactNode;
}) {
  const t = useShellCopy(originalApprovalCopy);
  const label = status === 'approved' ? t.handoffApproved : status === 'rejected' ? t.handoffRejected : t.expired;
  return (
    <ApprovalResultRow status={status} label={label}>
      <h3 className="text-sm font-semibold">{title}</h3>
      {body ? <MarkdownContent content={body} className="!text-xs" disableCommandPrefix /> : null}
      <HandoffCardContent fields={block.fields ?? []} />
      {actions}
      {error ? <p role="alert">{error}</p> : null}
    </ApprovalResultRow>
  );
}
