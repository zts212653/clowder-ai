import type { CollectiveWorkProjection } from '@cat-cafe/shared';
import { useContext, useEffect, useState } from 'react';
import { useCollectiveLanguage } from './collective-copy.js';
import { formatWorkDate, formatWorkDateTime, workTimeLabels } from './project-time.js';
import { WorkTimeCommandContext } from './WorkTimeCommandContext.js';
import { type WorkTimeChangeHandler, WorkTimeEditor } from './WorkTimeEditor.js';

export function WorkTimePanel({
  work,
  currentHumanId,
  onChange,
  onOpenSource: explicitOpenSource,
  sourceHint,
  onClearSourceHint,
}: {
  readonly work: CollectiveWorkProjection;
  readonly currentHumanId: string;
  readonly onChange?: WorkTimeChangeHandler;
  readonly onOpenSource?: (eventId: string, channelId: string) => void;
  readonly sourceHint?: { text: string; eventId: string; request: number };
  readonly onClearSourceHint?: () => void;
}) {
  const context = useContext(WorkTimeCommandContext);
  const onOpenSource = explicitOpenSource ?? context.openSource;
  const language = useCollectiveLanguage(),
    en = language === 'en';
  const [editing, setEditing] = useState<'set' | 'suggest'>();
  const [pending, setPending] = useState(false),
    [error, setError] = useState('');
  const owner = work.accountableHumanId === currentHumanId;
  const executor = work.assignment ? work.assignment.humanId === currentHumanId : owner;
  const editable = work.lifecycle !== 'proposed' && Boolean(onChange);
  useEffect(() => {
    if (sourceHint && editable) setEditing(owner ? 'set' : 'suggest');
  }, [sourceHint, editable, owner]);
  const respond = async (suggestionId: string, decision: 'accept' | 'keep') => {
    if (!onChange) return;
    setPending(true);
    setError('');
    try {
      await onChange(work, { action: 'respond', suggestionId, decision });
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(false);
    }
  };
  return (
    <section className="work-time-panel" aria-label={en ? 'Task dates' : '任务时间'}>
      <header>
        <h4>{en ? 'Dates' : '时间'}</h4>
        <div>
          {editable && (
            <>
              {(owner || executor) && (
                <button type="button" onClick={() => setEditing('set')}>
                  {en ? 'Edit dates…' : '改日期…'}
                </button>
              )}
              {!owner && (
                <button type="button" onClick={() => setEditing('suggest')}>
                  {en ? 'Suggest a date…' : '建议日期…'}
                </button>
              )}
            </>
          )}
        </div>
      </header>
      {(work.timeSuggestions ?? [])
        .filter((suggestion) => suggestion.status === 'pending')
        .map((suggestion) => (
          <article className="work-time-suggestion" key={suggestion.suggestionId}>
            <strong>
              {suggestion.actor.displayName} · {workTimeLabels[suggestion.field][en ? 1 : 0]}{' '}
              {suggestion.time ? formatWorkDate(suggestion.time, language) : en ? 'clear date' : '清除日期'}
            </strong>
            <p>{suggestion.reason}</p>
            <small>{new Date(suggestion.at).toLocaleString(en ? 'en-US' : 'zh-CN')}</small>
            {suggestion.sourceEventId && onOpenSource && (
              <button
                type="button"
                onClick={() =>
                  onOpenSource(
                    suggestion.sourceEventId!,
                    suggestion.sourceLocation?.channelId ?? work.sourceLocation.channelId,
                  )
                }
              >
                {en ? 'Source' : '出处'}
              </button>
            )}
            {owner && onChange ? (
              <div>
                <button
                  type="button"
                  disabled={pending}
                  className="primary"
                  onClick={() => void respond(suggestion.suggestionId, 'accept')}
                >
                  {en ? 'Accept date' : '采用日期'}
                </button>
                <button type="button" disabled={pending} onClick={() => void respond(suggestion.suggestionId, 'keep')}>
                  {en ? 'Keep current date' : '保持原日期'}
                </button>
              </div>
            ) : (
              <p>{en ? 'Waiting for the task owner' : '等负责人决定'}</p>
            )}
          </article>
        ))}
      {editing && onChange && (
        <WorkTimeEditor
          sourceHint={sourceHint}
          key={`${work.workId}:${editing}`}
          work={work}
          currentHumanId={currentHumanId}
          suggest={editing === 'suggest'}
          onChange={onChange}
          onClose={() => {
            setEditing(undefined);
            onClearSourceHint?.();
          }}
        />
      )}
      {error && <p role="alert">{error}</p>}
      <dl>
        {(['businessDeadline', 'estimatedCompletion', 'reviewBy', 'plannedStart', 'actualStart'] as const).map(
          (field) => {
            const fact = work.time?.[field];
            return (
              <div key={field}>
                <dt>{workTimeLabels[field][en ? 1 : 0]}</dt>
                <dd>
                  {fact ? (
                    <>
                      <strong>{formatWorkDateTime(fact, language)}</strong>
                      <small>
                        {fact.actor.displayName} · {new Date(fact.at).toLocaleDateString(en ? 'en-US' : 'zh-CN')} ·{' '}
                        {en ? 'in' : '按'} {fact.timeZone}
                        {field === 'estimatedCompletion' ? (en ? ' · estimate' : ' · 只是估计') : ''}
                      </small>
                      {fact.sourceEventId && onOpenSource && (
                        <button
                          type="button"
                          onClick={() =>
                            onOpenSource(
                              fact.sourceEventId!,
                              fact.sourceLocation?.channelId ?? work.sourceLocation.channelId,
                            )
                          }
                        >
                          {en ? 'Source' : '出处'}
                        </button>
                      )}
                    </>
                  ) : (
                    <span>{en ? 'Not set' : '未定'}</span>
                  )}
                </dd>
              </div>
            );
          },
        )}
      </dl>
      <p className="work-time-note">
        {en
          ? 'Estimates and dates mentioned in materials never become deadlines. The task owner confirms deadlines and review dates.'
          : '猫的估计、材料里提到的日子，都不会自己变成截止。截止和请你审阅只有负责人能定。'}
      </p>
    </section>
  );
}
