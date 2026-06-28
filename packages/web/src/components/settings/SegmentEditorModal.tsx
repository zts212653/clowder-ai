'use client';

/**
 * F237 Checkpoint C — Segment overlay editor modal.
 * Portal-based modal matching SkillPreviewModal pattern.
 * Edits template-backed segments via .local overlay files.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { apiFetch } from '@/utils/api-client';
import { SettingsPrimaryButton, SettingsSecondaryButton, SettingsText } from './primitives';

/** Strip HTML comment lines from template content for display */
function stripDisplayComments(content: string): string {
  return content
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('<!--'))
    .join('\n')
    .trim();
}

interface SegmentEditorModalProps {
  segmentId: string;
  segmentName: string;
  allowLocalOverride: boolean;
  onClose: () => void;
}

interface ContentResponse {
  segmentId: string;
  allowLocalOverride: boolean;
  hasOverride: boolean;
  hasBackup: boolean;
  content: string;
  baseContent: string;
  vars: string[];
}

export function SegmentEditorModal({ segmentId, segmentName, allowLocalOverride, onClose }: SegmentEditorModalProps) {
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
      const cleaned = stripDisplayComments(payload.content);
      setData({ ...payload, content: cleaned });
      setDraft(cleaned);
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

  const handleBackdrop = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

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

  const isReadonly = !allowLocalOverride;
  const isDirty = data ? draft !== data.content : false;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-[var(--console-overlay-backdrop)] p-4 backdrop-blur-sm"
      onClick={handleBackdrop}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="segment-editor-title"
        className="relative flex max-h-[calc(100vh-32px)] w-full max-w-[680px] flex-col overflow-hidden rounded-2xl bg-[var(--console-card-bg)] p-[26px] shadow-[0_20px_48px_rgba(43,33,26,0.14)]"
        onClick={(e) => e.stopPropagation()}
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
            {data?.vars && data.vars.length > 0 && (
              <SettingsText as="p" variant="xs" tone="muted" className="mt-1">
                变量：{data.vars.map((v) => `{{${v}}}`).join('、')}
              </SettingsText>
            )}
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
              {/* Editor */}
              <div className="rounded-2xl bg-[var(--console-panel-bg)] p-4">
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  disabled={isReadonly}
                  rows={16}
                  className="w-full rounded-md border-0 bg-transparent p-0 font-mono text-xs leading-relaxed focus:outline-none focus:ring-0"
                  style={{
                    color: 'var(--cafe-text-secondary)',
                    resize: 'vertical',
                    minHeight: '200px',
                  }}
                />
              </div>

              {/* Actions */}
              {!isReadonly && (
                <div className="flex items-center justify-end gap-2 pt-1">
                  {data.hasBackup && (
                    <SettingsSecondaryButton onClick={handleRestoreBackup}>恢复上一版</SettingsSecondaryButton>
                  )}
                  {data.hasOverride && (
                    <SettingsSecondaryButton onClick={handleReset}>恢复默认</SettingsSecondaryButton>
                  )}
                  <SettingsPrimaryButton onClick={handleSave} disabled={!isDirty || saving}>
                    {saving ? '保存中...' : '保存'}
                  </SettingsPrimaryButton>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
