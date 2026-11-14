import type { MaterializableClaimPayload } from '@cat-cafe/shared';
import { useState } from 'react';
import { MemoryPersonClaimTechnicalDetails, MemoryPersonClaimText } from './MemoryPersonClaimText';
import { MemoryPersonMaintenanceConfirm } from './MemoryPersonMaintenance';
import { MemoryPersonSource } from './MemoryPersonSource';
import type { PersonClaim, PersonOwnerCommand } from './people-types';
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
  onRedacted,
}: {
  personId: string;
  claim: PersonClaim;
  busy: boolean;
  submit: (input: PersonOwnerCommand) => void;
  onRedacted?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [sourceState, setSourceState] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [retiring, setRetiring] = useState(false);
  const [redacting, setRedacting] = useState(false);
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
      <MemoryPersonClaimText claim={claim} />
      <p className="text-xs text-cafe-muted">
        {payload.kind === 'reported_fact'
          ? '你说的事实'
          : payload.kind === 'user_assessment'
            ? `你的看法 · ${{ endorsed: '认同', rejected: '不认同', uncertain: '拿不准' }[payload.stance]}`
            : '已忘掉'}{' '}
        · {claim.status === 'current' ? '当前判断' : '历史判断'} · {formatMemoryDate(claim.recordedAt)}
      </p>
      {payload.kind !== 'redacted' && (
        <MemoryPersonSource personId={personId} kind="claim" itemId={claim.claimId} onReadState={setSourceState} />
      )}
      <MemoryPersonClaimTechnicalDetails claim={claim} />
      {claim.status === 'current' && payload.kind !== 'redacted' && (
        <div className="flex flex-wrap gap-3 text-compact text-cafe-accent">
          <button
            type="button"
            disabled={busy || sourceState !== 'ready'}
            onClick={() => {
              setEditing(!editing);
              setRetiring(false);
              setRedacting(false);
            }}
          >
            编辑
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setRetiring(!retiring);
              setEditing(false);
              setRedacting(false);
            }}
          >
            不再成立
          </button>
        </div>
      )}
      {payload.kind !== 'redacted' && claim.status !== 'redacted' && (
        <MemoryPersonMaintenanceConfirm
          label="忘掉这条内容"
          disabled={busy}
          opened={redacting}
          onApplied={onRedacted}
          onToggle={() => {
            setRedacting(!redacting);
            setEditing(false);
            setRetiring(false);
          }}
          draft={{
            action: 'redact_item',
            personId,
            item: { kind: 'claim', id: claim.claimId },
            expectedRevision: claim.revision,
          }}
          description="擦除这条记忆的内容与来源关联，只留一条已忘掉记录，不能恢复。不会删除原始对话，也不会忘掉整个人。"
        />
      )}
      {sourceState === 'unavailable' && payload.kind !== 'redacted' && (
        <p className="text-xs text-cafe-muted">来源读不到，暂时不能编辑。仍可不再使用或忘掉这条。</p>
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
