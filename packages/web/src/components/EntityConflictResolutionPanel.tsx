'use client';

import type {
  EntityConflictContext,
  EntityConflictRecord,
  EntityConflictResolutionAction,
  EntityConflictResolutionRequest,
} from '@cat-cafe/shared';
import { useMemo, useState } from 'react';

const ACTION_LABELS: Record<EntityConflictResolutionAction, string> = {
  'merge-aliases': '合并别名',
  replace: '明确替换',
  correct: '纠错归并',
  transfer: '转移归属',
  polysemy: '多义并存',
};

interface EntityConflictResolutionPanelProps {
  conflict: EntityConflictContext;
  error?: string;
  deciding: boolean;
  onResolve: (resolution: EntityConflictResolutionRequest) => void;
  onReject: () => void;
}

export function EntityConflictResolutionPanel({
  conflict,
  error,
  deciding,
  onResolve,
  onReject,
}: EntityConflictResolutionPanelProps) {
  const [replacements, setReplacements] = useState<Record<string, string>>({});

  const requiredReplacementsReady = useMemo(
    () => conflict.canonicalReplacementRequiredFor.every((entityId) => replacements[entityId]?.trim().length > 0),
    [conflict.canonicalReplacementRequiredFor, replacements],
  );

  const submit = (action: EntityConflictResolutionAction) => {
    const needsReplacements = action === 'correct' || action === 'transfer';
    const replacementCanonicalNames = Object.fromEntries(
      conflict.canonicalReplacementRequiredFor.map((entityId) => [entityId, replacements[entityId]?.trim() ?? '']),
    );
    onResolve({
      action,
      fingerprint: conflict.fingerprint,
      ...(needsReplacements && conflict.canonicalReplacementRequiredFor.length > 0
        ? { replacementCanonicalNames }
        : {}),
    });
  };

  const resolutionActions = conflict.allowedActions.filter(
    (action): action is EntityConflictResolutionAction => action !== 'reject',
  );

  return (
    <section
      className="space-y-3 rounded-lg border border-[var(--semantic-warning)] bg-[var(--semantic-warning-surface)] p-3"
      data-testid="entity-conflict-panel"
    >
      <div className="space-y-1">
        <p className="text-xs font-semibold text-[var(--semantic-warning)]">
          {conflict.reason === 'existing-entity-change'
            ? '这个实体已有登记，需要明确裁决'
            : '同名 surface 已归属其他实体'}
        </p>
        <p className="text-micro text-cafe-secondary">
          {conflict.reason === 'existing-entity-change'
            ? '比较当前登记与提案内容，然后选择合并别名或完整替换。'
            : '请选择纠错、转移或保留多义；系统不会自动猜测归属。'}
        </p>
      </div>

      {conflict.conflictingSurfaces.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 text-micro">
          <span className="text-cafe-secondary">冲突名称</span>
          {conflict.conflictingSurfaces.map((surface) => (
            <span key={surface} className="rounded bg-[var(--cafe-muted)] px-1.5 py-0.5 font-medium break-all">
              {surface}
            </span>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" data-testid="entity-conflict-comparison">
        <div className="min-w-0 space-y-2 rounded-md border border-[var(--cafe-border)] bg-[var(--cafe-surface)] p-2">
          <p className="text-micro font-semibold text-cafe-secondary">当前登记</p>
          {conflict.candidates.map((candidate) => (
            <EntitySnapshot key={candidate.entityId} record={candidate} />
          ))}
        </div>
        <div className="min-w-0 rounded-md border border-[var(--cafe-border)] bg-[var(--cafe-surface)] p-2">
          <p className="mb-2 text-micro font-semibold text-cafe-secondary">提案内容</p>
          <EntitySnapshot record={conflict.incoming} />
        </div>
      </div>

      {conflict.canonicalReplacementRequiredFor.length > 0 && (
        <div className="space-y-2" data-testid="canonical-replacements">
          <p className="text-micro text-cafe-secondary">被移走的是旧实体主名称，请为它填写新的主名称：</p>
          {conflict.canonicalReplacementRequiredFor.map((entityId) => (
            <label key={entityId} className="block space-y-1 text-micro">
              <span className="block break-all font-medium">{entityId}</span>
              <input
                type="text"
                value={replacements[entityId] ?? ''}
                onChange={(event) => setReplacements((current) => ({ ...current, [entityId]: event.target.value }))}
                placeholder="新的主名称"
                className="w-full rounded-md border border-[var(--cafe-border)] bg-[var(--cafe-surface)] px-2 py-1 text-xs outline-none focus:border-[var(--semantic-warning)]"
                data-testid={`canonical-replacement-${entityId}`}
              />
            </label>
          ))}
        </div>
      )}

      {error && (
        <p
          className="rounded-md border border-[var(--semantic-critical)] bg-[var(--semantic-critical-surface)] px-2 py-1.5 text-micro text-[var(--semantic-critical)]"
          role="alert"
        >
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2" data-testid="conflict-actions">
        {resolutionActions.map((action) => {
          const needsReplacement = action === 'correct' || action === 'transfer';
          return (
            <button
              key={action}
              type="button"
              onClick={() => submit(action)}
              disabled={deciding || (needsReplacement && !requiredReplacementsReady)}
              className="rounded-md border border-[var(--semantic-warning)] px-2.5 py-1 text-micro font-medium text-[var(--semantic-warning)] hover:bg-[var(--cafe-muted)] disabled:cursor-not-allowed disabled:opacity-40"
              data-testid={`resolve-${action}`}
            >
              {deciding ? '处理中…' : ACTION_LABELS[action]}
            </button>
          );
        })}
        <button
          type="button"
          onClick={onReject}
          disabled={deciding}
          className="rounded-md border border-[var(--cafe-border)] px-2.5 py-1 text-micro font-medium hover:bg-[var(--semantic-critical-surface)] disabled:opacity-40"
          data-testid="conflict-reject"
        >
          {deciding ? '处理中…' : '拒绝提案'}
        </button>
      </div>
    </section>
  );
}

function EntitySnapshot({ record }: { record: EntityConflictRecord }) {
  return (
    <div className="min-w-0 space-y-1 text-micro">
      <p className="break-words font-semibold">{record.canonicalName}</p>
      <p className="break-all text-cafe-secondary">{record.entityId}</p>
      <p className="text-cafe-secondary">
        {record.entityType} · {record.stance} · {record.visibilityScope}
      </p>
      {record.aliases.length > 0 && <p className="break-words">别名：{record.aliases.join('、')}</p>}
    </div>
  );
}
