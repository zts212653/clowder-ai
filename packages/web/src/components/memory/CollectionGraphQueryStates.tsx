'use client';

import type React from 'react';

export interface GraphQueryCandidate {
  anchor: string;
  title: string;
  kind: string;
  collectionId: string;
  source?: string;
  matchReason: 'anchor' | 'title' | 'source' | 'summary' | 'keyword' | 'content';
  snippet?: string;
  edgeCount?: number;
}

export function GraphSearchForm({
  inputRef,
  onSubmit,
}: {
  inputRef: React.RefObject<HTMLInputElement>;
  onSubmit: (e: React.FormEvent) => void;
}) {
  return (
    <form onSubmit={onSubmit} className="mb-4 flex flex-col gap-2 sm:flex-row">
      <input
        ref={inputRef}
        type="text"
        defaultValue=""
        placeholder="搜索知识或输入锚点（如 F186、harness）"
        className="min-w-0 flex-1 rounded border border-cafe bg-white px-3 py-1.5 text-sm text-cafe-primary"
        data-testid="graph-anchor-input"
      />
      <button
        type="submit"
        className="rounded bg-cafe-accent px-3 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-cafe-interactive sm:w-auto"
        data-testid="graph-fetch-btn"
      >
        查看图谱
      </button>
    </form>
  );
}

export function GraphCandidates({
  candidates,
  onSelect,
}: {
  candidates: GraphQueryCandidate[];
  onSelect: (anchor: string, collectionId: string) => void;
}) {
  return (
    <div className="rounded-lg bg-[var(--console-card-bg)] p-3 shadow-sm" data-testid="graph-candidates">
      <div className="mb-2 text-xs font-bold uppercase tracking-wide text-cafe-secondary">候选节点</div>
      <div className="space-y-2">
        {candidates.map((candidate) => (
          <button
            className="w-full rounded-md border border-[#e5dacd] bg-[#fffdf8] p-3 text-left transition-colors hover:border-cafe-accent hover:bg-[#f8fbff]"
            data-testid={`graph-candidate-${candidate.anchor}`}
            key={`${candidate.collectionId}:${candidate.anchor}`}
            onClick={() => onSelect(candidate.anchor, candidate.collectionId)}
            type="button"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-black text-cafe-primary">{candidate.anchor}</span>
              <span className="rounded bg-cafe-surface px-1.5 py-0.5 text-[10px] font-bold text-cafe-secondary">
                {candidate.kind}
              </span>
              <span className="text-[10px] font-semibold text-cafe-secondary">{candidate.edgeCount ?? 0} 条关系</span>
            </div>
            <div className="mt-1 text-sm font-semibold text-cafe-primary">{candidate.title}</div>
            <div className="mt-1 flex flex-wrap gap-2 text-[10px] text-cafe-secondary">
              <span>{candidate.collectionId}</span>
              {candidate.source && <span>{candidate.source}</span>}
              <span>匹配: {candidate.matchReason}</span>
            </div>
            {candidate.snippet && <div className="mt-2 text-xs text-cafe-secondary">{candidate.snippet}</div>}
          </button>
        ))}
      </div>
    </div>
  );
}

export function GraphNoMatch({ examples, message }: { examples: string[]; message: string }) {
  return (
    <div
      className="rounded-lg bg-[var(--console-card-bg)] p-4 text-sm text-cafe-secondary"
      data-testid="graph-no-match"
    >
      <div className="font-semibold text-cafe-primary">{message}</div>
      <div className="mt-2 text-xs">试试精确锚点、标题关键词、来源路径或概念短语。</div>
      <div className="mt-3 flex flex-wrap gap-2">
        {examples.map((example) => (
          <span className="rounded bg-cafe-surface px-2 py-1 text-xs font-semibold" key={example}>
            {example}
          </span>
        ))}
      </div>
    </div>
  );
}

export function GraphNoEdgesNote() {
  return (
    <div
      className="mb-3 rounded-md border border-[#e5dacd] bg-white px-3 py-2 text-xs font-semibold text-cafe-secondary"
      data-testid="graph-no-edges-note"
    >
      暂无关联边：这个节点存在，但当前深度下没有可见的 graph 关系。Inspector 仍会显示节点信息。
    </div>
  );
}
