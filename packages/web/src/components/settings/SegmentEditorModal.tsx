'use client';

/**
 * F237 Checkpoint C + F257 Console 判据⑤ — Segment overlay editor modal.
 * Portal-based modal matching SkillPreviewModal pattern.
 * Edits template-backed segments via .local overlay files.
 *
 * Criterion ⑤ separation:
 *   - Variable definitions come from the canonical hook manifest registry.
 *   - The editable area contains ONLY source text with {{VAR}} placeholders.
 *   - Runtime-expanded values cannot be saved back into the override.
 */

import type { SegmentEnablementMatrix } from '@cat-cafe/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { apiFetch } from '@/utils/api-client';
import { SettingsPrimaryButton, SettingsSecondaryButton, SettingsText } from './primitives';

/** Extract {{NAME}} placeholders from a source string. */
function extractPlaceholders(content: string): string[] {
  const vars: string[] = [];
  for (const m of content.matchAll(/\{\{(\w+)\}\}/g)) {
    if (!vars.includes(m[1])) vars.push(m[1]);
  }
  return vars;
}

/**
 * Compare placeholders in the current draft against the original source.
 * Returns the names of placeholders that are missing from the draft.
 */
function missingPlaceholders(draft: string, reference: string): string[] {
  const required = extractPlaceholders(reference);
  if (required.length === 0) return [];
  const present = new Set(extractPlaceholders(draft));
  return required.filter((name) => !present.has(name));
}

interface SegmentEditorModalProps {
  segmentId: string;
  segmentName: string;
  allowLocalOverride: boolean;
  onClose: () => void;
}

interface VariableDef {
  name: string;
  description?: string;
  placeholder?: string;
}

interface ContentResponse {
  segmentId: string;
  allowLocalOverride: boolean;
  hasOverride: boolean;
  hasBackup: boolean;
  content: string;
  baseContent: string;
  templateRef: string;
  vars: string[];
  variableDefs: VariableDef[];
  /** F257 Console 判据⑥: unified enablement matrix for CTA states and blocked reasons. */
  enablementMatrix: SegmentEnablementMatrix;
}

function useSegmentEditorState(segmentId: string, allowLocalOverride: boolean, onClose: () => void) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [data, setData] = useState<ContentResponse | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const reqRef = useRef(0);

  const fetchContent = useCallback(async () => {
    const id = ++reqRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/prompt-injection/segment/${segmentId}/content`);
      if (id !== reqRef.current) return;
      if (!res.ok) {
        setError('加载失败');
        return;
      }
      const payload = (await res.json()) as ContentResponse;
      // Keep raw source intact so the operator edits exactly what runtime loads.
      setData(payload);
      setDraft(payload.content);
    } catch {
      if (id === reqRef.current) setError('网络错误');
    } finally {
      if (id === reqRef.current) setLoading(false);
    }
  }, [segmentId]);

  useEffect(() => {
    fetchContent();
    return () => {
      reqRef.current++;
    };
  }, [fetchContent]);

  // Escape key to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    setSaveMsg(null);
    try {
      const res = await apiFetch(`/api/prompt-injection/segment/${segmentId}/override`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: draft }),
      });
      const payload = (await res.json()) as { saved?: boolean; error?: string };
      if (!res.ok) {
        setError(payload.error ?? '保存失败');
        return;
      }
      setSaveMsg('已保存，下次会话生效');
      await fetchContent();
    } catch {
      setError('保存请求失败');
    } finally {
      setSaving(false);
    }
  }, [segmentId, draft, fetchContent]);

  const handleReset = useCallback(async () => {
    setError(null);
    setSaveMsg(null);
    try {
      const res = await apiFetch(`/api/prompt-injection/segment/${segmentId}/override`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        setError('重置失败');
        return;
      }
      setSaveMsg('已重置为默认');
      await fetchContent();
    } catch {
      setError('重置请求失败');
    }
  }, [segmentId, fetchContent]);

  const handleRestoreBackup = useCallback(async () => {
    setError(null);
    setSaveMsg(null);
    try {
      const res = await apiFetch(`/api/prompt-injection/segment/${segmentId}/restore-backup`, {
        method: 'POST',
      });
      if (!res.ok) {
        const payload = (await res.json()) as { error?: string };
        setError(payload.error ?? '恢复失败');
        return;
      }
      setSaveMsg('已恢复上一版');
      await fetchContent();
    } catch {
      setError('恢复请求失败');
    }
  }, [segmentId, fetchContent]);

  // F257 Console 判据⑥: the enablement matrix is the single source of truth.
  // If the matrix is missing, fail-visible: editor is readonly and the reason
  // is surfaced so the user does not silently fall back to a stale contract.
  const editAction = data?.enablementMatrix?.localOverlay?.actions.edit ?? {
    allowed: false,
    reason: '启用状态矩阵不可用',
    reasonCode: 'matrix-unavailable',
  };
  const isReadonly = !editAction.allowed;
  const isDirty = data ? draft !== data.content : false;
  // Validate against immutable base template, not the current effective overlay.
  const missing = useMemo(() => (data ? missingPlaceholders(draft, data.baseContent) : []), [draft, data]);
  const canSave = !isReadonly && isDirty && missing.length === 0 && !saving;

  return {
    loading,
    error,
    saveMsg,
    data,
    draft,
    setDraft,
    isReadonly,
    isDirty,
    missing,
    canSave,
    saving,
    handleSave,
    handleReset,
    handleRestoreBackup,
  };
}

function VariableDefsPanel({ defs, vars }: { defs: VariableDef[]; vars: string[] }) {
  if (defs.length > 0) {
    return (
      <div className="rounded-2xl bg-[var(--console-panel-bg)] p-4">
        <SettingsText as="h3" variant="xs" tone="muted" className="mb-2 font-semibold">
          变量说明
        </SettingsText>
        <div className="grid gap-2">
          {defs.map((v) => (
            <div key={v.name} className="grid grid-cols-[minmax(150px,auto)_1fr] items-start gap-3 text-xs">
              <code className="rounded bg-[var(--console-card-bg)] px-1.5 py-0.5 font-mono text-cafe-secondary">
                {`{{${v.name}}}`}
              </code>
              <div>
                <SettingsText as="p" variant="xs" tone="secondary">
                  {v.description || '说明待补充'}
                </SettingsText>
                {v.placeholder && (
                  <SettingsText as="p" variant="xs" tone="muted">
                    示例：{v.placeholder}
                  </SettingsText>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (vars.length > 0) {
    return (
      <div className="rounded-2xl bg-[var(--console-panel-bg)] p-4">
        <SettingsText as="h3" variant="xs" tone="muted" className="mb-1 font-semibold">
          变量
        </SettingsText>
        <SettingsText as="p" variant="xs" tone="secondary">
          {vars.map((v) => `{{${v}}}`).join('、')}
        </SettingsText>
        <SettingsText as="p" variant="xs" tone="muted" className="mt-1 italic">
          说明待补充
        </SettingsText>
      </div>
    );
  }

  return null;
}

function EditorActions({
  enablementMatrix,
  canSave,
  saving,
  onSave,
  onReset,
  onRestoreBackup,
}: {
  enablementMatrix: SegmentEnablementMatrix | undefined;
  canSave: boolean;
  saving: boolean;
  onSave: () => void;
  onReset: () => void;
  onRestoreBackup: () => void;
}) {
  const edit = enablementMatrix?.localOverlay?.actions.edit;
  const restoreBackup = enablementMatrix?.localOverlay?.actions.restoreBackup;
  const reset = enablementMatrix?.localOverlay?.actions.reset;
  return (
    <div className="flex flex-col items-end gap-2 pt-1">
      {!edit || (!edit.allowed && edit.reason) ? (
        <SettingsText as="p" variant="xs" tone="muted">
          {edit?.reason ?? '启用状态矩阵不可用'}
        </SettingsText>
      ) : null}
      <div className="flex items-center gap-2">
        {restoreBackup?.allowed && (
          <SettingsSecondaryButton onClick={onRestoreBackup}>恢复上一版</SettingsSecondaryButton>
        )}
        {reset?.allowed && <SettingsSecondaryButton onClick={onReset}>恢复默认</SettingsSecondaryButton>}
        <SettingsPrimaryButton onClick={onSave} disabled={!canSave} data-testid="segment-editor-save">
          {saving ? '保存中...' : '保存'}
        </SettingsPrimaryButton>
      </div>
    </div>
  );
}

export function SegmentEditorModal({ segmentId, segmentName, allowLocalOverride, onClose }: SegmentEditorModalProps) {
  const {
    loading,
    error,
    saveMsg,
    data,
    draft,
    setDraft,
    isReadonly,
    missing,
    canSave,
    saving,
    handleSave,
    handleReset,
    handleRestoreBackup,
  } = useSegmentEditorState(segmentId, allowLocalOverride, onClose);

  const handleDialogKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    },
    [onClose],
  );

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[var(--console-overlay-backdrop)] p-4 backdrop-blur-sm">
      <button
        type="button"
        tabIndex={-1}
        aria-label="关闭"
        className="absolute inset-0 h-full w-full appearance-none border-0 bg-transparent p-0"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="segment-editor-title"
        tabIndex={-1}
        className="relative flex max-h-[calc(100vh-32px)] w-full max-w-[760px] flex-col overflow-hidden rounded-2xl bg-[var(--console-card-bg)] p-[26px] shadow-[0_20px_48px_rgba(43,33,26,0.14)]"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleDialogKeyDown}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center gap-[14px]">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[var(--console-active-bg)] text-lg font-bold text-[var(--console-modal-title)]">
            {isReadonly ? '📖' : '✎'}
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="segment-editor-title" className="flex items-center gap-2 text-xl font-bold text-cafe">
              <span className="font-mono text-base text-cafe-muted">{segmentId}</span>
              {segmentName}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-base text-cafe-muted transition hover:bg-[var(--console-modal-close-bg)] hover:text-[var(--console-modal-close-fg)]"
          >
            ✕
          </button>
        </div>

        {/* Body — scrollable */}
        <div className="mt-4 min-h-0 flex-1 space-y-4 overflow-y-auto">
          {loading && (
            <SettingsText as="p" variant="xs" tone="muted">
              加载中...
            </SettingsText>
          )}

          {error && (
            <SettingsText as="p" variant="xs" tone="red">
              {error}
            </SettingsText>
          )}

          {saveMsg && (
            <SettingsText as="p" variant="xs" tone="emerald">
              {saveMsg}
            </SettingsText>
          )}

          {data && (
            <>
              {/* Variable definitions — canonical manifest metadata */}
              <VariableDefsPanel defs={data.variableDefs} vars={data.vars} />

              {/* Source editor — must retain placeholders */}
              <div className="rounded-2xl bg-[var(--console-panel-bg)] p-4">
                <div className="mb-2 flex items-center justify-between">
                  <SettingsText as="h3" variant="xs" tone="muted" className="font-semibold">
                    可编辑源文本
                  </SettingsText>
                  {missing.length > 0 && (
                    <SettingsText as="p" variant="xs" tone="red">
                      缺少占位符：{missing.map((n) => `{{${n}}}`).join(', ')}
                    </SettingsText>
                  )}
                </div>
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  disabled={isReadonly}
                  rows={12}
                  className="w-full rounded-md border-0 bg-transparent p-0 font-mono text-xs leading-relaxed focus:outline-none focus:ring-0"
                  style={{
                    color: 'var(--cafe-text-secondary)',
                    resize: 'vertical',
                    minHeight: '160px',
                  }}
                />
              </div>

              {/* Actions */}
              <EditorActions
                enablementMatrix={data.enablementMatrix}
                canSave={canSave}
                saving={saving}
                onSave={handleSave}
                onReset={handleReset}
                onRestoreBackup={handleRestoreBackup}
              />
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
