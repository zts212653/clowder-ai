'use client';

import { useCallback, useState } from 'react';
import { useShellCopy } from '@/components/shell/shell-copy';
import { useWorkspace } from '@/hooks/useWorkspace';
import { useChatStore } from '@/stores/chatStore';
import { voiceMeetingCopy } from './voice-meeting.shell-copy';

/**
 * §1.14 语音 4 — the stopped session's saved artifacts: each row shows the real path the audio service returned and
 * offers 在文件里打开 only when that absolute path lives inside one of the listed workspace worktrees (gap-list #5:
 * audio-service paths and Files-tool paths are different spaces). Outside the workspace the row says so and offers
 * 复制路径 instead — no fake relative conversion, no permission bypass.
 */
export function SavedPathsV2({
  savedPath,
  savedRecordingPath,
  savedRecordingPaths,
  ownerThreadId,
  inputLabels,
}: {
  savedPath?: string | null;
  savedRecordingPath?: string | null;
  savedRecordingPaths?: Record<string, string>;
  /** The capture session that owns this stopped result (R4-P1a). The Files origin is only claimed when this
   * producer identity is known — it is never guessed from whichever chat thread happens to be selected. */
  ownerThreadId?: string | null;
  /** input id → display label, from the capture session's inputs (service data). */
  inputLabels?: Record<string, string>;
}) {
  const t = useShellCopy(voiceMeetingCopy);
  const { worktrees } = useWorkspace({ loadContent: false });
  const setWorkspaceOpenFile = useChatStore((s) => s.setWorkspaceOpenFile);

  const openTarget = useCallback(
    (absolutePath: string): { relativePath: string; worktreeId: string } | null => {
      for (const worktree of worktrees) {
        const root = (worktree.resolvedRoot ?? worktree.root)?.replace(/[\\/]+$/, '');
        if (root && absolutePath.startsWith(`${root}/`)) {
          return { relativePath: absolutePath.slice(root.length + 1), worktreeId: worktree.id };
        }
      }
      return null;
    },
    [worktrees],
  );

  const rows: Array<{ key: string; label: string; path: string }> = [];
  if (savedPath) rows.push({ key: 'transcript', label: t.capture.transcriptSaved, path: savedPath });
  if (savedRecordingPath) rows.push({ key: 'recording', label: t.capture.recordingSaved, path: savedRecordingPath });
  if (!savedRecordingPath) {
    for (const [inputId, path] of Object.entries(savedRecordingPaths ?? {})) {
      const inputLabel = inputLabels?.[inputId];
      rows.push({
        key: `recording-${inputId}`,
        label: inputLabel ? `${t.capture.recordingSaved} · ${inputLabel}` : t.capture.recordingSaved,
        path,
      });
    }
  }
  if (rows.length === 0) return null;

  return (
    <div className="space-y-1.5 border-t border-cafe-border px-3 py-2 text-xs" data-testid="saved-paths-v2">
      {rows.map((row) => (
        <SavedPathRow
          key={row.key}
          label={row.label}
          path={row.path}
          target={openTarget(row.path)}
          onOpen={(target) =>
            // C 3480: the meeting origin lets the Files surface offer ‹ 会议伴随 and restores this same thread's
            // stopped result on return (panel state itself is restored by the producer-mirrored summary).
            // The origin thread is the capture's actual owner (R4-P1a), never the currently selected chat.
            setWorkspaceOpenFile(
              target.relativePath,
              null,
              target.worktreeId,
              undefined,
              ownerThreadId ? { kind: 'meeting-transcript', threadId: ownerThreadId } : undefined,
            )
          }
        />
      ))}
    </div>
  );
}

function SavedPathRow({
  label,
  path,
  target,
  onOpen,
}: {
  label: string;
  path: string;
  target: { relativePath: string; worktreeId: string } | null;
  onOpen: (target: { relativePath: string; worktreeId: string }) => void;
}) {
  const t = useShellCopy(voiceMeetingCopy);
  const [copied, setCopied] = useState(false);

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(path);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = path;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="flex items-center gap-2">
      <span className="shrink-0 font-medium text-cafe-text-primary">{label}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-micro text-cafe-text-secondary" title={path}>
        {path}
      </span>
      {target ? (
        <button
          type="button"
          onClick={() => onOpen(target)}
          className="shrink-0 rounded-lg border border-cafe-border px-2.5 py-1 text-micro text-cafe-text-primary transition-colors hover:bg-cafe-surface-secondary"
          data-testid="saved-path-open"
        >
          {t.capture.openInFiles}
        </button>
      ) : (
        <span
          className="shrink-0 rounded-full bg-cafe-surface-secondary px-2 py-0.5 text-micro text-cafe-text-muted"
          title={t.capture.outsideWorkspace}
          data-testid="saved-path-outside"
        >
          {t.capture.outsideWorkspaceTag}
        </span>
      )}
      <button
        type="button"
        onClick={() => void copyPath()}
        aria-label={t.capture.copyPath}
        title={t.capture.copyPath}
        className="shrink-0 rounded-lg border border-cafe-border px-2 py-1 text-micro text-cafe-text-primary transition-colors hover:bg-cafe-surface-secondary"
        data-testid="saved-path-copy"
      >
        {copied ? t.capture.copied : t.capture.copyPath}
      </button>
    </div>
  );
}
