import type { CollectiveWorkProjection } from './client-types.js';
import { useCollectiveLanguage } from './collective-copy.js';
import { useMaterialText } from './material-copy.js';
import { materialDateHint, materialSourceUrl } from './ProjectMaterialCard.js';
import type { useProjectMaterials } from './ProjectMaterialsContext.js';
import type { RoadmapViewState } from './roadmap-view-model.js';

export function MaterialSources({
  feed,
  work,
  view,
  onSuggestDate,
}: {
  feed: ReturnType<typeof useProjectMaterials>;
  work?: CollectiveWorkProjection;
  view: RoadmapViewState;
  onSuggestDate?(hint: { text: string; eventId: string }): void;
}) {
  const t = useMaterialText();
  const en = useCollectiveLanguage() === 'en';
  const references = work
    ? (work.materialLinks ?? [])
    : feed.feed.items
        .filter((item) => item.disposition?.action === 'reference')
        .map((item) => ({ materialId: item.materialId }));
  if (!references.length) return null;
  return (
    <section className="material-sources">
      <h4>{t(work ? 'taskSources' : 'references')}</h4>
      {references.map((link, index) => {
        const item = feed.feed.items.find((item) => item.materialId === link.materialId),
          url = item && materialSourceUrl(item);
        const linkedWitness = work?.materialLinks?.[index]?.witness;
        const clauseId = work?.materialLinks?.[index]?.clauseId;
        const clause = item?.material.clauses.find((clause) => clause.clauseId === clauseId);
        const hint = clause && materialDateHint(clause);
        const changed =
          item &&
          (linkedWitness
            ? !sameCollectiveMaterialWitness(linkedWitness, item.currentWitness)
            : item.currentness === 'revised');
        return (
          <div key={`${link.materialId}:${index}`}>
            {item ? (
              <>
                {url ? (
                  <a href={url} target="_blank" rel="noreferrer">
                    {item.material.title} ↗
                  </a>
                ) : (
                  <button type="button" onClick={() => feed.openSource?.(item.publication, view)}>
                    {item.material.title}
                  </button>
                )}
                {changed && <small>{t('revised')}</small>}
                {hint && onSuggestDate && (
                  <button
                    type="button"
                    onClick={() => onSuggestDate({ text: hint, eventId: item.publication.sourceEventId })}
                  >
                    {en ? `Consider “${hint}” as a deadline…` : `考虑把「${hint}」设成截止…`}
                  </button>
                )}
              </>
            ) : (
              <span>{t(feed.loading ? 'loading' : 'unavailable')}</span>
            )}
          </div>
        );
      })}
    </section>
  );
}

import { sameCollectiveMaterialWitness } from '@cat-cafe/shared';
