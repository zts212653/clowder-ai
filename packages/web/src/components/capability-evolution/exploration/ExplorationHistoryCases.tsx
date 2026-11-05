import { refIdentity } from '@cat-cafe/shared';
import { useState } from 'react';
import { MarkdownContent } from '@/components/MarkdownContent';
import type { WorktreeEntry } from '@/hooks/useWorkspace';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { EvolutionSource } from '../EvolutionVersionEvidence';
import { ExplorationDetailStatus } from './ExplorationDetailStatus';
import type { useExplorationWorkspace } from './use-exploration-workspace';

function localCasePath(href?: string) {
  if (!href) return undefined;
  const url = new URL(href, 'https://invalid.local');
  if (url.origin !== 'https://github.com') return undefined;
  const match = /^\/zts212653\/cat-cafe\/blob\/[a-f0-9]{40}\/(docs\/[A-Za-z0-9_./-]+)$/.exec(url.pathname);
  return match?.[1] && !match[1].split('/').includes('..') ? match[1] : undefined;
}
function HistorySourceLink({ href }: { href?: string }) {
  const path = localCasePath(href);
  const [opening, setOpening] = useState(false);
  const [sourceError, setSourceError] = useState('');
  const openSource = async (casePath: string) => {
    setOpening(true);
    setSourceError('');
    try {
      // No project override: these GitHub sources belong to the Café's repository,
      // even when its evolution Program is being read from another project's thread.
      const response = await apiFetch('/api/workspace/worktrees');
      if (!response.ok) throw new Error('原文工作区暂不可读，可以重试或查看下方历史原件。');
      const result: { worktrees: WorktreeEntry[] } = await response.json();
      const root = result.worktrees.find((entry) => entry.branch === 'main');
      if (!root) throw new Error('尚未定位原文工作区，可以查看下方历史原件。');
      useChatStore.getState().setWorkspaceOpenFile(casePath, null, root.rootIdentity ?? root.id);
    } catch (error) {
      setSourceError(error instanceof Error ? error.message : '原文暂时无法打开。');
    } finally {
      setOpening(false);
    }
  };
  if (!href) return null;
  return (
    <>
      {path ? (
        <button type="button" className="exploration-link" disabled={opening} onClick={() => void openSource(path)}>
          {opening ? '正在打开原案例…' : '看原案例 →'}
        </button>
      ) : (
        <a className="exploration-link" href={href} target="_blank" rel="noreferrer">
          看原案例 →
        </a>
      )}
      {sourceError && <p role="alert">{sourceError}</p>}
    </>
  );
}

export function ExplorationHistoryCases({ workspace }: { workspace: ReturnType<typeof useExplorationWorkspace> }) {
  const { experiments, experiment, record, detail, resource, change } = workspace;
  const [collapsed, setCollapsed] = useState<string>();
  const original = record?.sources[0];
  return (
    <section className="exploration-history-cases" aria-label="这一步的错题">
      <h4>这一步的错题（{experiments.length}）</h4>
      {experiments.map((run) => {
        const key = refIdentity(run.experimentRef);
        const readingKey = run.experimentRef.ownerStateRef;
        const selected = experiment && key === refIdentity(experiment.experimentRef);
        const open = selected && collapsed !== readingKey;
        return (
          <article key={readingKey}>
            <button
              type="button"
              className="exploration-history-case-toggle"
              aria-expanded={Boolean(open)}
              onClick={() => {
                setCollapsed(open ? readingKey : undefined);
                if (!selected) change({ selectedExperimentRef: run.experimentRef, selectedCaseId: undefined });
              }}
            >
              <time>{run.conditions.window.label}</time>
              <span>{run.title}</span>
              <span aria-hidden="true">{open ? '−' : '+'}</span>
            </button>
            {open && (
              <div className="exploration-history-case-body">
                {resource.loading && <output>正在读取这道错题…</output>}
                {resource.error && (
                  <p role="alert">
                    {resource.error}{' '}
                    <button type="button" onClick={resource.retry}>
                      重试
                    </button>
                  </p>
                )}
                <ExplorationDetailStatus detail={detail} retry={resource.retry} />
                {record && (
                  <>
                    {record.bodyMarkdown ? (
                      <MarkdownContent
                        content={record.bodyMarkdown}
                        className="exploration-history-authored-body"
                        disableCommandPrefix
                      />
                    ) : (
                      <dl className="exploration-output-reading">
                        {record.output.map((part, index) => (
                          <div key={`${part.label}:${index}`}>
                            <dt>{part.label}</dt>
                            <dd>{part.value}</dd>
                          </div>
                        ))}
                        <div>
                          <dt>后来怎样了</dt>
                          <dd>{record.result.label}</dd>
                        </div>
                      </dl>
                    )}
                    <HistorySourceLink key={record.caseId} href={original?.href} />
                    <details>
                      <summary>历史原件与后续来源</summary>
                      {record.sources.map((entry, index) => (
                        <EvolutionSource
                          key={`${refIdentity(entry.ref)}:${index}`}
                          label={entry.label}
                          source={entry.ref}
                          href={entry.href}
                        />
                      ))}
                    </details>
                  </>
                )}
              </div>
            )}
          </article>
        );
      })}
      {!experiments.length && <p>这一步尚未挂入具体错题。</p>}
    </section>
  );
}
