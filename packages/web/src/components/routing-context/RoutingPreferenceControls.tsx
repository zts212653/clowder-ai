'use client';

import type {
  RoutingPreferenceCreateCommandV1,
  RoutingPreferenceRevisionV1,
  RoutingPreferenceSupersedeCommandV1,
  RoutingSubjectRefV1,
} from '@cat-cafe/shared';
import { useMemo, useRef, useState } from 'react';
import {
  createRoutingPreference,
  RoutingContextCommandError,
  retireRoutingPreference,
  supersedeRoutingPreference,
} from './routing-context-client';
import { buildRenewPreferenceCommand, newRoutingCommandId, preferenceHeads } from './routing-context-commands';

const DAY_MS = 86_400_000;

function routingSubjects(csv: string): RoutingSubjectRefV1[] {
  return [
    ...new Set(
      csv
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ].map((value) => {
    if (value.startsWith('provider:'))
      return { type: 'provider' as const, providerId: value.slice('provider:'.length) };
    if (value.startsWith('pool:')) return { type: 'quota_pool' as const, poolId: value.slice('pool:'.length) };
    if (value.startsWith('quota_pool:')) {
      return { type: 'quota_pool' as const, poolId: value.slice('quota_pool:'.length) };
    }
    return { type: 'cat' as const, catId: value };
  });
}

function subjectLabel(subject: RoutingSubjectRefV1): string {
  if (subject.type === 'cat') return subject.catId;
  if (subject.type === 'provider') return `provider:${subject.providerId}`;
  return `pool:${subject.poolId}`;
}

function lifecycleLabel(head: RoutingPreferenceRevisionV1, now: number): string {
  if (head.lifecycle === 'retired') return '已退休';
  if (head.reviewAfter !== undefined && head.reviewAfter <= now) return '待复核';
  return '有效';
}

export function RoutingPreferenceControls({
  revisions,
  onChanged,
}: {
  revisions: readonly RoutingPreferenceRevisionV1[];
  onChanged: () => Promise<void>;
}) {
  const heads = useMemo(() => preferenceHeads(revisions), [revisions]);
  const [editing, setEditing] = useState<RoutingPreferenceRevisionV1 | null>(null);
  const [intent, setIntent] = useState<'review' | 'architecture'>('review');
  const [preferCsv, setPreferCsv] = useState('');
  const [overCsv, setOverCsv] = useState('');
  const [rationale, setRationale] = useState('');
  const [evidenceRef, setEvidenceRef] = useState('decision:F293');
  const [reviewDays, setReviewDays] = useState(30);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draftCommandId = useRef<string | null>(null);
  const actionCommandIds = useRef(new Map<string, string>());

  function edit(head: RoutingPreferenceRevisionV1) {
    if (head.lifecycle === 'retired') return;
    setEditing(head);
    setIntent(head.appliesWhen.intent ?? 'review');
    setPreferCsv(head.prefer.map(subjectLabel).join(', '));
    setOverCsv(head.over.map(subjectLabel).join(', '));
    setRationale(head.rationale);
    setEvidenceRef(head.evidenceRefs[0] ?? 'decision:F293');
    draftCommandId.current = null;
  }

  function resetDraft() {
    setEditing(null);
    setPreferCsv('');
    setOverCsv('');
    setRationale('');
    draftCommandId.current = null;
  }

  async function handleMutationError(cause: unknown, fallback: string, resetEditor = false) {
    if (cause instanceof RoutingContextCommandError && cause.status === 409) {
      await onChanged();
      if (resetEditor) resetDraft();
      setError('偏好已在别处更新；已刷新最新版本，请重新确认后提交');
      return;
    }
    setError(cause instanceof Error ? cause.message : fallback);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const prefer = routingSubjects(preferCsv);
    const over = routingSubjects(overCsv);
    const overlap = new Set(prefer.map(subjectLabel));
    if (over.some((subject) => overlap.has(subjectLabel(subject)))) {
      setError('同一成员不能同时出现在优先与对照两侧');
      return;
    }
    setSaving(true);
    try {
      const commandId =
        draftCommandId.current ?? newRoutingCommandId(editing ? 'preference-supersede' : 'preference-create');
      draftCommandId.current = commandId;
      const rule = {
        appliesWhen: editing ? { ...editing.appliesWhen, intent } : { intent },
        prefer,
        over,
        rationale: rationale.trim(),
        evidenceRefs: [evidenceRef.trim()],
        reviewAfter: Date.now() + reviewDays * DAY_MS,
      };
      if (editing) {
        const command: RoutingPreferenceSupersedeCommandV1 = {
          v: 1,
          commandId,
          baseRevisionId: editing.revisionId,
          baseVersion: editing.version,
          ...rule,
        };
        await supersedeRoutingPreference(editing.preferenceId, command);
      } else {
        const command: RoutingPreferenceCreateCommandV1 = {
          v: 1,
          commandId,
          ...rule,
        };
        await createRoutingPreference(command);
      }
      await onChanged();
      resetDraft();
    } catch (cause) {
      await handleMutationError(cause, '协作偏好写入失败', true);
    } finally {
      setSaving(false);
    }
  }

  async function renew(head: RoutingPreferenceRevisionV1) {
    if (head.lifecycle === 'retired') return;
    setSaving(true);
    setError(null);
    try {
      const intentKey = `renew:${head.revisionId}`;
      const commandId = actionCommandIds.current.get(intentKey) ?? newRoutingCommandId('preference-renew');
      actionCommandIds.current.set(intentKey, commandId);
      await supersedeRoutingPreference(
        head.preferenceId,
        buildRenewPreferenceCommand(head, commandId, Date.now() + 30 * DAY_MS),
        'renew',
      );
      await onChanged();
      actionCommandIds.current.delete(intentKey);
    } catch (cause) {
      await handleMutationError(cause, '协作偏好续期失败');
    } finally {
      setSaving(false);
    }
  }

  async function retire(head: RoutingPreferenceRevisionV1) {
    if (head.lifecycle === 'retired') return;
    setSaving(true);
    setError(null);
    try {
      const intentKey = `retire:${head.revisionId}`;
      const commandId = actionCommandIds.current.get(intentKey) ?? newRoutingCommandId('preference-retire');
      actionCommandIds.current.set(intentKey, commandId);
      await retireRoutingPreference(head.preferenceId, {
        v: 1,
        commandId,
        baseRevisionId: head.revisionId,
        baseVersion: head.version,
        retirementReason: 'Owner retired this routing preference from Team Workspace',
      });
      await onChanged();
      actionCommandIds.current.delete(intentKey);
    } catch (cause) {
      await handleMutationError(cause, '协作偏好退休失败');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section
      className="rounded-xl border border-cafe-subtle/75 bg-[var(--console-card-bg)] p-4"
      data-testid="routing-preference-controls"
    >
      <h4 className="text-xs font-semibold text-cafe-black">协作偏好</h4>
      <p className="mt-1 text-micro leading-4 text-cafe-muted">
        偏好只在成员仍可用时提供排序依据；不会覆盖不可用信号，也不会自动改派。
      </p>
      {heads.length > 0 && (
        <div className="mt-3 space-y-2">
          {heads.map((head) => (
            <div key={head.preferenceId} className="rounded-lg border border-cafe-subtle bg-cafe-surface/60 p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="text-xs font-semibold text-cafe-black">{head.rationale}</p>
                  <p className="mt-0.5 text-micro text-cafe-muted">
                    {head.prefer.map(subjectLabel).join(', ')} 优先于 {head.over.map(subjectLabel).join(', ')} · v
                    {head.version}
                  </p>
                </div>
                <span className="text-micro font-semibold text-cafe-secondary">{lifecycleLabel(head, Date.now())}</span>
              </div>
              {head.lifecycle === 'active' && (
                <div className="mt-2 flex gap-3">
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => edit(head)}
                    className="text-micro font-semibold text-cafe-accent hover:underline"
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void renew(head)}
                    className="text-micro font-semibold text-cafe-accent hover:underline"
                  >
                    续期 30 天
                  </button>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void retire(head)}
                    className="text-micro font-semibold text-cafe-secondary hover:underline"
                  >
                    退休
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <form onSubmit={submit} className="mt-4 grid gap-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="text-micro font-semibold text-cafe-secondary">
            适用意图
            <select
              value={intent}
              onChange={(event) => {
                draftCommandId.current = null;
                setIntent(event.target.value as typeof intent);
              }}
              className="mt-1 h-9 w-full rounded-lg border border-cafe-subtle bg-cafe-surface px-2 text-xs text-cafe-black"
            >
              <option value="review">Review</option>
              <option value="architecture">Architecture</option>
            </select>
          </label>
          <label className="text-micro font-semibold text-cafe-secondary">
            复核周期
            <select
              value={reviewDays}
              onChange={(event) => {
                draftCommandId.current = null;
                setReviewDays(Number(event.target.value));
              }}
              className="mt-1 h-9 w-full rounded-lg border border-cafe-subtle bg-cafe-surface px-2 text-xs text-cafe-black"
            >
              <option value={7}>7 天</option>
              <option value={30}>30 天</option>
              <option value={90}>90 天</option>
            </select>
          </label>
        </div>
        <label className="text-micro font-semibold text-cafe-secondary">
          优先对象（猫名、provider:ID 或 pool:ID，逗号分隔）
          <input
            name="preference-prefer"
            required
            value={preferCsv}
            onChange={(event) => {
              draftCommandId.current = null;
              setPreferCsv(event.target.value);
            }}
            className="mt-1 h-9 w-full rounded-lg border border-cafe-subtle bg-cafe-surface px-2 text-xs text-cafe-black"
          />
        </label>
        <label className="text-micro font-semibold text-cafe-secondary">
          对照对象（猫名、provider:ID 或 pool:ID，逗号分隔）
          <input
            name="preference-over"
            required
            value={overCsv}
            onChange={(event) => {
              draftCommandId.current = null;
              setOverCsv(event.target.value);
            }}
            className="mt-1 h-9 w-full rounded-lg border border-cafe-subtle bg-cafe-surface px-2 text-xs text-cafe-black"
          />
        </label>
        <label className="text-micro font-semibold text-cafe-secondary">
          理由
          <input
            name="preference-rationale"
            required
            value={rationale}
            onChange={(event) => {
              draftCommandId.current = null;
              setRationale(event.target.value);
            }}
            className="mt-1 h-9 w-full rounded-lg border border-cafe-subtle bg-cafe-surface px-2 text-xs text-cafe-black"
          />
        </label>
        <label className="text-micro font-semibold text-cafe-secondary">
          证据引用
          <input
            name="preference-evidence"
            required
            value={evidenceRef}
            onChange={(event) => {
              draftCommandId.current = null;
              setEvidenceRef(event.target.value);
            }}
            className="mt-1 h-9 w-full rounded-lg border border-cafe-subtle bg-cafe-surface px-2 text-xs text-cafe-black"
          />
        </label>
        {error && <p className="text-xs text-conn-red-text">{error}</p>}
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={saving}
            className="h-9 rounded-lg bg-cafe-accent px-3 text-xs font-semibold text-[var(--cafe-surface)] disabled:opacity-50"
          >
            {saving ? '正在保存…' : editing ? '保存新版本' : '新增偏好'}
          </button>
          {editing && (
            <button
              type="button"
              onClick={resetDraft}
              className="h-9 rounded-lg px-3 text-xs font-semibold text-cafe-secondary hover:bg-cafe-surface-sunken"
            >
              取消编辑
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
