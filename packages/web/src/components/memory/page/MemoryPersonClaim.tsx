import type { MaterializableClaimPayload } from '@cat-cafe/shared';
import { useState } from 'react';
import { MemoryPersonSource } from './MemoryPersonSource';
import { type PersonClaim, type PersonOwnerCommand, personClaimText } from './people-types';
import { formatMemoryDate } from './use-memory-read';

function editableText(payload: PersonClaim['payload']) {
  if (payload.kind === 'redacted') return '';
  if (payload.kind === 'user_assessment') return payload.statement;
  return typeof payload.value === 'string' ? payload.value : JSON.stringify(payload.value);
}
function correctedPayload(
  payload: PersonClaim['payload'],
  draft: string,
  predicate: string,
  stance: 'endorsed' | 'rejected' | 'uncertain',
): MaterializableClaimPayload | null {
  if (payload.kind === 'redacted') return null;
  if (payload.kind === 'user_assessment') return draft.trim() ? { ...payload, statement: draft.trim(), stance } : null;
  if (!predicate.trim()) return null;
  return {
    ...payload,
    predicate: predicate.trim(),
    value: draft === editableText(payload) ? payload.value : draft.trim(),
  };
}
export function MemoryPersonClaim({
  personId,
  claim,
  busy,
  submit,
}: {
  personId: string;
  claim: PersonClaim;
  busy: boolean;
  submit: (input: PersonOwnerCommand) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [sourceState, setSourceState] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [retiring, setRetiring] = useState(false);
  const payload = claim.payload;
  const [draft, setDraft] = useState(editableText(payload));
  const [predicate, setPredicate] = useState(payload.kind === 'reported_fact' ? payload.predicate : '');
  const [stance, setStance] = useState(payload.kind === 'user_assessment' ? payload.stance : 'uncertain');
  const [error, setError] = useState('');
  function save() {
    const next = correctedPayload(payload, draft, predicate, stance);
    if (!next) {
      setError('请填写完整内容。');
      return;
    }
    setError('');
    submit({ action: 'correct_claim', claimId: claim.claimId, expectedRevision: claim.revision, payload: next });
  }
  return (
    <article className="space-y-3 rounded-lg bg-cafe-surface-sunken p-4">
      <p className="whitespace-pre-wrap break-words text-sm">{personClaimText(payload)}</p>
      <p className="text-xs text-cafe-muted">
        {payload.kind === 'reported_fact'
          ? '你说的事实'
          : payload.kind === 'user_assessment'
            ? `你的看法 · ${{ endorsed: '认同', rejected: '不认同', uncertain: '拿不准' }[payload.stance]}`
            : '已忘掉'}{' '}
        · {claim.status === 'current' ? '当前判断' : '历史判断'} · {formatMemoryDate(claim.recordedAt)}
      </p>
      <MemoryPersonSource personId={personId} kind="claim" itemId={claim.claimId} onReadState={setSourceState} />
      {claim.status === 'current' && payload.kind !== 'redacted' && (
        <div className="flex gap-3 text-compact text-cafe-accent">
          <button type="button" disabled={busy || sourceState !== 'ready'} onClick={() => setEditing(!editing)}>
            编辑
          </button>
          <button type="button" disabled={busy} onClick={() => setRetiring(!retiring)}>
            不再成立
          </button>
        </div>
      )}
      {sourceState === 'unavailable' && (
        <p className="text-xs text-cafe-muted">来源读不到，暂时不能编辑。可以重读来源，或者不再使用、忘掉这条。</p>
      )}
      {editing && (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          {payload.kind === 'reported_fact' && (
            <label className="block text-compact">
              事实名称
              <input
                aria-label="事实名称"
                className="mt-1 w-full rounded-lg border border-cafe-subtle bg-[var(--console-card-bg)] p-2"
                value={predicate}
                onChange={(event) => setPredicate(event.target.value)}
                maxLength={160}
                required
              />
            </label>
          )}
          <label className="block text-compact">
            {payload.kind === 'reported_fact' ? '事实内容' : '判断内容'}
            <textarea
              aria-label="判断内容"
              className="mt-1 w-full rounded-lg border border-cafe-subtle bg-[var(--console-card-bg)] p-2"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              maxLength={payload.kind === 'user_assessment' ? 800 : 4000}
              required
            />
          </label>
          {payload.kind === 'user_assessment' && (
            <label className="block text-compact">
              你的态度
              <select
                aria-label="判断态度"
                value={stance}
                onChange={(event) => setStance(event.target.value as typeof stance)}
                className="ml-2 rounded-lg border border-cafe-subtle bg-[var(--console-card-bg)] p-2"
              >
                <option value="endorsed">认可</option>
                <option value="rejected">不认可</option>
                <option value="uncertain">还不确定</option>
              </select>
            </label>
          )}
          <p className="text-xs text-cafe-muted">改的是这条记忆，原对话里的消息不会改。</p>
          {error && (
            <p role="alert" className="text-compact">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={busy || sourceState !== 'ready'}
            className="text-compact text-cafe-accent underline"
          >
            保存
          </button>
        </form>
      )}
      {retiring && (
        <div className="space-y-2 text-compact">
          <p>标为不再成立，保留历史，不删除原始对话。</p>
          <button
            type="button"
            disabled={busy}
            onClick={() => submit({ action: 'retire_claim', claimId: claim.claimId, expectedRevision: claim.revision })}
            className="text-cafe-accent underline"
          >
            确认不再成立
          </button>
        </div>
      )}
    </article>
  );
}
