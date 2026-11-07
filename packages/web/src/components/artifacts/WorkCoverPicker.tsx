'use client';
import type { ThreadArtifactDTO, WorkCoverPick, WorkCoverView } from '@cat-cafe/shared';
import { type KeyboardEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useShellCopy } from '@/components/shell/shell-copy';
import { useThreadArtifacts } from '@/hooks/useThreadArtifacts';
import { useChatStore } from '@/stores/chatStore';
import { API_URL } from '@/utils/api-client';
import { resolveAssetUrl } from './artifact-view';
import { WorkGalleryCard } from './WorkGalleryCard';
import { workCoverCopy } from './work-cover.shell-copy';
import {
  coverRatioLabel,
  coverShape,
  readWorkCover,
  readWorkCoverCandidates,
  saveWorkCover,
  uploadWorkCover,
  type WorkCoverCandidate,
  WorkCoverRequestError,
  type WorkCoverSaved,
} from './work-cover-client';
import './work-cover-picker.css';

type Tab = 'work' | 'thread' | 'upload';
type Choice = {
  key: string;
  name: string;
  previewUrl: string;
  source: WorkCoverCandidate['source'];
  pick: WorkCoverPick;
  sha256?: string;
};
const CHAT_PICTURE = /^\/uploads\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.(png|jpe?g|webp)$/i;

function threadChoices(threadId: string, artifacts: ThreadArtifactDTO[]): Choice[] {
  return artifacts.flatMap((artifact) =>
    artifact.type === 'image' &&
    artifact.url &&
    CHAT_PICTURE.test(artifact.url) &&
    artifact.publicationItem &&
    artifact.sourceMessageId
      ? [
          {
            key: `thread:${artifact.sourceMessageId}:${artifact.url}`,
            name: artifact.name,
            previewUrl: artifact.url,
            source: 'thread-image' as const,
            pick: {
              kind: 'thread-image' as const,
              threadId,
              messageId: artifact.sourceMessageId,
              messageRevision: String(artifact.createdAt),
              item: artifact.publicationItem,
              expectedUrl: artifact.url,
            },
          },
        ]
      : [],
  );
}

function Thumb({
  choice,
  selected,
  current,
  onSelect,
}: {
  choice: Choice;
  selected: boolean;
  current: boolean;
  onSelect: () => void;
}) {
  const t = useShellCopy(workCoverCopy);
  const [size, setSize] = useState<{ width: number; height: number }>();
  const shape = size && coverShape(size.width, size.height);
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      className="work-cover-thumb shell-focusable"
      onClick={onSelect}
    >
      {/* biome-ignore lint/performance/noImgElement: owner-checked candidate bytes. */}
      <img
        src={choice.previewUrl.startsWith('blob:') ? choice.previewUrl : resolveAssetUrl(choice.previewUrl, API_URL)}
        alt=""
        onLoad={(event) =>
          setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })
        }
      />
      {size && shape && (
        <span className="work-cover-thumb-ratio">
          {t[shape]} {coverRatioLabel(size.width, size.height)}
        </span>
      )}
      <span className="work-cover-thumb-name" title={choice.name}>
        {current ? t.current : choice.name}
      </span>
    </button>
  );
}

export function WorkCoverPicker({
  artifact,
  title,
  version,
  view,
  metadata,
  onClose,
  onSaved,
}: {
  artifact: ThreadArtifactDTO;
  title: string;
  version: number;
  view: WorkCoverView;
  metadata?: string;
  onClose: () => void;
  onSaved: (saved: WorkCoverSaved, previous: WorkCoverView) => void;
}) {
  const t = useShellCopy(workCoverCopy);
  const reference = artifact.work!;
  const threadId = useChatStore((state) => state.currentThreadId) ?? undefined;
  const thread = useThreadArtifacts(threadId);
  const [tab, setTab] = useState<Tab>('work');
  const [work, setWork] = useState<WorkCoverCandidate[] | null>(null);
  const [uploads, setUploads] = useState<Choice[]>([]);
  const [uploading, setUploading] = useState<'idle' | 'busy' | 'failed'>('idle');
  const [selected, setSelected] = useState<Choice>();
  const [latest, setLatest] = useState(view);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<WorkCoverRequestError['code']>();
  const intent = useRef<{ key: string; expected: number; operationId: string }>();
  const dialog = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const abort = new AbortController();
    readWorkCoverCandidates(reference, abort.signal).then(setWork, () => !abort.signal.aborted && setWork([]));
    return () => abort.abort();
  }, [reference.contentRef, reference.ownerRevision]);
  useEffect(() => {
    dialog.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus({ preventScroll: true });
  }, []);
  const workChoices = useMemo<Choice[]>(() => (work ?? []).map((item) => ({ ...item })), [work]);
  const chatChoices = useMemo(
    () => (threadId ? threadChoices(threadId, thread.artifacts) : []),
    [threadId, thread.artifacts],
  );
  const currentSha = latest.state === 'image' || latest.state === 'unavailable' ? latest.image?.sha256 : undefined;

  const save = async () => {
    if (!selected || saving) return;
    const expected = latest.coverRevision;
    if (!intent.current || intent.current.key !== selected.key || intent.current.expected !== expected)
      intent.current = { key: selected.key, expected, operationId: crypto.randomUUID() };
    setSaving(true);
    setError(undefined);
    try {
      const saved = await saveWorkCover({
        reference,
        operationId: intent.current.operationId,
        expectedCoverRevision: expected,
        choice: { mode: 'image', pick: selected.pick },
      });
      onSaved(saved, latest);
    } catch (cause) {
      const code = cause instanceof WorkCoverRequestError ? cause.code : 'other';
      setError(code);
      if (code === 'conflict') await readWorkCover(reference).then(setLatest, () => undefined);
    } finally {
      setSaving(false);
    }
  };

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const controls = [
      ...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') ?? []),
    ];
    const first = controls[0];
    const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  const grid = (choices: Choice[], empty: ReactNode) =>
    choices.length ? (
      <div className="work-cover-grid" role="radiogroup" aria-label={t.tabs[tab]}>
        {choices.map((choice) => (
          <Thumb
            key={choice.key}
            choice={choice}
            selected={selected?.key === choice.key}
            current={!!currentSha && choice.sha256 === currentSha}
            onSelect={() => setSelected(choice)}
          />
        ))}
      </div>
    ) : (
      <p className="work-cover-empty">{empty}</p>
    );

  return createPortal(
    <div className="work-cover-scrim" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <div
        ref={dialog}
        className="work-cover-dialog cafe-presentation"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKey}
      >
        <header className="work-cover-dialog-head">
          <h2 id={titleId}>{t.pickerTitle(title, version)}</h2>
          <p>{t.pickerHint}</p>
        </header>
        <div className="work-cover-dialog-body">
          <section className="work-cover-sources">
            <div className="work-cover-tabs" role="tablist">
              {(['work', 'thread', 'upload'] as const).map((key) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={tab === key}
                  className="shell-focusable"
                  onClick={() => setTab(key)}
                >
                  {t.tabs[key]}
                </button>
              ))}
            </div>
            {tab === 'work' &&
              (work === null ? <p className="work-cover-empty">{t.loading}</p> : grid(workChoices, t.noWorkPictures))}
            {tab === 'thread' &&
              (threadId ? (
                grid(chatChoices, thread.loading ? t.loading : t.noThreadPictures)
              ) : (
                <p className="work-cover-empty">{t.noThread}</p>
              ))}
            {tab === 'upload' && (
              <>
                <label className="work-cover-upload shell-focusable">
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    disabled={uploading === 'busy'}
                    onChange={async (event) => {
                      const file = event.currentTarget.files?.[0];
                      event.currentTarget.value = '';
                      if (!file) return;
                      setUploading('busy');
                      try {
                        const pick = await uploadWorkCover(file);
                        const choice: Choice = {
                          key: `upload:${pick.kind === 'upload' ? pick.uploadUrl : file.name}`,
                          name: file.name,
                          previewUrl: URL.createObjectURL(file),
                          source: 'upload',
                          pick,
                        };
                        setUploads((list) => [choice, ...list]);
                        setSelected(choice);
                        setUploading('idle');
                      } catch {
                        setUploading('failed');
                      }
                    }}
                  />
                  {uploading === 'busy' ? t.uploading : t.chooseFile}
                </label>
                <p className="work-cover-note">{uploading === 'failed' ? t.uploadFailed : t.uploadHint}</p>
                {uploads.length > 0 && grid(uploads, null)}
              </>
            )}
          </section>
          <aside className="work-cover-preview" aria-label={t.previewLabel}>
            <span className="work-cover-preview-label">{t.previewLabel}</span>
            <div className="work-cover-preview-card" aria-hidden="true" ref={(node) => node?.setAttribute('inert', '')}>
              <WorkGalleryCard
                artifact={artifact}
                metadata={metadata}
                onSelect={() => undefined}
                previewCover={
                  selected
                    ? selected.previewUrl.startsWith('blob:')
                      ? selected.previewUrl
                      : resolveAssetUrl(selected.previewUrl, API_URL)
                    : undefined
                }
                testId="work-cover-preview-card"
              />
            </div>
            <p className="work-cover-note">{t.previewHint}</p>
          </aside>
        </div>
        <footer className="work-cover-dialog-foot">
          {error && (
            <p className="work-cover-error" role="alert">
              {t.failed(t.reasons[error])}
            </p>
          )}
          <button type="button" className="work-cover-button shell-focusable" onClick={onClose}>
            {t.cancel}
          </button>
          <button
            type="button"
            className="work-cover-button work-cover-button-primary shell-focusable"
            disabled={!selected || saving}
            onClick={() => void save()}
          >
            {saving ? t.saving : error && error !== 'conflict' ? t.retry : t.confirm}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
