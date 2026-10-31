import { WorkspaceFileViewer } from '@/components/workspace/WorkspaceFileViewer';

/** The ledger projects its verified text into the common document reader; it does not render or listen again. */
export function WorkspaceContentReviewText({
  text,
  markdown,
  onQuoteSelected,
  locator,
  scrollToLine,
  revision,
}: {
  readonly text: string;
  readonly markdown: boolean;
  readonly onQuoteSelected: (quote: string) => void;
  readonly locator: { worktreeId: string; path: string };
  readonly scrollToLine?: number | null;
  readonly revision: string;
}) {
  return (
    <WorkspaceFileViewer
      source={{ kind: 'workspace', ...locator }}
      file={{
        path: locator.path,
        content: text,
        sha256: revision.replace(/^sha256:/, ''),
        mime: markdown ? 'text/markdown' : 'text/plain',
        size: new TextEncoder().encode(text).length,
        truncated: false,
      }}
      readOnlyReason="当前为批注视图；编辑由原文件的协作操作接管"
      showFileQuotes
      scrollToLine={scrollToLine}
      onQuoteSelected={onQuoteSelected}
    />
  );
}
