import type { CollectiveMaterialItem } from '@cat-cafe/shared';
import { useEffect, useState } from 'react';
import type { CollectiveRoadmapRecord, CollectiveWorkProjection } from './client-types.js';
import { type MaterialClause, MaterialDecisionDialog } from './MaterialDecisionDialog.js';
import { useMaterialText } from './material-copy.js';
import { ProjectMaterialCard } from './ProjectMaterialCard.js';
import type { useProjectMaterials } from './ProjectMaterialsContext.js';
import type { MaterialSortChange } from './project-material-client.js';
import type { RoadmapViewState } from './roadmap-view-model.js';

export function ProjectTriagePanel({
  project,
  works,
  currentHumanId,
  feed,
  view,
  onOpenWork,
}: {
  project: CollectiveRoadmapRecord;
  works: readonly CollectiveWorkProjection[];
  currentHumanId: string;
  feed: ReturnType<typeof useProjectMaterials>;
  view: RoadmapViewState;
  onOpenWork(workId: string): void;
}) {
  const t = useMaterialText(),
    canSort = currentHumanId === project.accountableHumanId && project.status === 'active';
  const [selected, setSelected] = useState<{
    item: CollectiveMaterialItem;
    clause: MaterialClause;
    action: 'create' | 'merge';
  }>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(false);
  const decide = async (item: Pick<CollectiveMaterialItem, 'materialId' | 'revision'>, change: MaterialSortChange) => {
    if (!feed.client) throw new Error('Source client unavailable');
    setBusy(true);
    setError(false);
    try {
      await feed.client.sort(item, change);
      setSelected(undefined);
    } catch (error) {
      setError(true);
      throw error;
    } finally {
      await feed.reload();
      setBusy(false);
    }
  };
  const currentSelection = selected && feed.feed.items.find((item) => item.materialId === selected.item.materialId);
  const selectionCurrent =
    !selected || Boolean(currentSelection && currentSelection.revision === selected.item.revision);
  useEffect(() => {
    if (selected && !feed.loading && !selectionCurrent) {
      setSelected(undefined);
      setError(true);
    }
  }, [selected, feed.loading, selectionCurrent]);
  const processed = feed.feed.items.flatMap((item) =>
    Object.entries(item.decisions).map(([clauseId, decision]) => ({ materialId: item.materialId, clauseId, decision })),
  );
  return (
    <section className="project-triage" aria-label={t('sort')}>
      <header>
        <h2>
          {t('sort')} <span>{feed.feed.pendingCount}</span>
        </h2>
        <button type="button" disabled={feed.loading || busy} onClick={() => void feed.reload()}>
          {t('refresh')}
        </button>
      </header>
      <p className="material-note">{t('readonly')}</p>
      {(error || feed.error) && <p role="alert">{error ? t('commandError') : t('failed')}</p>}
      {feed.loading ? (
        <p role="status">{t('loading')}</p>
      ) : (
        <div className="project-triage-columns">
          <main>
            {feed.feed.items.length === 0 && feed.feed.unavailable.length === 0 && <p>{t('empty')}</p>}
            {feed.feed.items.map((item) => (
              <ProjectMaterialCard
                key={item.materialId}
                item={item}
                works={works}
                canSort={canSort}
                busy={busy}
                onDecide={(action, clauseId) =>
                  void decide(
                    item,
                    action === 'ignore' ? { action, ...(clauseId ? { clauseId } : {}) } : { action },
                  ).catch(() => undefined)
                }
                onChoose={(clause, action) => setSelected({ item, clause, action })}
                onOpenWork={onOpenWork}
                onOpenSource={feed.openSource ? () => feed.openSource?.(item.publication, view) : undefined}
              />
            ))}
            {feed.feed.unavailable.map((item) => (
              <article className="project-material-unavailable" key={item.materialId}>
                <p>{t('unavailable')}</p>
                {canSort && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void decide(item, { action: 'ignore' }).catch(() => undefined)}
                  >
                    {t('remove')}
                  </button>
                )}
              </article>
            ))}
          </main>
          <aside className="material-processed">
            <h3>{t('handled')}</h3>
            {processed.map(({ materialId, clauseId, decision }) => {
              const work = works.find((work) => work.workId === decision.workId);
              return (
                <p key={`${materialId}:${clauseId}`}>
                  <span>{decision.actor.displayName}</span>
                  {work ? (
                    <button type="button" onClick={() => onOpenWork(work.workId)}>
                      {work.title} →
                    </button>
                  ) : (
                    <span>{t(decision.action === 'ignore' ? 'ignore' : 'reference')}</span>
                  )}
                </p>
              );
            })}
          </aside>
        </div>
      )}
      {selected && (feed.loading || selectionCurrent) && (
        <MaterialDecisionDialog
          checking={feed.loading}
          {...selected}
          project={project}
          works={works}
          onSubmit={(change) => decide(selected.item, change)}
          onClose={() => setSelected(undefined)}
        />
      )}
    </section>
  );
}
