import type { CandidateInteractionDraft } from '@cat-cafe/shared';
import { useState } from 'react';
import { MemoryPersonSource } from './MemoryPersonSource';
import type { PersonInteraction, PersonOwnerCommand } from './people-types';
import { formatMemoryDate } from './use-memory-read';

export function MemoryPersonInteraction({
  personId,
  item,
  busy,
  submit,
}: {
  personId: string;
  item: PersonInteraction;
  busy: boolean;
  submit: (command: PersonOwnerCommand) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [headline, setHeadline] = useState(item.headline);
  const [topic, setTopic] = useState(item.importanceOrTopic ?? '');
  const [notes, setNotes] = useState(item.uncertaintyNotes?.join('\n') ?? '');
  const [error, setError] = useState('');
  function save() {
    const uncertaintyNotes = notes
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (
      !headline.trim() ||
      !topic.trim() ||
      uncertaintyNotes.length > 4 ||
      uncertaintyNotes.some((note) => note.length > 240)
    ) {
      setError('请填完内容；不确定项最多四项，每项不超过240字。');
      return;
    }
    setError('');
    const payload: CandidateInteractionDraft['payload'] = {
      eventKind: item.eventKind as CandidateInteractionDraft['payload']['eventKind'],
      headline: headline.trim(),
      importanceOrTopic: topic.trim(),
      uncertaintyNotes,
      ...(item.occurredAt ? { occurredAt: item.occurredAt } : {}),
      ...(item.duration ? { duration: item.duration } : {}),
    };
    submit({ action: 'amend_event', eventId: item.eventId, expectedRevision: item.revision, payload });
  }
  return (
    <article className="space-y-3 rounded-lg bg-cafe-surface-sunken p-4">
      <p className="whitespace-pre-wrap break-words text-sm">{item.headline}</p>
      <p className="text-xs text-cafe-muted">
        记录于 {formatMemoryDate(item.recordedAt)} · {item.status === 'active' ? '当前记录' : '历史记录'}
      </p>
      {item.importanceOrTopic && <p className="text-compact">{item.importanceOrTopic}</p>}
      {item.uncertaintyNotes?.map((note) => (
        <p key={note} className="text-xs text-cafe-muted">
          还不确定：{note}
        </p>
      ))}
      <MemoryPersonSource personId={personId} kind="event" itemId={item.eventId} />
      {item.status === 'active' && (
        <button
          type="button"
          disabled={busy}
          onClick={() => setEditing(!editing)}
          className="text-compact text-cafe-accent underline"
        >
          修改经历
        </button>
      )}
      {editing && (
        <form
          className="space-y-3 text-compact"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <label className="block">
            经历内容
            <textarea
              aria-label="经历内容"
              className="mt-1 w-full rounded-lg border border-cafe-subtle bg-[var(--console-card-bg)] p-2"
              required
              maxLength={240}
              value={headline}
              onChange={(event) => setHeadline(event.target.value)}
            />
          </label>
          <label className="block">
            话题或重要之处
            <textarea
              aria-label="经历话题"
              className="mt-1 w-full rounded-lg border border-cafe-subtle bg-[var(--console-card-bg)] p-2"
              required
              maxLength={400}
              value={topic}
              onChange={(event) => setTopic(event.target.value)}
            />
          </label>
          <label className="block">
            尚不确定的内容（每行一项）
            <textarea
              aria-label="经历不确定之处"
              className="mt-1 w-full rounded-lg border border-cafe-subtle bg-[var(--console-card-bg)] p-2"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </label>
          <p className="text-xs text-cafe-muted">原记录的日期和时长保持原样，不推测缺失日期。</p>
          {error && <p role="alert">{error}</p>}
          <button type="submit" disabled={busy} className="text-cafe-accent underline">
            保存经历
          </button>
        </form>
      )}
    </article>
  );
}
