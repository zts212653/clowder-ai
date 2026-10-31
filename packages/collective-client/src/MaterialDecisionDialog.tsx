import type { CollectiveMaterialItem } from '@cat-cafe/shared';
import { useState } from 'react';
import type { CollectiveRoadmapRecord, CollectiveWorkProjection } from './client-types.js';
import { MaterialDialogFrame } from './MaterialDialogFrame.js';
import { useMaterialText } from './material-copy.js';
import type { MaterialSortChange } from './project-material-client.js';

export type MaterialClause = CollectiveMaterialItem['material']['clauses'][number];
export function MaterialDecisionDialog({
  item,
  clause,
  action,
  project,
  works,
  onSubmit,
  onClose,
  checking = false,
}: {
  item: CollectiveMaterialItem;
  clause: MaterialClause;
  action: 'create' | 'merge';
  project: CollectiveRoadmapRecord;
  checking?: boolean;
  works: readonly CollectiveWorkProjection[];
  onSubmit(change: MaterialSortChange): Promise<void>;
  onClose(): void;
}) {
  const t = useMaterialText();
  const [title, setTitle] = useState(
    item.material.kind === 'meeting' ? clause.text.slice(0, 120) : item.material.title.slice(0, 200),
  );
  const [outcome, setOutcome] = useState(clause.text),
    [search, setSearch] = useState('');
  const [target, setTarget] = useState(clause.suggestedWorkId ?? ''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(false);
  const candidates = works
    .filter((work) => project.workIds.includes(work.workId) && work.lifecycle !== 'proposed')
    .filter((work) => work.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
    .sort(
      (left, right) => Number(right.workId === clause.suggestedWorkId) - Number(left.workId === clause.suggestedWorkId),
    );
  const selected = candidates.find((work) => work.workId === target);
  const submit = async () => {
    setBusy(true);
    setError(false);
    try {
      if (action === 'create')
        await onSubmit({
          action,
          clauseId: clause.clauseId,
          expectedRoadmapRevision: project.revision,
          title,
          intendedOutcome: outcome,
        });
      else if (selected)
        await onSubmit({
          action,
          clauseId: clause.clauseId,
          workId: selected.workId,
          expectedWorkRevision: selected.revision,
        });
      else throw new Error('Choose a Task');
      onClose();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <MaterialDialogFrame label={t(action)} onClose={onClose} busy={busy}>
      <h2>{t(action)}</h2>
      <p>
        {project.title} · {t('sourceLocked')}
      </p>
      <blockquote>{checking ? t('loading') : clause.text}</blockquote>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {action === 'create' ? (
          <>
            <label>
              {t('name')}
              <input value={title} maxLength={200} required onChange={(event) => setTitle(event.target.value)} />
            </label>
            <label>
              {t('outcome')}
              <textarea
                value={outcome}
                maxLength={32_000}
                required
                onChange={(event) => setOutcome(event.target.value)}
              />
            </label>
            <p className="material-defaults">{t('unassigned')}</p>
            <p>{t('hint')}</p>
          </>
        ) : (
          <>
            <label>
              {t('search')}
              <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} />
            </label>
            <fieldset className="material-task-choices">
              <legend>{t('merge')}</legend>
              {candidates.map((work) => (
                <label key={work.workId}>
                  <input
                    type="radio"
                    name="material-task"
                    value={work.workId}
                    checked={target === work.workId}
                    onChange={() => setTarget(work.workId)}
                  />
                  <span>{work.title}</span>
                </label>
              ))}
            </fieldset>
          </>
        )}
        {error && <p role="alert">{t('commandError')}</p>}
        <footer>
          <button type="button" disabled={busy} onClick={onClose}>
            {t('cancel')}
          </button>
          <button
            type="submit"
            className="primary"
            disabled={busy || checking || (action === 'merge' ? !selected : !title.trim() || !outcome.trim())}
          >
            {t('save')}
          </button>
        </footer>
      </form>
    </MaterialDialogFrame>
  );
}
