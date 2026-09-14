'use client';

import { useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { SettingsPrimaryButton, SettingsSecondaryButton, SettingsText } from './primitives';
import { useVersionedSegmentEditor, type VariableDef } from './useVersionedSegmentEditor';

interface SegmentEditorModalProps {
  segmentId: string;
  segmentName: string;
  onClose: () => void;
}

export function SegmentEditorModal({ segmentId, segmentName, onClose }: SegmentEditorModalProps) {
  const editor = useVersionedSegmentEditor(segmentId);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (editor.confirming) editor.setConfirming(false);
      else onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [editor.confirming, editor.setConfirming, onClose]);

  const handleDialogKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        if (editor.confirming) editor.setConfirming(false);
        else onClose();
      }
    },
    [editor.confirming, editor.setConfirming, onClose],
  );

  const handleConfirmCreate = useCallback(async () => {
    if (await editor.applyNewVersion()) onClose();
  }, [editor.applyNewVersion, onClose]);

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[var(--console-overlay-backdrop)] p-4 backdrop-blur-sm">
      <button type="button" tabIndex={-1} aria-label="关闭" className="absolute inset-0" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="segment-editor-title"
        data-testid="segment-editor-dialog"
        tabIndex={-1}
        className="relative flex max-h-[calc(100vh-32px)] w-full max-w-[760px] flex-col overflow-hidden rounded-2xl bg-[var(--console-card-bg)] p-[26px] shadow-[0_20px_48px_rgba(43,33,26,0.14)]"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleDialogKeyDown}
      >
        <div className="flex shrink-0 items-center gap-[14px]">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[var(--console-active-bg)] text-lg font-bold text-[var(--console-modal-title)]">
            ✎
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="segment-editor-title" className="flex items-center gap-2 text-xl font-bold text-cafe">
              <span className="font-mono text-base text-cafe-muted">{segmentId}</span>
              {segmentName}
            </h2>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭" className="console-icon-button">
            ✕
          </button>
        </div>

        <div className="mt-4 min-h-0 flex-1 space-y-4 overflow-y-auto">
          {editor.loading && <SettingsText tone="muted">加载中…</SettingsText>}
          {editor.error && <SettingsText tone="red">{editor.error}</SettingsText>}

          {editor.snapshot && editor.selectedVersion !== null && (
            <>
              <div className="rounded-2xl bg-[var(--console-panel-bg)] p-4">
                <label className="flex items-center gap-3 text-xs text-cafe-muted" htmlFor="segment-editor-version">
                  编辑版本
                  <select
                    id="segment-editor-version"
                    value={editor.selectedVersion}
                    disabled={editor.loading || editor.saving}
                    onChange={(event) => void editor.selectVersion(Number(event.target.value))}
                    className="rounded-xl border border-[var(--console-border)] bg-[var(--console-card-bg)] px-3 py-2 text-xs text-cafe-secondary"
                  >
                    {editor.snapshot.lifeline.chain.map((epoch) => (
                      <option key={epoch.version} value={epoch.version}>
                        v{epoch.version}
                        {epoch.version === editor.snapshot?.lifeline.activeVersion ? '（当前版本）' : ''}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <VariableDefsPanel defs={editor.snapshot.content.variableDefs} vars={editor.snapshot.content.vars} />

              <div className="rounded-2xl bg-[var(--console-panel-bg)] p-4">
                <div className="mb-2 flex items-center justify-between">
                  <SettingsText as="h3" variant="xs" tone="muted" className="font-semibold">
                    可编辑源文本
                  </SettingsText>
                  {editor.missing.length > 0 && (
                    <SettingsText tone="red">
                      缺少占位符：{editor.missing.map((name) => `{{${name}}}`).join('、')}
                    </SettingsText>
                  )}
                </div>
                <textarea
                  value={editor.draft}
                  onChange={(event) => editor.setDraft(event.target.value)}
                  disabled={!editor.tracing || editor.saving}
                  rows={12}
                  className="min-h-[160px] w-full resize-y border-0 bg-transparent p-0 font-mono text-xs leading-relaxed text-cafe-secondary focus:outline-none focus:ring-0"
                />
              </div>

              {!editor.tracing && <SettingsText tone="muted">当前正在评估，完成后可编辑并产生新版本。</SettingsText>}
              {editor.tracing && editor.createPermission && !editor.createPermission.allowed && (
                <SettingsText tone="muted">{editor.createPermission.reason}</SettingsText>
              )}

              <div className="flex justify-end">
                <SettingsPrimaryButton
                  data-testid="segment-editor-save"
                  disabled={!editor.canCreate || editor.saving}
                  onClick={() => editor.setConfirming(true)}
                >
                  产生并应用新版本
                </SettingsPrimaryButton>
              </div>

              {editor.confirming && (
                <ConfirmCreate
                  activeVersion={editor.snapshot.lifeline.activeVersion}
                  baseVersion={editor.selectedVersion}
                  targetVersion={editor.previewVersion ?? editor.snapshot.lifeline.activeVersion + 1}
                  saving={editor.saving}
                  onCancel={() => editor.setConfirming(false)}
                  onConfirm={() => void handleConfirmCreate()}
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ConfirmCreate({
  activeVersion,
  baseVersion,
  targetVersion,
  saving,
  onCancel,
  onConfirm,
}: {
  activeVersion: number;
  baseVersion: number;
  targetVersion: number;
  saving: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return createPortal(
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-[var(--console-overlay-backdrop)] p-4 backdrop-blur-sm">
      <button type="button" tabIndex={-1} aria-label="取消产生新版本" className="absolute inset-0" onClick={onCancel} />
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="segment-version-confirm-title"
        data-testid="segment-version-confirm-dialog"
        className="relative w-full max-w-[520px] rounded-2xl bg-[var(--console-card-bg)] p-6 shadow-[0_20px_48px_rgba(43,33,26,0.18)]"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onCancel();
          }
        }}
      >
        <SettingsText
          id="segment-version-confirm-title"
          as="h2"
          variant="base"
          tone="default"
          className="font-semibold"
        >
          产生并应用新版本
        </SettingsText>
        <SettingsText tone="secondary" className="mt-3">
          当前版本 v{activeVersion} → v{targetVersion}（基于 v{baseVersion}）
        </SettingsText>
        <SettingsText tone="muted" className="mt-1">
          产生并应用新版本后，当前周期将停止。
        </SettingsText>
        <div className="mt-5 flex justify-end gap-2">
          <SettingsSecondaryButton disabled={saving} onClick={onCancel}>
            取消
          </SettingsSecondaryButton>
          <SettingsPrimaryButton disabled={saving} onClick={onConfirm}>
            {saving ? '处理中…' : '确认产生并应用'}
          </SettingsPrimaryButton>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function VariableDefsPanel({ defs, vars }: { defs: VariableDef[]; vars: string[] }) {
  if (defs.length === 0 && vars.length === 0) return null;
  const definitions: VariableDef[] = defs.length > 0 ? defs : vars.map((name) => ({ name }));
  return (
    <div className="rounded-2xl bg-[var(--console-panel-bg)] p-4">
      <SettingsText as="h3" variant="xs" tone="muted" className="mb-2 font-semibold">
        变量说明
      </SettingsText>
      <div className="grid gap-2">
        {definitions.map((definition) => (
          <div key={definition.name} className="grid grid-cols-[minmax(150px,auto)_1fr] gap-3 text-xs">
            <code className="rounded bg-[var(--console-card-bg)] px-1.5 py-0.5 font-mono text-cafe-secondary">
              {`{{${definition.name}}}`}
            </code>
            <div>
              <SettingsText tone="secondary">{definition.description || '说明待补充'}</SettingsText>
              {definition.placeholder && <SettingsText tone="muted">示例：{definition.placeholder}</SettingsText>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
