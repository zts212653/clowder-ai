'use client';

import type {
  RoutingPreferenceCreateCommandV1,
  RoutingPreferenceRevisionV1,
  RoutingPreferenceSupersedeCommandV1,
} from '@cat-cafe/shared';
import { useMemo, useRef, useState } from 'react';
import { RoutingPreferenceRuleList } from './RoutingPreferenceRuleList';
import {
  createRoutingPreference,
  RoutingContextCommandError,
  retireRoutingPreference,
  supersedeRoutingPreference,
} from './routing-context-client';
import { buildRenewPreferenceCommand, newRoutingCommandId, preferenceHeads } from './routing-context-commands';
import { DAY_MS, routingSubjects, subjectLabel } from './routing-preference-rules';

/**
 * The write landed durably; only the follow-up read failed. Saying nothing would let a
 * stale list pass for the post-write state, and saying "写入失败" would be a lie.
 */
const STALE_AFTER_WRITE = '已保存。但最新状态读取失败，下面显示的可能还不是这次改动后的结果。';

export function RoutingPreferenceControls({
  revisions,
  onChanged,
}: {
  revisions: readonly RoutingPreferenceRevisionV1[];
  onChanged: () => Promise<boolean>;
}) {
  const heads = useMemo(() => preferenceHeads(revisions), [revisions]);
  const [editing, setEditing] = useState<RoutingPreferenceRevisionV1 | null>(null);
  /** F293 AC-UX3: existing rules are read first; the editor only opens on request. */
  const [formOpen, setFormOpen] = useState(false);
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
    setFormOpen(true);
    setEditing(head);
    setIntent(head.appliesWhen.intent ?? 'review');
    setPreferCsv(head.prefer.map(subjectLabel).join(', '));
    setOverCsv(head.over.map(subjectLabel).join(', '));
    setRationale(head.rationale);
    setEvidenceRef(head.evidenceRefs[0] ?? 'decision:F293');
    draftCommandId.current = null;
  }

  function resetDraft() {
    setFormOpen(false);
    setEditing(null);
    setPreferCsv('');
    setOverCsv('');
    setRationale('');
    draftCommandId.current = null;
  }

  async function handleMutationError(cause: unknown, fallback: string, resetEditor = false) {
    if (cause instanceof RoutingContextCommandError && cause.status === 409) {
      // Someone else moved this preference. Whether we now hold the latest version
      // depends on the re-read actually succeeding — claiming it either way is a lie.
      const reread = await onChanged();
      if (resetEditor) resetDraft();
      setError(
        reread
          ? '偏好已在别处更新；已刷新最新版本，请重新确认后提交'
          : '偏好已在别处更新，但最新版本读取失败；下面显示的不是最新状态，请先重新读取再提交',
      );
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
      const reread = await onChanged();
      resetDraft();
      if (!reread) setError(STALE_AFTER_WRITE);
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
      if (!(await onChanged())) setError(STALE_AFTER_WRITE);
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
      if (!(await onChanged())) setError(STALE_AFTER_WRITE);
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
      <RoutingPreferenceRuleList
        heads={heads}
        saving={saving}
        onEdit={edit}
        onRenew={(head) => void renew(head)}
        onRetire={(head) => void retire(head)}
      />
      {error && (
        <p className="mt-3 text-xs text-conn-red-text" data-testid="routing-preference-error">
          {error}
        </p>
      )}
      {!formOpen && (
        <button
          type="button"
          onClick={() => setFormOpen(true)}
          className="mt-3 h-9 rounded-lg border border-cafe-subtle px-3 text-xs font-semibold text-cafe-secondary hover:bg-cafe-surface"
          data-testid="routing-preference-open-form"
        >
          + 新增偏好
        </button>
      )}
      {formOpen && (
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
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={saving}
              className="h-9 rounded-lg bg-cafe-accent px-3 text-xs font-semibold text-[var(--cafe-surface)] disabled:opacity-50"
            >
              {saving ? '正在保存…' : editing ? '保存新版本' : '新增偏好'}
            </button>
            <button
              type="button"
              onClick={resetDraft}
              className="h-9 rounded-lg px-3 text-xs font-semibold text-cafe-secondary hover:bg-cafe-surface-sunken"
            >
              {editing ? '取消编辑' : '取消'}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
