import { tasteMemoryOwnerActionSchema } from '@cat-cafe/shared';
import { useState } from 'react';
import { MemoryForgetControl, MemoryOwnerFeedback } from './MemoryOwnerControls';
import { currentTakeawayCandidate } from './taste-format';
import type { TasteMemory } from './taste-types';
import { useMemoryOwnerAction } from './use-memory-owner-action';

export function MemoryTasteActions({ entry, reload }: { entry: TasteMemory; reload: () => void }) {
  const candidate = currentTakeawayCandidate(entry);
  const [candidateText, setCandidateText] = useState(candidate?.takeaway ?? '');
  const [takeaway, setTakeaway] = useState(entry.takeaway ?? '');
  const [scene, setScene] = useState(entry.scene);
  const [quotes, setQuotes] = useState(entry.quotes);
  const [editing, setEditing] = useState(false);
  const [retiring, setRetiring] = useState(false);
  const [error, setError] = useState('');
  const action = useMemoryOwnerAction(`/api/memory/taste/${encodeURIComponent(entry.id)}/actions`, entry.id, reload);
  const active = entry.status === 'active';
  function correct() {
    const parsed = tasteMemoryOwnerActionSchema.safeParse({
      action: 'correct',
      requestId: crypto.randomUUID(),
      expectedRevision: entry.revision,
      patch: { takeaway: takeaway.trim() || null, scene: scene.trim(), quotes },
    });
    if (!parsed.success || parsed.data.action !== 'correct') {
      setError('请检查内容：概括最多500字，情景与原话也需要完整。');
      return;
    }
    setError('');
    action.submit({ action: 'correct', expectedRevision: entry.revision, patch: parsed.data.patch });
  }
  if (!entry.status)
    return (
      <>
        <p className="mt-2 text-compact text-cafe-muted">原品味照常生效，概括候选还没接进来。</p>
        <div className="mt-4 flex gap-3 text-compact">
          {['确认这句', '修改', '忘掉'].map((label) => (
            <button type="button" key={label} disabled className="opacity-50">
              {label}
            </button>
          ))}
        </div>
      </>
    );
  return (
    <section className="mt-4 space-y-4" aria-label="品味修改与概括确认">
      <MemoryOwnerFeedback action={action} reread={reload} />
      {candidate && active ? (
        <div className="space-y-3 rounded-lg bg-cafe-surface-sunken p-4">
          <p className="text-xs text-cafe-muted">猫整理的一句话 · 假设 · 待你确认</p>
          <label className="block text-compact">
            可以先改这句
            <textarea
              aria-label="概括候选"
              required
              maxLength={500}
              value={candidateText}
              onChange={(event) => setCandidateText(event.target.value)}
              className="mt-2 w-full rounded-lg border border-cafe-subtle bg-[var(--console-card-bg)] p-3"
            />
          </label>
          <p className="text-xs text-cafe-muted">确认前，这句不会替代当前品味。</p>
          <button
            type="button"
            disabled={action.blocked || !candidateText.trim()}
            onClick={() =>
              action.submit({
                action: 'confirm_takeaway',
                expectedRevision: entry.revision,
                candidateRevision: candidate.candidateRevision,
                takeaway: candidateText.trim(),
              })
            }
            className="text-compact text-cafe-accent underline"
          >
            确认这句
          </button>
        </div>
      ) : (
        <p className="text-compact text-cafe-muted">
          {entry.takeawayCandidate ? '概括候选已过时，请重读。' : '还没有待确认的概括候选。'}当前品味
          {active ? '照常生效' : '已不再使用'}。
        </p>
      )}
      {active && (
        <>
          <div className="flex gap-3 text-compact text-cafe-accent">
            <button
              type="button"
              disabled={action.blocked}
              onClick={() => {
                setTakeaway(entry.takeaway ?? '');
                setEditing(!editing);
              }}
            >
              修改
            </button>
            <button type="button" disabled={action.blocked} onClick={() => setRetiring(!retiring)}>
              不再使用
            </button>
          </div>
          {editing && (
            <form
              className="space-y-3 text-compact"
              onSubmit={(event) => {
                event.preventDefault();
                correct();
              }}
            >
              <label className="block">
                猫整理的一句话（假设）
                <textarea
                  aria-label="品味概括"
                  maxLength={500}
                  value={takeaway}
                  onChange={(event) => setTakeaway(event.target.value)}
                  className="mt-1 w-full rounded-lg border border-cafe-subtle bg-cafe-surface-sunken p-3"
                />
              </label>
              <label className="block">
                当时的情景
                <textarea
                  aria-label="品味情景"
                  required
                  maxLength={8000}
                  value={scene}
                  onChange={(event) => setScene(event.target.value)}
                  className="mt-1 w-full rounded-lg border border-cafe-subtle bg-cafe-surface-sunken p-3"
                />
              </label>
              {quotes.map((quote, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: these fixed quote slots are edited in place, never reordered
                <label key={`quote-${index}`} className="block">
                  原话 {index + 1}
                  <textarea
                    aria-label={`品味原话 ${index + 1}`}
                    required
                    maxLength={2000}
                    value={quote}
                    onChange={(event) =>
                      setQuotes((previous) =>
                        previous.map((value, position) => (position === index ? event.target.value : value)),
                      )
                    }
                    className="mt-1 w-full rounded-lg border border-cafe-subtle bg-cafe-surface-sunken p-3"
                  />
                </label>
              ))}
              <p className="text-xs text-cafe-muted">修改这条记忆的概括、引用与情景，原始对话不变。</p>
              {error && <p role="alert">{error}</p>}
              <button type="submit" disabled={action.blocked} className="text-cafe-accent underline">
                保存品味
              </button>
            </form>
          )}
          {retiring && (
            <div className="space-y-2 text-compact">
              <p>停止用于新的召回，保留历史，不删除原始对话。</p>
              <button
                type="button"
                disabled={action.blocked}
                onClick={() => action.submit({ action: 'retire', expectedRevision: entry.revision })}
                className="text-cafe-accent underline"
              >
                确认不再使用
              </button>
            </div>
          )}
        </>
      )}
      <MemoryForgetControl revision={entry.revision} noun="品味" action={action} retainedAudit />
    </section>
  );
}
