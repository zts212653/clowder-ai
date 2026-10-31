import { MarkdownContent } from '@/components/MarkdownContent';
import { useShellCopy } from '@/components/shell/shell-copy';
import { EditField } from './ProposalCardFields';
import { proposalCardCopy } from './proposal-card.shell-copy';

/** Read the actual first message while editing the proposal; source editing is an explicit choice. */
export function ProposalInitialMessageEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const t = useShellCopy(proposalCardCopy);
  return (
    <div className="space-y-2 rounded-lg border border-[var(--shell-hairline)] p-2">
      <p className="font-medium">{t.initial}</p>
      <div data-testid="proposal-initial-message-editor-preview" className="max-h-64 overflow-auto break-words">
        <MarkdownContent content={value} className="!text-sm" disableCommandPrefix />
      </div>
      <details>
        <summary className="shell-focusable cursor-pointer">{t.editInitialSource}</summary>
        <EditField label={t.initialSource} value={value} onChange={onChange} multiline />
      </details>
    </div>
  );
}
