'use client';
import {
  type VideoProjectScreening,
  videoProjectScreeningFrameSchema,
  videoProjectScreeningMappingSegmentSchema,
} from '@cat-cafe/shared';
import { useRef, useState } from 'react';
import { z } from 'zod';
import { useChatStore } from '@/stores/chatStore';
import type { ProjectSnapshot } from './api';
import { useScreeningCopy } from './screening-ui/screening.shell-copy';
import {
  confirmScreeningRegistration,
  createScreeningRegistration,
  type ScreeningRegistrationCommand,
} from './screening-ui/screening-registration';

/** Records existing output; rendering remains the external production tool's job. */
export function RegisterScreening({ project, onRegistered }: { project: ProjectSnapshot; onRegistered: () => void }) {
  const t = useScreeningCopy();
  const worktree = useChatStore((state) => state.workspaceWorktreeId);
  const [path, setPath] = useState(''),
    [title, setTitle] = useState('成片');
  const [mapping, setMapping] = useState<VideoProjectScreening['mapping'] | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const command = useRef<ScreeningRegistrationCommand | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      command.current ??= await createScreeningRegistration({ project, worktreeId: worktree, path, title, mapping });
      await confirmScreeningRegistration(project.contentRef, command.current);
      command.current = null;
      onRegistered();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '登记失败，可用同一次登记重试。');
    } finally {
      setBusy(false);
    }
  };
  return (
    <details
      className="rounded-xl border border-cafe-subtle bg-cafe-surface p-4"
      open={!project.document.screenings?.length}
    >
      <summary className="cursor-pointer text-sm font-semibold">{t.registerExisting}</summary>
      <p className="mt-2 text-xs text-cafe-muted">{t.registrationHint}</p>
      <div className="mt-3 flex flex-wrap gap-3">
        <label className="min-w-0 flex-1 text-xs">
          {t.filmTitle}
          <input
            className="mt-1 block w-full rounded border border-cafe-subtle bg-cafe-surface px-2 py-1.5 text-sm"
            value={title}
            disabled={busy || command.current !== null}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label className="min-w-0 flex-[2] text-xs">
          {t.filmPath}
          <input
            className="mt-1 block w-full rounded border border-cafe-subtle bg-cafe-surface px-2 py-1.5 text-sm"
            placeholder={t.filmPathHint}
            value={path}
            disabled={busy || command.current !== null}
            onChange={(event) => setPath(event.target.value)}
          />
        </label>
      </div>
      <label className="mt-3 block text-xs">
        {t.mappingFile}
        <input
          type="file"
          accept="application/json,.json"
          disabled={busy || command.current !== null}
          className="mt-1 block text-xs"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            if (file.size > 16 * 1024 * 1024) {
              setError('时间对应文件过大。');
              return;
            }
            void file
              .text()
              .then(
                (text) => {
                  setMapping(
                    z
                      .object({
                        segments: z.array(videoProjectScreeningMappingSegmentSchema),
                        frame: videoProjectScreeningFrameSchema,
                      })
                      .strict()
                      .parse(JSON.parse(text)),
                  );
                  setError(null);
                },
                () => setError('时间对应文件无法读取。'),
              )
              .catch(() => setError('时间对应文件格式不正确。'));
          }}
        />
      </label>
      {error && (
        <p className="mt-2 text-xs text-cafe-secondary" role="alert">
          {error}
        </p>
      )}
      <button
        type="button"
        disabled={busy || !path.trim() || !title.trim()}
        onClick={() => void submit()}
        className="mt-3 rounded-lg bg-cafe-accent px-3 py-2 text-sm text-white"
      >
        {busy ? t.registering : command.current ? t.retryRegistration : t.register}
      </button>
    </details>
  );
}
