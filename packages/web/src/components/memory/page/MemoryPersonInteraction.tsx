import type { CandidateInteractionDraft } from '@cat-cafe/shared';
import { useState } from 'react';
import { MemoryPersonMaintenanceConfirm } from './MemoryPersonMaintenance';
import { MemoryPersonSource } from './MemoryPersonSource';
import type { PersonInteraction, PersonOwnerCommand } from './people-types';
import { formatMemoryDate } from './use-memory-read';

export function MemoryPersonInteraction({
  personId,
  item,
  busy,
  submit,
  onRedacted,
}: {
  personId: string;
  item: PersonInteraction;
  busy: boolean;
  submit: (command: PersonOwnerCommand) => void;
  onRedacted?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [redacting, setRedacting] = useState(false);
  const [sourceState, setSourceState] = useState<'loading' | 'ready' | 'unavailable'>('loading');
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
      <p className="whitespace-pre-wrap break-words text-sm">
        {item.status === 'redacted' ? '这条内容已遗忘' : item.headline}
      </p>
      <p className="text-xs text-cafe-muted">
        {{ conversation: '对话', meeting: '见面', message: '消息', milestone: '重要时刻', other: '其他' }[
          item.eventKind
        ] || '类型没有记录下来'}{' '}
        · 记录于 {formatMemoryDate(item.recordedAt)} ·{' '}
        {item.status === 'redacted' ? '已忘掉 · 历史记录' : item.status === 'active' ? '当前记录' : '历史记录'}
      </p>
      {item.status !== 'redacted' && item.importanceOrTopic && <p className="text-compact">{item.importanceOrTopic}</p>}
      {item.status !== 'redacted' &&
        item.uncertaintyNotes?.map((note) => (
          <p key={note} className="text-xs text-cafe-muted">
            还不确定：{note}
          </p>
        ))}
      {item.status !== 'redacted' && (
        <MemoryPersonSource personId={personId} kind="event" itemId={item.eventId} onReadState={setSourceState} />
      )}
      {item.status === 'active' && (
        <button
          type="button"
          disabled={busy || sourceState !== 'ready'}
          onClick={() => {
            setEditing(!editing);
            setRedacting(false);
          }}
          className="text-compact text-cafe-accent underline"
        >
          编辑
        </button>
      )}
      {item.status !== 'redacted' && (
        <MemoryPersonMaintenanceConfirm
          label="忘掉这条内容"
          disabled={busy}
          opened={redacting}
          onApplied={onRedacted}
          onToggle={() => {
            setRedacting(!redacting);
            setEditing(false);
          }}
          draft={{
            action: 'redact_item',
            personId,
            item: { kind: 'event', id: item.eventId },
            expectedRevision: item.revision,
          }}
          description="擦除这条记忆的内容与来源关联，只留一条已忘掉记录，不能恢复。不会删除原始对话，也不会忘掉整个人。"
        />
      )}
      {sourceState === 'unavailable' && item.status !== 'redacted' && (
        <p className="text-xs text-cafe-muted">来源读不到，暂时不能编辑。仍可忘掉这条。</p>
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
          <p className="text-xs text-cafe-muted">改的是这条记忆，原对话里的消息不会改。</p>
          {error && <p role="alert">{error}</p>}
          <button type="submit" disabled={busy || sourceState !== 'ready'} className="text-cafe-accent underline">
            保存
          </button>
        </form>
      )}
    </article>
  );
}
