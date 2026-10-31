'use client';
import { type collectiveArtifactCatalogueHistoryPageSchema, collectiveDocumentTargetKey } from '@cat-cafe/shared';
import { useState } from 'react';
import { useContentOpen } from '@/components/content-review/useContentOpen';
import { useShellCopy } from '@/components/shell/shell-copy';
import { WorkspaceFileViewer } from '@/components/workspace/WorkspaceFileViewer';
import type { CollectiveDocumentHostTarget } from '../workbench/collective-document-surface';
import { CollectiveDocumentComments } from './CollectiveDocumentComments';
import { collectiveDocumentCopy } from './collective-document.shell-copy';
import { useCollectiveDocument } from './use-collective-document';

type History = ReturnType<typeof collectiveArtifactCatalogueHistoryPageSchema.parse>;
export function CollectiveDocumentSurface({ source }: { source: CollectiveDocumentHostTarget }) {
  const reading = useCollectiveDocument(source),
    opening = useContentOpen(),
    copy = useShellCopy(collectiveDocumentCopy);
  const [history, setHistory] = useState<History>(),
    [historyError, setHistoryError] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [notice, setNotice] = useState<string>();
  const back = (destination: 'project' | 'source' | 'discussion', target = source.target) => {
    if (!reading.port?.returnTo(target, destination))
      window.dispatchEvent(new CustomEvent('collective:show-document-host', { detail: { hostKey: source.hostKey } }));
  };
  const loadHistory = async (offset = 0) => {
    setHistoryOpen(true);
    setHistoryError(false);
    const result = await reading.port?.request(source.target, { kind: 'history', offset });
    if (result?.kind === 'history')
      setHistory((current) =>
        offset ? { ...result.value, versions: [...(current?.versions ?? []), ...result.value.versions] } : result.value,
      );
    else {
      setHistory(undefined);
      setHistoryError(true);
    }
  };
  if (!reading.reads)
    return (
      <div className="flex h-full flex-col gap-3 bg-cafe-surface p-5" data-testid="collective-document-unavailable">
        <p role={reading.error ? 'alert' : 'status'}>{reading.error ?? copy.reading}</p>
        <button
          type="button"
          className="self-start rounded border border-cafe px-3 py-1 text-sm"
          onClick={() => back(source.target.projectReturn ? 'project' : 'source')}
        >
          {source.target.projectReturn ? copy.projectBack : copy.sourceBack}
        </button>
        {reading.port && (
          <button type="button" className="min-h-8 self-start px-2 text-sm" onClick={() => void reading.reload()}>
            {copy.reload}
          </button>
        )}
      </div>
    );
  return (
    <div className="flex h-full min-h-0 flex-col bg-cafe-surface" data-testid="collective-document-surface">
      <div className="flex flex-wrap items-center gap-2 border-b border-cafe-subtle px-3 py-2 text-xs text-cafe-muted">
        <button
          type="button"
          className="min-h-8 px-2"
          onClick={() => back(source.target.projectReturn ? 'project' : 'source')}
        >
          {source.target.projectReturn ? copy.projectBack : copy.sourceBack}
        </button>
        <span>· {copy.exactVersion}</span>
        <button
          type="button"
          className="ml-auto min-h-8 px-2"
          onClick={() => (historyOpen ? setHistoryOpen(false) : void loadHistory())}
        >
          {copy.history}
        </button>
      </div>
      {historyOpen && (
        <section className="max-h-56 shrink-0 overflow-auto border-b border-cafe-subtle p-3" aria-label={copy.history}>
          {historyError && <p role="alert">{copy.historyUnavailable}</p>}
          {history?.versions.map((version) => (
            <div key={version.ownerRevision} className="flex flex-wrap items-start gap-3 py-2 text-xs">
              <button
                type="button"
                className="min-h-8 px-2 underline"
                onClick={() =>
                  void opening.openContent({
                    kind: 'collective',
                    hostKey: source.hostKey,
                    target: {
                      ...source.target,
                      ownerRevision: version.ownerRevision,
                      comparisonOwnerRevision: undefined,
                    },
                  })
                }
              >
                v{version.ownerRevision}
              </button>
              <time>{new Date(version.recordedAt).toLocaleString()}</time>
              <span>{version.changeSummary ?? copy.noSummary}</span>
            </div>
          ))}
          {history?.nextOffset !== undefined && (
            <button type="button" className="min-h-8 px-2" onClick={() => void loadHistory(history.nextOffset)}>
              {copy.older}
            </button>
          )}
        </section>
      )}
      {notice && (
        <p role="status" className="px-3 py-2 text-xs">
          {notice}
        </p>
      )}
      <div className={`flex min-h-0 flex-1 ${reading.reads.length > 1 ? 'flex-col md:flex-row' : ''}`}>
        {reading.reads.map((read) => {
          const value = read.value,
            key = `${collectiveDocumentTargetKey(source.target)}:${value.ownerRevision}`;
          const filename = /\.md$/i.test(read.title) ? read.title : `${read.title}.md`;
          const target = { ...source.target, ownerRevision: value.ownerRevision, comparisonOwnerRevision: undefined };
          return (
            <div
              key={key}
              className="flex min-h-0 min-w-0 flex-1 flex-col border-cafe-subtle md:border-r"
              data-owner-revision={value.ownerRevision}
            >
              <div className="px-3 py-1 text-xs text-cafe-muted">
                {copy.viewing} v{value.ownerRevision}
              </div>
              <WorkspaceFileViewer
                file={{
                  path: filename,
                  content: value.text,
                  sha256: value.blobDigest.replace('sha256:', ''),
                  size: new TextEncoder().encode(value.text).length,
                  mime: 'text/markdown',
                  truncated: false,
                }}
                source={{ kind: 'owner', key }}
                showFileQuotes={false}
                onOwnerQuote={
                  value.view.canWrite
                    ? (selection) => {
                        if (
                          selection.selectionStart === undefined ||
                          selection.selectionEnd === undefined ||
                          `sha256:${selection.version}` !== value.blobDigest ||
                          selection.selectionStart < 0 ||
                          selection.selectionEnd > value.text.length ||
                          selection.selectionStart >= selection.selectionEnd
                        )
                          return false;
                        void (async () => {
                          const digest = new Uint8Array(
                            await crypto.subtle.digest(
                              'SHA-256',
                              new TextEncoder().encode(
                                value.text.slice(selection.selectionStart, selection.selectionEnd),
                              ),
                            ),
                          );
                          const quoteDigest = `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
                          const result = await reading.port?.request(target, {
                            kind: 'stage-selection',
                            selection: { start: selection.selectionStart!, end: selection.selectionEnd!, quoteDigest },
                          });
                          if (result?.kind === 'selection_staged') reading.port?.returnTo(target, 'discussion');
                          else setNotice(copy.stageFailed);
                        })();
                        return true;
                      }
                    : undefined
                }
                ownerQuoteLabel={copy.quote}
                readOnlyReason={copy.readOnly}
                reviewAction={
                  <button
                    type="button"
                    className="min-h-8 shrink-0 whitespace-nowrap px-2 text-xs"
                    aria-label={copy.discuss}
                    title={copy.discuss}
                    onClick={() => back('discussion', target)}
                  >
                    {copy.discussShort}
                  </button>
                }
              />
              {reading.reads!.length === 1 && <CollectiveDocumentComments value={value} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}
