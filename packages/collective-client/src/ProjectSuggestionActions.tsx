import { useState } from 'react';
import type { CollectiveRoadmapRecord, CollectiveWorkProjection } from './client-types.js';

export interface ProjectSuggestionEdits {
  readonly title: string;
  readonly intendedOutcome: string;
}

export type ProjectSuggestionDecisionHandler = (
  roadmap: CollectiveRoadmapRecord,
  suggestion: CollectiveWorkProjection,
  decision: 'accept' | 'ignore',
  edits?: ProjectSuggestionEdits,
) => Promise<void>;

export function ProjectSuggestionActions({
  roadmap,
  works,
  currentHumanId,
  onDecide,
}: {
  readonly roadmap: CollectiveRoadmapRecord;
  readonly works: readonly CollectiveWorkProjection[];
  readonly currentHumanId: string;
  readonly onDecide?: ProjectSuggestionDecisionHandler;
}) {
  if (roadmap.accountableHumanId !== currentHumanId) return null;
  const suggestions = works.filter(
    (work) =>
      work.lifecycle === 'proposed' &&
      work.projectSuggestion?.roadmapId === roadmap.roadmapId &&
      work.proposedBy.kind === 'agent',
  );
  if (!suggestions.length) return null;
  const byId = new Map(works.map((work) => [work.workId, work]));
  return (
    <section className="project-suggestions" aria-label="项目建议">
      <header>
        <div>
          <strong>猫的建议</strong>
          <span>{suggestions.length} 项待你判断</span>
        </div>
        <small>接受后才会成为未分配任务；此处不会替任何人接责。</small>
      </header>
      <div className="project-suggestion-list">
        {suggestions.map((suggestion) => (
          <ProjectSuggestionCard
            key={suggestion.workId}
            roadmap={roadmap}
            suggestion={suggestion}
            target={
              suggestion.projectSuggestion?.prerequisiteForWorkId
                ? byId.get(suggestion.projectSuggestion.prerequisiteForWorkId)
                : undefined
            }
            onDecide={onDecide}
          />
        ))}
      </div>
    </section>
  );
}

function ProjectSuggestionCard({
  roadmap,
  suggestion,
  target,
  onDecide,
}: {
  readonly roadmap: CollectiveRoadmapRecord;
  readonly suggestion: CollectiveWorkProjection;
  readonly target?: CollectiveWorkProjection;
  readonly onDecide?: ProjectSuggestionDecisionHandler;
}) {
  const [title, setTitle] = useState(suggestion.title);
  const [intendedOutcome, setIntendedOutcome] = useState(suggestion.intendedOutcome);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const decide = async (decision: 'accept' | 'ignore') => {
    if (!onDecide || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await onDecide(
        roadmap,
        suggestion,
        decision,
        decision === 'accept' ? { title: title.trim(), intendedOutcome: intendedOutcome.trim() } : undefined,
      );
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '项目建议尚未确认，请重试。');
    } finally {
      setBusy(false);
    }
  };
  const agentName = suggestion.proposedBy.kind === 'agent' ? suggestion.proposedBy.displayName : '共同体伙伴';
  return (
    <article className="project-suggestion-card" data-project-suggestion-id={suggestion.workId}>
      <header>
        <div>
          <strong>{agentName} 的建议</strong>
          <span>
            {target ? `建议作为“${target.title}”的前置任务` : '建议加入这个项目'} · #
            {suggestion.sourceLocation.channelId}
          </span>
        </div>
        <span className="project-suggestion-state">待判断</span>
      </header>
      <label>
        <span>任务名称</span>
        <input
          aria-label={`建议任务名称 · ${suggestion.title}`}
          value={title}
          maxLength={200}
          disabled={busy}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      <label>
        <span>完成标准</span>
        <textarea
          aria-label={`建议任务完成标准 · ${suggestion.title}`}
          value={intendedOutcome}
          maxLength={32_000}
          rows={3}
          disabled={busy}
          onChange={(event) => setIntendedOutcome(event.target.value)}
        />
      </label>
      {error && <p role="alert">{error}</p>}
      <footer>
        <button type="button" disabled={busy} onClick={() => void decide('ignore')}>
          忽略建议
        </button>
        <button
          type="button"
          className="project-suggestion-accept"
          disabled={busy || !title.trim() || !intendedOutcome.trim()}
          onClick={() => void decide('accept')}
        >
          纳入项目
        </button>
      </footer>
    </article>
  );
}
