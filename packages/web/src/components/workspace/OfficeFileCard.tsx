import type { FileData } from '@/hooks/useWorkspace';
import { ChatReferenceIcon, chatReferenceFileType } from '../chat-references/ChatReferenceIcon';
import { chatReferenceCopy } from '../chat-references/chat-reference.shell-copy';
import { useShellCopy } from '../shell/shell-copy';
import { workspaceFileReference } from './workspace-file-reference';

/** Uses the existing file tab/chrome; the body is honest metadata, without a second viewer. */
export function OfficeFileCard({
  file,
  worktreeId,
  root,
}: {
  file: FileData;
  worktreeId: string | null;
  root?: string;
}) {
  const t = useShellCopy(chatReferenceCopy);
  const target = workspaceFileReference(file, worktreeId ?? '', root);
  return (
    <section
      data-testid="workspace-office-file"
      className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
    >
      <ChatReferenceIcon target={target} />
      <h3 className="max-w-full break-all font-semibold">{file.path.split('/').at(-1)}</h3>
      <p className="text-sm text-[var(--shell-muted)]">
        {chatReferenceFileType(target)} · {(file.size / 1024).toFixed(1)} KB
        {file.pageCount !== undefined
          ? ` · ${file.pageCount} ${t[file.pageUnit ?? 'pages']}`
          : ` · ${t.pageCountUnknown}`}
      </p>
      <p className="text-xs text-[var(--shell-muted)]">{t.officeUnavailable}</p>
    </section>
  );
}
