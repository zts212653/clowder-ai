import type { CollectiveMaterialItem } from '@cat-cafe/shared';
import type { CollectiveWorkProjection } from './client-types.js';
import { useCollectiveLanguage } from './collective-copy.js';
import type { MaterialClause } from './MaterialDecisionDialog.js';
import { useMaterialText } from './material-copy.js';

export function materialDateHint(clause: MaterialClause): string | undefined {
  return (
    clause.dateHint ??
    clause.text.match(
      /\b20\d{2}-\d{2}-\d{2}\b|\b\d{1,2}-\d{2}\b|(?:周|星期)[一二三四五六日天](?:前|后)?|\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i,
    )?.[0]
  );
}

export function materialSourceUrl(item: CollectiveMaterialItem): string | undefined {
  const url = item.material.url;
  return url && /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:pull|issues)\/[1-9]\d*$/.test(url)
    ? url
    : undefined;
}
export function ProjectMaterialCard({
  item,
  works,
  canSort,
  busy,
  onDecide,
  onChoose,
  onOpenSource,
  onOpenWork,
}: {
  item: CollectiveMaterialItem;
  works: readonly CollectiveWorkProjection[];
  canSort: boolean;
  busy: boolean;
  onDecide(action: 'reference' | 'ignore', clauseId?: string): void;
  onChoose(clause: MaterialClause, action: 'create' | 'merge'): void;
  onOpenSource?(): void;
  onOpenWork?(workId: string): void;
}) {
  const t = useMaterialText(),
    en = useCollectiveLanguage() === 'en',
    url = materialSourceUrl(item);
  const date = (value: string) =>
    new Intl.DateTimeFormat(en ? 'en-US' : 'zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value));
  return (
    <article className="project-material-card" data-material-id={item.materialId}>
      <header>
        <span className="material-kind">
          {item.material.kind === 'meeting'
            ? en
              ? 'Meeting notes'
              : '会议纪要'
            : item.material.kind === 'pr'
              ? 'PR'
              : 'Issue'}
        </span>
        <h3>{item.material.title}</h3>
      </header>
      <p className="material-meta">
        {item.material.author ?? item.publication.actor.displayName} · #{item.publication.channelId}
        {item.material.occurredAt ? ` · ${date(item.material.occurredAt)}` : ''}
      </p>
      <div className="material-source-links">
        {url && (
          <a href={url} target="_blank" rel="noreferrer">
            {t('source')} ↗
          </a>
        )}
        {onOpenSource && (
          <button type="button" onClick={onOpenSource}>
            {t('channel')}
          </button>
        )}
      </div>
      {item.publicationIds.length > 1 && <p className="material-note">{t('same')}</p>}
      {item.currentness === 'revised' && (
        <details className="material-revised">
          <summary>
            {t('revised')} · {t('revisions')}
          </summary>
          <ol>
            {item.witnesses.map((witness, index) => (
              <li key={`${index}:${witness.digest}`}>
                {date(witness.readAt)} ·{' '}
                {en
                  ? index === 0
                    ? 'Read when shared'
                    : 'Read after update'
                  : index === 0
                    ? '首次分享时核对'
                    : '来源更新后核对'}
              </li>
            ))}
          </ol>
        </details>
      )}
      {item.disposition ? (
        <p className="material-destination">
          {t('handled')} · {t(item.disposition.action === 'reference' ? 'reference' : 'ignore')} ·{' '}
          {item.disposition.actor.displayName}
        </p>
      ) : (
        <>
          {item.material.kind === 'meeting' && <h4>{t('passages')}</h4>}
          {item.material.clauses.map((clause) => {
            const decision = item.decisions[clause.clauseId],
              work = works.find((work) => work.workId === decision?.workId);
            const guessed =
              clause.suggestedBy?.kind === 'agent' && works.find((work) => work.workId === clause.suggestedWorkId);
            const hint = materialDateHint(clause);
            return (
              <section className="material-clause" key={clause.clauseId}>
                <p>{clause.text}</p>
                {guessed && (
                  <small>
                    {guessed.title} · {t('guess')}（{clause.suggestedBy?.displayName}）
                  </small>
                )}
                {hint && (
                  <small>
                    {en ? `Mentions “${hint}” · ` : `提到「${hint}」· `}
                    {t('hint')}
                  </small>
                )}
                {decision ? (
                  <p className="material-destination">
                    {t('handled')} · {decision.actor.displayName} · {date(decision.at)}
                    {work && (
                      <button type="button" onClick={() => onOpenWork?.(work.workId)}>
                        {work.title} →
                      </button>
                    )}
                    {!work && decision.action === 'ignore' && ` · ${t('unused')}`}
                  </p>
                ) : canSort ? (
                  <div className="material-actions">
                    <button
                      type="button"
                      className={guessed ? undefined : 'primary'}
                      disabled={busy}
                      onClick={() => onChoose(clause, 'create')}
                    >
                      {t('create')}
                    </button>
                    <button
                      type="button"
                      className={guessed ? 'primary' : undefined}
                      disabled={busy}
                      onClick={() => onChoose(clause, 'merge')}
                    >
                      {guessed ? `${t('merge')} · ${guessed.title}` : t('merge')}
                    </button>
                    {item.material.kind === 'meeting' && (
                      <button type="button" disabled={busy} onClick={() => onDecide('ignore', clause.clauseId)}>
                        {t('unused')}
                      </button>
                    )}
                  </div>
                ) : null}
              </section>
            );
          })}
          {canSort ? (
            <footer className="material-actions">
              <button type="button" disabled={busy} onClick={() => onDecide('reference')}>
                {t('reference')}
              </button>
              <button type="button" disabled={busy} onClick={() => onDecide('ignore')}>
                {t('ignore')}
              </button>
            </footer>
          ) : (
            <p className="material-note">{t('wait')}</p>
          )}
        </>
      )}
    </article>
  );
}
